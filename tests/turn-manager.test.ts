import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrowserDispatchRequest,
  BrowserTurnSnapshot,
} from "../src/browser/chatgpt.js";
import { TurnManager, type ChatTurnBackend } from "../src/turns/manager.js";
import { payloadHash, TurnStore } from "../src/turns/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-manager-"));
  dirs.push(dir);
  return dir;
}

class FakeBackend implements ChatTurnBackend {
  dispatches = 0;
  snapshots: BrowserTurnSnapshot[] = [];

  async dispatch(_input: BrowserDispatchRequest) {
    this.dispatches++;
    return {
      conversationId: "12345678-abcd",
      projectId: _input.workspaceId ? "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : null,
      workspaceId: _input.workspaceId ?? null,
      baselineAssistantCount: 2,
    };
  }

  async inspectTurn(): Promise<BrowserTurnSnapshot> {
    return (
      this.snapshots.shift() ?? {
        conversationId: "12345678-abcd",
        projectId: null,
        complete: false,
        paused: false,
        generating: true,
        response: null,
        responseBytes: 0,
        truncated: false,
        manifest: null,
        ui: {
          state: "generating" as const,
          message: null,
          actions: { stop: true, continue: false, retry: false, regenerate: false },
        },
      }
    );
  }

  async stopTurn(): Promise<BrowserTurnSnapshot> {
    return {
      conversationId: "12345678-abcd",
      projectId: null,
      complete: false,
      paused: false,
      generating: false,
      response: "partial",
      responseBytes: 7,
      truncated: false,
      manifest: null,
      ui: {
        state: "ready",
        message: null,
        actions: { stop: false, continue: false, retry: false, regenerate: true },
      },
    };
  }
}

describe("TurnManager", () => {
  it("sends at most once for an idempotency key", async () => {
    const backend = new FakeBackend();
    const manager = new TurnManager(backend, new TurnStore(tmp()));

    const first = await manager.send({
      requestId: "req-10001",
      prompt: "implement feature",
    });
    const second = await manager.send({
      requestId: "req-10001",
      prompt: "implement feature",
    });

    expect(backend.dispatches).toBe(1);
    expect(second.turnId).toBe(first.turnId);
    expect(second.deduplicated).toBe(true);
  });

  it("updates a generating turn to completed when the browser reports completion", async () => {
    const backend = new FakeBackend();
    backend.snapshots.push({
      conversationId: "12345678-abcd",
      projectId: null,
      complete: true,
      paused: false,
      generating: false,
      response: "done",
      responseBytes: 4,
      truncated: false,
      manifest: {
        version: 1,
        plainText: "done",
        parts: [{ type: "code", language: "diff", text: "diff --git a/a b/a" }],
        assistantIndex: 2,
        structured: true,
        assetCount: 0,
        codeBlockCount: 1,
      },
      ui: {
        state: "ready",
        message: null,
        actions: { stop: false, continue: false, retry: false, regenerate: true },
      },
    });
    const manager = new TurnManager(backend, new TurnStore(tmp()));
    const sent = await manager.send({
      requestId: "req-10002",
      prompt: "hello",
    });

    const finished = await manager.wait(sent.turnId, 30_000);
    expect(finished.status).toBe("completed");
    expect(finished.response).toBe("done");
    expect(finished.manifest?.codeBlockCount).toBe(1);
    expect(finished.manifest?.parts[0]).toMatchObject({ type: "code", language: "diff" });
  });

  it("does not redispatch an ambiguous reserved request after restart", async () => {
    const dir = tmp();
    const store = new TurnStore(dir);
    const hash = payloadHash({ prompt: "maybe sent" });
    const reserved = store.reserve({
      requestId: "req-10003",
      payloadHash: hash,
    });

    const backend = new FakeBackend();
    const manager = new TurnManager(backend, new TurnStore(dir));
    const result = await manager.send({
      requestId: "req-10003",
      prompt: "maybe sent",
    });

    expect(result.turnId).toBe(reserved.record.turnId);
    expect(result.status).toBe("reserved");
    expect(result.deduplicated).toBe(true);
    expect(backend.dispatches).toBe(0);
  });

  it("persists workspace and project identity returned by dispatch", async () => {
    const backend = new FakeBackend();
    const dir = tmp();
    const manager = new TurnManager(backend, new TurnStore(dir));
    const sent = await manager.send({
      requestId: "req-10005",
      prompt: "workspace task",
      workspaceId: "ws_0123456789abcdef",
    });

    expect(sent.workspaceId).toBe("ws_0123456789abcdef");
    expect(sent.projectId).toBe("g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const persisted = new TurnStore(dir).get(sent.turnId);
    expect(persisted.workspaceId).toBe("ws_0123456789abcdef");
    expect(persisted.projectId).toBe("g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("stops a known generating turn without sending another prompt", async () => {
    const backend = new FakeBackend();
    const manager = new TurnManager(backend, new TurnStore(tmp()));
    const sent = await manager.send({
      requestId: "req-10004",
      prompt: "long task",
    });

    const stopped = await manager.stop(sent.turnId);
    expect(stopped.status).toBe("stopped");
    expect(stopped.response).toBe("partial");
    expect(backend.dispatches).toBe(1);
  });
});
