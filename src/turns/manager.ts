import { randomUUID } from "node:crypto";
import type {
  BrowserDispatchRequest,
  BrowserTurnDispatch,
  BrowserTurnSnapshot,
} from "../browser/chatgpt.js";
import { ChatGptWebError } from "../browser/chatgpt.js";
import type { ResponseManifest } from "../browser/response-extractor.js";
import type { ChatGptUiSnapshot } from "../browser/ui-state.js";
import {
  payloadHash,
  TurnStore,
  TurnStoreError,
  type TurnRecord,
} from "./store.js";

export interface ChatTurnBackend {
  dispatch(input: BrowserDispatchRequest): Promise<BrowserTurnDispatch>;
  inspectTurn(input: {
    conversationId: string | null;
    baselineAssistantCount: number;
    timeoutMs: number;
  }): Promise<BrowserTurnSnapshot>;
  stopTurn(input: {
    conversationId: string | null;
    baselineAssistantCount: number;
  }): Promise<BrowserTurnSnapshot>;
}

export interface SendTurnInput {
  requestId: string;
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  inputAssetIds?: string[];
}

export interface TurnView {
  turnId: string;
  requestId: string;
  conversationId: string | null;
  status: TurnRecord["status"];
  deduplicated?: boolean;
  response?: string | null;
  responseBytes?: number;
  truncated?: boolean;
  paused?: boolean;
  timedOut?: boolean;
  lastErrorCode?: string | null;
  manifest?: ResponseManifest | null;
  ui?: ChatGptUiSnapshot;
  requestedModel: string | null;
  requestedEffort: string | null;
}

function view(record: TurnRecord, extra: Partial<TurnView> = {}): TurnView {
  return {
    turnId: record.turnId,
    requestId: record.requestId,
    conversationId: record.conversationId,
    status: record.status,
    lastErrorCode: record.lastErrorCode ?? null,
    requestedModel: record.requestedModel,
    requestedEffort: record.requestedEffort,
    ...extra,
  };
}

export class TurnManager {
  constructor(
    private readonly client: ChatTurnBackend,
    private readonly store: TurnStore
  ) {}

  async send(input: SendTurnInput): Promise<TurnView> {
    const hash = payloadHash(input);
    const reserved = this.store.reserve({
      requestId: input.requestId,
      payloadHash: hash,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });

    if (reserved.deduplicated) {
      return view(reserved.record, { deduplicated: true });
    }

    try {
      const dispatched = await this.client.dispatch({
        prompt: input.prompt,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.inputAssetIds ? { inputAssetIds: input.inputAssetIds } : {}),
      });
      const record = this.store.update(reserved.record.turnId, {
        conversationId: dispatched.conversationId,
        baselineAssistantCount: dispatched.baselineAssistantCount,
        status: "generating",
      });
      return view(record, { deduplicated: false });
    } catch (error) {
      const code =
        error instanceof ChatGptWebError
          ? error.code
          : error instanceof TurnStoreError
            ? error.code
            : "INTERNAL_ERROR";
      this.store.update(reserved.record.turnId, {
        status: "error",
        lastErrorCode: code,
      });
      throw error;
    }
  }

  private applySnapshot(record: TurnRecord, snapshot: BrowserTurnSnapshot): TurnView {
    let next = record;
    if (snapshot.conversationId && snapshot.conversationId !== record.conversationId) {
      next = this.store.update(record.turnId, { conversationId: snapshot.conversationId });
    }
    if (snapshot.complete && next.status !== "completed") {
      next = this.store.update(next.turnId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    }
    return view(next, {
      response: snapshot.response,
      responseBytes: snapshot.responseBytes,
      truncated: snapshot.truncated,
      paused: snapshot.paused,
      manifest: snapshot.manifest,
      ui: snapshot.ui,
    });
  }

  async getReply(turnId: string): Promise<TurnView> {
    const record = this.store.get(turnId);
    if (record.status === "reserved" || record.status === "error") return view(record);
    const snapshot = await this.client.inspectTurn({
      conversationId: record.conversationId,
      baselineAssistantCount: record.baselineAssistantCount ?? 0,
      timeoutMs: 0,
    });
    return this.applySnapshot(record, snapshot);
  }

  async wait(turnId: string, timeoutMs: number): Promise<TurnView> {
    const record = this.store.get(turnId);
    if (
      record.status === "reserved" ||
      record.status === "error" ||
      record.status === "stopped"
    ) {
      return view(record);
    }

    const snapshot = await this.client.inspectTurn({
      conversationId: record.conversationId,
      baselineAssistantCount: record.baselineAssistantCount ?? 0,
      timeoutMs,
    });
    return this.applySnapshot(record, snapshot);
  }

  async stop(turnId: string): Promise<TurnView> {
    const record = this.store.get(turnId);
    if (
      record.status === "reserved" ||
      record.status === "completed" ||
      record.status === "stopped" ||
      record.status === "error"
    ) {
      return view(record);
    }
    const snapshot = await this.client.stopTurn({
      conversationId: record.conversationId,
      baselineAssistantCount: record.baselineAssistantCount ?? 0,
    });
    const next = this.store.update(turnId, {
      conversationId: snapshot.conversationId ?? record.conversationId,
      status: "stopped",
      completedAt: new Date().toISOString(),
    });
    return view(next, {
      response: snapshot.response,
      responseBytes: snapshot.responseBytes,
      truncated: snapshot.truncated,
      manifest: snapshot.manifest,
      ui: snapshot.ui,
    });
  }

  async chat(
    input: Omit<SendTurnInput, "requestId"> & { requestId?: string; timeoutMs: number }
  ): Promise<TurnView> {
    const requestId = input.requestId ?? "chat:" + randomUUID();
    const sent = await this.send({
      requestId,
      prompt: input.prompt,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });

    if (sent.status === "reserved" || sent.status === "error" || sent.status === "stopped") {
      return sent;
    }
    if (sent.status === "completed") return this.getReply(sent.turnId);

    const deadline = Date.now() + input.timeoutMs;
    let latest = sent;
    while (Date.now() < deadline) {
      const slice = Math.min(30_000, Math.max(1_000, deadline - Date.now()));
      latest = await this.wait(sent.turnId, slice);
      if (
        latest.status === "completed" ||
        latest.status === "reserved" ||
        latest.status === "error" ||
        latest.status === "stopped"
      ) {
        return latest;
      }
      if (latest.paused) return latest;
    }

    return { ...latest, timedOut: true };
  }
}
