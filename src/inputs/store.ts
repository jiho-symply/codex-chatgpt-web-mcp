import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { ensurePrivateDir } from "../config.js";
import {
  decodeStrictBase64,
  scanSensitiveText,
  validateBinaryInput,
  validateInputFilename,
  validateTextMime,
  type InputKind,
} from "./policy.js";

export type InputAssetStatus = "staged" | "expired";

export interface InputAssetRecord {
  inputAssetId: string;
  kind: InputKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storageName: string;
  createdAt: string;
  expiresAt: string;
}

export interface InputAssetView {
  inputAssetId: string;
  kind: InputKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  status: InputAssetStatus;
}

export interface ResolvedInputAsset {
  record: InputAssetRecord;
  path: string;
}

interface InputState {
  version: 1;
  items: InputAssetRecord[];
}

export class InputStoreError extends Error {
  constructor(
    public readonly code:
      | "INPUT_NOT_FOUND"
      | "INPUT_EXPIRED"
      | "INPUT_STATE_CORRUPT"
      | "INPUT_TOO_LARGE"
      | "INPUT_TOTAL_TOO_LARGE"
      | "INPUT_TOO_MANY"
      | "INPUT_INTEGRITY_ERROR",
    message: string
  ) {
    super(message);
    this.name = "InputStoreError";
  }
}

const MAX_INPUT_RECORDS = 500;

function inputDir(stateDir: string): string {
  return ensurePrivateDir(path.join(stateDir, "input-staging"));
}

function filesDir(stateDir: string): string {
  return ensurePrivateDir(path.join(inputDir(stateDir), "files"));
}

function stateFile(stateDir: string): string {
  return path.join(inputDir(stateDir), "inputs.json");
}

function readState(stateDir: string): InputState {
  const file = stateFile(stateDir);
  if (!fs.existsSync(file)) return { version: 1, items: [] };
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new InputStoreError("INPUT_STATE_CORRUPT", "Refusing symlinked input-state file.");
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InputState>;
    if (raw.version !== 1 || !Array.isArray(raw.items)) throw new Error("invalid shape");
    return { version: 1, items: raw.items as InputAssetRecord[] };
  } catch (error) {
    if (error instanceof InputStoreError) throw error;
    throw new InputStoreError("INPUT_STATE_CORRUPT", "Input-state file is unreadable or invalid.");
  }
}

function writeState(stateDir: string, state: InputState): void {
  const file = stateFile(stateDir);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new InputStoreError("INPUT_STATE_CORRUPT", "Refusing symlinked input-state file.");
  }
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function newInputAssetId(): string {
  return "input_" + randomBytes(12).toString("hex");
}

function view(record: InputAssetRecord, now = Date.now()): InputAssetView {
  return {
    inputAssetId: record.inputAssetId,
    kind: record.kind,
    filename: record.filename,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: Date.parse(record.expiresAt) <= now ? "expired" : "staged",
  };
}

export class InputStore {
  constructor(
    private readonly stateDir: string,
    private readonly config: Pick<
      AppConfig,
      | "maxInputAssetBytes"
      | "maxInputTotalBytes"
      | "maxInputAttachments"
      | "maxStagedTextBytes"
      | "inputTtlMs"
    >
  ) {}

  private create(input: {
    kind: InputKind;
    filename: string;
    mime: string;
    bytes: Buffer;
  }): InputAssetView {
    if (input.bytes.length > this.config.maxInputAssetBytes) {
      throw new InputStoreError(
        "INPUT_TOO_LARGE",
        "Input is " + input.bytes.length + " bytes; per-asset limit is " + this.config.maxInputAssetBytes + "."
      );
    }

    this.cleanup();
    const state = readState(this.stateDir);
    while (state.items.length >= MAX_INPUT_RECORDS) {
      const oldest = state.items.shift();
      if (oldest) fs.rmSync(path.join(filesDir(this.stateDir), oldest.storageName), { force: true });
    }

    const inputAssetId = newInputAssetId();
    const safeStorage = inputAssetId + "-" + input.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
    const target = path.join(filesDir(this.stateDir), safeStorage);
    if (fs.existsSync(target)) throw new InputStoreError("INPUT_STATE_CORRUPT", "Input staging collision.");

    fs.writeFileSync(target, input.bytes, { flag: "wx", mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}

    const now = Date.now();
    const record: InputAssetRecord = {
      inputAssetId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      storageName: safeStorage,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.inputTtlMs).toISOString(),
    };
    state.items.push(record);
    writeState(this.stateDir, state);
    return view(record, now);
  }

