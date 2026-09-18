import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ensurePrivateDir } from "../config.js";

export type TurnStatus = "reserved" | "generating" | "completed" | "stopped" | "error";

export interface TurnRecord {
  turnId: string;
  requestId: string;
  payloadHash: string;
  conversationId: string | null;
  baselineAssistantCount: number | null;
  status: TurnStatus;
  requestedModel: string | null;
  requestedEffort: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastErrorCode?: string;
}

interface PersistedTurnState {
  version: 1;
  turns: TurnRecord[];
}

export class TurnStoreError extends Error {
  constructor(
    public readonly code: "REQUEST_ID_CONFLICT" | "TURN_NOT_FOUND" | "STATE_CORRUPT",
    message: string
  ) {
    super(message);
    this.name = "TurnStoreError";
  }
}

export const MAX_TURN_RECORDS = 200;

function stateFile(stateDir: string): string {
  return path.join(ensurePrivateDir(path.join(stateDir, "turns")), "turns.json");
}

function readState(stateDir: string): PersistedTurnState {
  const file = stateFile(stateDir);
  if (!fs.existsSync(file)) return { version: 1, turns: [] };
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new TurnStoreError("STATE_CORRUPT", "Refusing symlinked turn-state file.");
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedTurnState>;
    if (raw.version !== 1 || !Array.isArray(raw.turns)) {
      throw new Error("invalid shape");
    }
    return { version: 1, turns: raw.turns as TurnRecord[] };
  } catch (error) {
    if (error instanceof TurnStoreError) throw error;
    throw new TurnStoreError("STATE_CORRUPT", "Turn-state file is unreadable or invalid.");
  }
}

function writeState(stateDir: string, state: PersistedTurnState): void {
  const file = stateFile(stateDir);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new TurnStoreError("STATE_CORRUPT", "Refusing symlinked turn-state file.");
  }
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

export function validateRequestId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(trimmed)) {
    throw new Error("request_id must be 8-128 characters using A-Z, a-z, 0-9, . _ : -");
  }
  return trimmed;
}

export function payloadHash(input: {
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prompt: input.prompt,
        conversationId: input.conversationId ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
      })
    )
    .digest("hex");
}

function newTurnId(): string {
  return "turn_" + randomBytes(12).toString("hex");
}

function pruneForInsert(state: PersistedTurnState): void {
  while (state.turns.length >= MAX_TURN_RECORDS) {
    const terminal = state.turns.findIndex(
      (item) => item.status === "completed" || item.status === "stopped" || item.status === "error"
    );
    if (terminal < 0) {
      throw new Error(
        "Turn-state capacity reached with only active turns. Finish or stop an existing turn before sending another."
      );
    }
    state.turns.splice(terminal, 1);
  }
}

export class TurnStore {
  constructor(private readonly stateDir: string) {}

  reserve(input: {
    requestId: string;
    payloadHash: string;
    conversationId?: string;
    model?: string;
    effort?: string;
  }): { record: TurnRecord; deduplicated: boolean } {
    const requestId = validateRequestId(input.requestId);
    const state = readState(this.stateDir);
    const existing = state.turns.find((item) => item.requestId === requestId);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new TurnStoreError(
          "REQUEST_ID_CONFLICT",
          "request_id was already used with different prompt/model/conversation inputs."
        );
      }
      return { record: existing, deduplicated: true };
    }

    pruneForInsert(state);
    const now = new Date().toISOString();
    const record: TurnRecord = {
      turnId: newTurnId(),
      requestId,
      payloadHash: input.payloadHash,
      conversationId: input.conversationId ?? null,
      baselineAssistantCount: null,
      status: "reserved",
      requestedModel: input.model ?? null,
      requestedEffort: input.effort ?? null,
      createdAt: now,
      updatedAt: now,
    };
    state.turns.push(record);
    writeState(this.stateDir, state);
    return { record, deduplicated: false };
  }

  get(turnId: string): TurnRecord {
    const state = readState(this.stateDir);
    const record = state.turns.find((item) => item.turnId === turnId);
    if (!record) throw new TurnStoreError("TURN_NOT_FOUND", "Unknown turn_id: " + turnId);
    return record;
  }

  update(
    turnId: string,
    patch: Partial<
      Pick<
        TurnRecord,
        | "conversationId"
        | "baselineAssistantCount"
        | "status"
        | "completedAt"
        | "lastErrorCode"
      >
    >
  ): TurnRecord {
    const state = readState(this.stateDir);
    const record = state.turns.find((item) => item.turnId === turnId);
    if (!record) throw new TurnStoreError("TURN_NOT_FOUND", "Unknown turn_id: " + turnId);

    Object.assign(record, patch);
    record.updatedAt = new Date().toISOString();
    writeState(this.stateDir, state);
    return record;
  }
}
