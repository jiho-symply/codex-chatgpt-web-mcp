import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssetStore,
  AssetStoreError,
  sanitizeAssetFilename,
} from "../src/assets/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-assets-"));
  dirs.push(dir);
  return dir;
}

describe("AssetStore", () => {
  it("registers deterministic metadata without persisting asset URLs", () => {
    const dir = tmp();
    const store = new AssetStore(dir);
    const first = store.register({
      conversationId: "12345678-abcd",
      assistantIndex: 4,
      kind: "file",
      ordinal: 0,
      filename: "solution.patch",
      mime: "text/x-diff",
    });
    const second = store.register({
      conversationId: "12345678-abcd",
      assistantIndex: 4,
      kind: "file",
      ordinal: 0,
      filename: "solution.patch",
      mime: "text/x-diff",
    });

    expect(second.assetId).toBe(first.assetId);
    expect(store.get(first.assetId).filename).toBe("solution.patch");

    const raw = fs.readFileSync(path.join(dir, "assets", "assets.json"), "utf8");
    expect(raw).toContain("solution.patch");
    expect(raw).not.toContain("https://");
    expect(raw).not.toContain("blob:");
  });

  it("saves bytes only in the private staging area with a safe filename", () => {
    const dir = tmp();
    const store = new AssetStore(dir);
    const record = store.register({
      conversationId: "12345678-abcd",
      assistantIndex: 1,
      kind: "file",
      ordinal: 0,
      filename: "../../unsafe.patch",
      mime: "text/x-diff",
    });

    const saved = store.save(record, Buffer.from("diff --git a/a b/a\n"), {
      maxBytes: 1024,
      mime: "text/x-diff",
    });

    expect(saved.filename).not.toContain("..");
    expect(saved.stagingPath.startsWith(path.join(dir, "assets", "staging"))).toBe(true);
    expect(fs.readFileSync(saved.stagingPath, "utf8")).toContain("diff --git");
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects oversized asset bodies", () => {
    const dir = tmp();
    const store = new AssetStore(dir);
    const record = store.register({
      conversationId: "12345678-abcd",
      assistantIndex: 1,
      kind: "image",
      ordinal: 0,
    });

    expect(() =>
      store.save(record, Buffer.alloc(20), {
        maxBytes: 10,
      })
    ).toThrowError(AssetStoreError);
  });

  it("sanitizes platform-sensitive filenames", () => {
    expect(sanitizeAssetFilename("../a:b?.txt", "fallback.bin")).toBe("a_b_.txt");
    expect(sanitizeAssetFilename("..", "fallback.bin")).toBe("fallback.bin");
  });
});