  stageText(input: { filename: string; content: string; mime?: string }): InputAssetView {
    const filename = validateInputFilename(input.filename);
    const mime = validateTextMime(input.mime);
    scanSensitiveText(input.content);
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > this.config.maxStagedTextBytes) {
      throw new InputStoreError(
        "INPUT_TOO_LARGE",
        "Text input is " + bytes.length + " bytes; text staging limit is " + this.config.maxStagedTextBytes + "."
      );
    }
    const ext = path.extname(filename).toLowerCase();
    const kind: InputKind = [".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml"].includes(ext)
      ? "data"
      : "text";
    return this.create({ kind, filename, mime, bytes });
  }

  stageBlob(input: { filename: string; mime: string; dataBase64: string }): InputAssetView {
    const bytes = decodeStrictBase64(input.dataBase64, this.config.maxInputAssetBytes);
    const validated = validateBinaryInput({
      filename: input.filename,
      mime: input.mime,
      bytes,
    });
    return this.create({ ...validated, bytes });
  }

  list(): InputAssetView[] {
    this.cleanup();
    return readState(this.stateDir).items.map((item) => view(item));
  }

  discard(inputAssetId: string): boolean {
    const state = readState(this.stateDir);
    const index = state.items.findIndex((item) => item.inputAssetId === inputAssetId);
    if (index < 0) return false;
    const [record] = state.items.splice(index, 1);
    if (record) fs.rmSync(path.join(filesDir(this.stateDir), record.storageName), { force: true });
    writeState(this.stateDir, state);
    return true;
  }

  cleanup(): number {
    const state = readState(this.stateDir);
    const now = Date.now();
    const keep: InputAssetRecord[] = [];
    let removed = 0;
    for (const record of state.items) {
      const file = path.join(filesDir(this.stateDir), record.storageName);
      const expired = Date.parse(record.expiresAt) <= now;
      const missing = !fs.existsSync(file);
      if (expired || missing) {
        fs.rmSync(file, { force: true });
        removed++;
      } else {
        keep.push(record);
      }
    }
    if (removed > 0) writeState(this.stateDir, { version: 1, items: keep });
    return removed;
  }

  resolve(inputAssetIds: string[]): ResolvedInputAsset[] {
    this.cleanup();
    if (inputAssetIds.length > this.config.maxInputAttachments) {
      throw new InputStoreError(
        "INPUT_TOO_MANY",
        "At most " + this.config.maxInputAttachments + " staged inputs may be attached to one turn."
      );
    }
    if (new Set(inputAssetIds).size !== inputAssetIds.length) {
      throw new InputStoreError("INPUT_TOO_MANY", "Duplicate input_asset_ids are not allowed.");
    }

    const state = readState(this.stateDir);
    const result: ResolvedInputAsset[] = [];
    let total = 0;
    for (const id of inputAssetIds) {
      if (!/^input_[a-f0-9]{24}$/.test(id)) {
        throw new InputStoreError("INPUT_NOT_FOUND", "Invalid input asset id.");
      }
      const record = state.items.find((item) => item.inputAssetId === id);
      if (!record) throw new InputStoreError("INPUT_NOT_FOUND", "Unknown or expired input asset: " + id);
      if (Date.parse(record.expiresAt) <= Date.now()) {
        throw new InputStoreError("INPUT_EXPIRED", "Input asset has expired: " + id);
      }
      const file = path.join(filesDir(this.stateDir), record.storageName);
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
        throw new InputStoreError("INPUT_INTEGRITY_ERROR", "Staged input file is missing or unsafe: " + id);
      }
      const bytes = fs.readFileSync(file);
      if (bytes.length !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
        throw new InputStoreError("INPUT_INTEGRITY_ERROR", "Staged input integrity check failed: " + id);
      }
      total += bytes.length;
      if (total > this.config.maxInputTotalBytes) {
        throw new InputStoreError(
          "INPUT_TOTAL_TOO_LARGE",
          "Combined attachment size exceeds " + this.config.maxInputTotalBytes + " bytes."
        );
      }
      result.push({ record, path: file });
    }
    return result;
  }
}
