import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { InputPolicyError } from "../src/inputs/policy.js";
import { InputStore, InputStoreError } from "../src/inputs/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-input-"));
  dirs.push(dir);
  return dir;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stateDir: "",
    profileDir: "",
    headless: true,
    browserChannel: undefined,
    timeoutMs: 180_000,
    stableMs: 5_000,
    maxPromptBytes: 512 * 1024,
    maxResponseBytes: 1024 * 1024,
    maxAssetBytes: 25 * 1024 * 1024,
    maxStagedTextBytes: 4 * 1024 * 1024,
    maxInlineBlobBytes: 1024 * 1024,
    maxInputAssetBytes: 20 * 1024 * 1024,
    maxInputTotalBytes: 50 * 1024 * 1024,
    maxInputAttachments: 10,
    inputTtlMs: 24 * 60 * 60 * 1000,
    requireWorkspaceProject: true,
    ...overrides,
  };
}

describe("InputStore", () => {
  it("stages only caller-provided text and resolves it from private state", () => {
    const dir = tmp();
    const store = new InputStore(dir, config());
    const staged = store.stageText({
      filename: "client.ts",
      content: "export const value = 1;\n",
      mime: "text/typescript",
    });

    expect(staged.inputAssetId).toMatch(/^input_[a-f0-9]{24}$/);
    expect(staged.kind).toBe("text");
    expect(staged.status).toBe("staged");

    const resolved = store.resolve([staged.inputAssetId]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.path.startsWith(path.join(dir, "input-staging", "files"))).toBe(true);
    expect(fs.readFileSync(resolved[0]!.path, "utf8")).toContain("export const");
  });

  it("blocks credential-like filenames and actual private-key blocks", () => {
    const store = new InputStore(tmp(), config());
    expect(() =>
      store.stageText({ filename: ".env", content: "SAFE=value" })
    ).toThrowError(InputPolicyError);
    expect(() =>
      store.stageText({
        filename: "notes.txt",
        content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      })
    ).toThrowError(InputPolicyError);

    expect(() =>
      store.stageText({
        filename: "token-fixture.txt",
        content: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
    ).not.toThrow();
  });

  it("rejects archives and unknown binary", () => {
    const store = new InputStore(tmp(), config());
    expect(() =>
      store.stageBlob({
        filename: "repo.zip",
        mime: "application/zip",
        dataBase64: Buffer.from("PK\x03\x04").toString("base64"),
      })
    ).toThrowError(InputPolicyError);
  });

  it("accepts a validated PNG but rejects MIME/extension mismatch", () => {
    const store = new InputStore(tmp(), config());
    const png = Buffer.concat([
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
      Buffer.from("test"),
    ]);
    const staged = store.stageBlob({
      filename: "bug.png",
      mime: "image/png",
      dataBase64: png.toString("base64"),
    });
    expect(staged.kind).toBe("image");

    expect(() =>
      store.stageBlob({
        filename: "bug.jpg",
        mime: "image/png",
        dataBase64: png.toString("base64"),
      })
    ).toThrowError(InputPolicyError);
  });

  it("enforces combined size and attachment count", () => {
    const dir = tmp();
    const store = new InputStore(dir, config({ maxInputTotalBytes: 5, maxInputAttachments: 1 }));
    const a = store.stageText({ filename: "a.txt", content: "abc" });
    const b = store.stageText({ filename: "b.txt", content: "def" });

    expect(() => store.resolve([a.inputAssetId, b.inputAssetId])).toThrowError(InputStoreError);
    expect(() => store.resolve([a.inputAssetId, a.inputAssetId])).toThrowError(InputStoreError);
  });

  it("cleans expired staged inputs", () => {
    const dir = tmp();
    const store = new InputStore(dir, config({ inputTtlMs: 1 }));
    const staged = store.stageText({ filename: "old.txt", content: "old" });
    const recordPath = path.join(dir, "input-staging", "inputs.json");
    const state = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    state.items[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(recordPath, JSON.stringify(state));

    expect(store.cleanup()).toBe(1);
    expect(store.list()).toEqual([]);
    expect(() => store.resolve([staged.inputAssetId])).toThrowError(InputStoreError);
  });


  it("commits a binary write slot and computes integrity metadata at commit", () => {
    const dir = tmp();
    const store = new InputStore(dir, config());
    const pdf = Buffer.from("%PDF-1.7\nbody\n");
    const slot = store.createBlobSlot({
      filename: "spec.pdf",
      mime: "application/pdf",
    });

    expect(slot.writePath.startsWith(path.join(dir, "input-staging", "inbox"))).toBe(true);
    fs.writeFileSync(slot.writePath, pdf);

    const staged = store.commitBlobSlot(slot.slotId);
    expect(staged.filename).toBe("spec.pdf");
    expect(staged.kind).toBe("document");
    expect(staged.sizeBytes).toBe(pdf.length);
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => store.commitBlobSlot(slot.slotId)).toThrowError(InputStoreError);
  });

  it("rejects invalid or oversized blob-slot content at commit", () => {
    const dir = tmp();
    const invalidStore = new InputStore(dir, config());
    const invalid = invalidStore.createBlobSlot({
      filename: "spec.pdf",
      mime: "application/pdf",
    });
    fs.writeFileSync(invalid.writePath, "not a pdf");
    expect(() => invalidStore.commitBlobSlot(invalid.slotId)).toThrowError(InputPolicyError);

    const smallLimitStore = new InputStore(dir, config({ maxInputAssetBytes: 8 }));
    const oversized = smallLimitStore.createBlobSlot({
      filename: "large.pdf",
      mime: "application/pdf",
    });
    fs.writeFileSync(oversized.writePath, Buffer.from("%PDF-1.7\nbody\n"));
    expect(() => smallLimitStore.commitBlobSlot(oversized.slotId)).toThrowError(InputStoreError);
  });

  it("keeps base64 blob staging as a small-file convenience path", () => {
    const store = new InputStore(tmp(), config({ maxInlineBlobBytes: 8 }));
    const png = Buffer.concat([
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
      Buffer.from("too-large"),
    ]);
    expect(() =>
      store.stageBlob({
        filename: "bug.png",
        mime: "image/png",
        dataBase64: png.toString("base64"),
      })
    ).toThrowError(InputPolicyError);
  });

  it("detects staged-file tampering before upload", () => {
    const dir = tmp();
    const store = new InputStore(dir, config());
    const staged = store.stageText({ filename: "safe.txt", content: "one" });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "input-staging", "inputs.json"), "utf8"));
    const file = path.join(dir, "input-staging", "files", state.items[0].storageName);
    fs.writeFileSync(file, "tampered");

    expect(() => store.resolve([staged.inputAssetId])).toThrowError(InputStoreError);
  });
});
