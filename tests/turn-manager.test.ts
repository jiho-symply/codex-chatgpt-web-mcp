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
    return { conversationId: "12345678-abcd", baselineAssistantCount: 2 };
  }

  async inspectTurn(): Promise<BrowserTurnSnapshot> {
    return (
      this.snapshots.shift() ?? {
        conversationId: "12345678-abcd",
        complete: false,
        paused: false,
        generating: true,
        response: null,
        responseBytes: 0,
        truncated: false,
      }
    );
  }

  async stopTurn(): Promise<BrowserTurnSnapshot> {
    return {
      conversationId: "12345678-abcd",
      complete: false,
      paused: false,
      generating: false,
      response: "partial",
      responseBytes: 7,
      truncated: false,
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
      complete: true,
      paused: false,
      generating: false,
      response: "done",
      responseBytes: 4,
      truncated: false,
    });
    const manager = new TurnManager(backend, new TurnStore(tmp()));
    const sent = await manager.send({
      requestId: "req-10002",
      prompt: "hello",
    });

    const finished = await manager.wait(sent.turnId, 30_000);
    expect(finished.status).toBe("completed");
    expect(finished.response).toBe("done");
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
