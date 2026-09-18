import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  payloadHash,
  TurnStore,
  TurnStoreError,
} from "../src/turns/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-turns-"));
  dirs.push(dir);
  return dir;
}

describe("TurnStore", () => {
  it("deduplicates the same request id without storing prompt text", () => {
    const dir = tmp();
    const store = new TurnStore(dir);
    const prompt = "SECRET SOURCE CODE SHOULD NOT BE PERSISTED";
    const hash = payloadHash({ prompt, model: "Example" });

    const first = store.reserve({
      requestId: "req-00001",
      payloadHash: hash,
      model: "Example",
    });
    const second = store.reserve({
      requestId: "req-00001",
      payloadHash: hash,
      model: "Example",
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.record.turnId).toBe(first.record.turnId);

    const persisted = fs.readFileSync(path.join(dir, "turns", "turns.json"), "utf8");
    expect(persisted).not.toContain(prompt);
    expect(persisted).toContain(hash);
  });

  it("rejects request id reuse with different payloads", () => {
    const store = new TurnStore(tmp());
    store.reserve({
      requestId: "req-00002",
      payloadHash: payloadHash({ prompt: "one" }),
    });

    expect(() =>
      store.reserve({
        requestId: "req-00002",
        payloadHash: payloadHash({ prompt: "two" }),
      })
    ).toThrowError(TurnStoreError);
  });

  it("persists turn progress across store instances", () => {
    const dir = tmp();
    const first = new TurnStore(dir);
    const reserved = first.reserve({
      requestId: "req-00003",
      payloadHash: payloadHash({ prompt: "hello" }),
    });
    first.update(reserved.record.turnId, {
      conversationId: "12345678-abcd",
      baselineAssistantCount: 3,
      status: "generating",
    });

    const second = new TurnStore(dir);
    expect(second.get(reserved.record.turnId)).toMatchObject({
      conversationId: "12345678-abcd",
      baselineAssistantCount: 3,
      status: "generating",
    });
  });
});
