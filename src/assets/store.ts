import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ensurePrivateDir } from "../config.js";

export type AssetKind = "file" | "image";

export interface AssetRecord {
  assetId: string;
  conversationId: string;
  assistantIndex: number;
  kind: AssetKind;
  ordinal: number;
  filename: string | null;
  mime: string | null;
  createdAt: string;
}

interface AssetState {
  version: 1;
  items: AssetRecord[];
}

export interface SavedAsset {
  assetId: string;
  kind: AssetKind;
  filename: string;
  mime: string | null;
  sizeBytes: number;
  sha256: string;
  stagingPath: string;
}

export class AssetStoreError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "ASSET_STATE_CORRUPT" | "ASSET_TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "AssetStoreError";
  }
}

const MAX_ASSET_RECORDS = 500;

function recordsDir(stateDir: string): string {
  return ensurePrivateDir(path.join(stateDir, "assets"));
}

function stateFile(stateDir: string): string {
  return path.join(recordsDir(stateDir), "assets.json");
}

function stagingDir(stateDir: string): string {
  return ensurePrivateDir(path.join(recordsDir(stateDir), "staging"));
}

function readState(stateDir: string): AssetState {
  const file = stateFile(stateDir);
  if (!fs.existsSync(file)) return { version: 1, items: [] };
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new AssetStoreError("ASSET_STATE_CORRUPT", "Refusing symlinked asset-state file.");
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AssetState>;
    if (raw.version !== 1 || !Array.isArray(raw.items)) throw new Error("invalid shape");
    return { version: 1, items: raw.items as AssetRecord[] };
  } catch (error) {
    if (error instanceof AssetStoreError) throw error;
    throw new AssetStoreError("ASSET_STATE_CORRUPT", "Asset-state file is unreadable or invalid.");
  }
}

function writeState(stateDir: string, state: AssetState): void {
  const file = stateFile(stateDir);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new AssetStoreError("ASSET_STATE_CORRUPT", "Refusing symlinked asset-state file.");
  }
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function deterministicAssetId(input: {
  conversationId: string;
  assistantIndex: number;
  kind: AssetKind;
  ordinal: number;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24);
  return "asset_" + digest;
}

export function sanitizeAssetFilename(value: string | null | undefined, fallback: string): string {
  let name = (value ?? "").replace(/\\/g, "/");
  name = path.posix.basename(name);
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
  name = name.replace(/^\.+/, "").trim();
  if (!name || name === "." || name === "..") name = fallback;
  if (name.length > 140) {
    const ext = path.extname(name).slice(0, 20);
    const base = path.basename(name, ext).slice(0, Math.max(1, 140 - ext.length));
    name = base + ext;
  }
  return name;
}

export class AssetStore {
  constructor(private readonly stateDir: string) {}

  register(input: {
    conversationId: string;
    assistantIndex: number;
    kind: AssetKind;
    ordinal: number;
    filename?: string | null;
    mime?: string | null;
  }): AssetRecord {
    const assetId = deterministicAssetId(input);
    const state = readState(this.stateDir);
    const existing = state.items.find((item) => item.assetId === assetId);
    if (existing) {
      existing.filename = input.filename ?? existing.filename;
      existing.mime = input.mime ?? existing.mime;
      writeState(this.stateDir, state);
      return existing;
    }

    const record: AssetRecord = {
      assetId,
      conversationId: input.conversationId,
      assistantIndex: input.assistantIndex,
      kind: input.kind,
      ordinal: input.ordinal,
      filename: input.filename ?? null,
      mime: input.mime ?? null,
      createdAt: new Date().toISOString(),
    };
    state.items.push(record);
    while (state.items.length > MAX_ASSET_RECORDS) state.items.shift();
    writeState(this.stateDir, state);
    return record;
  }

  get(assetId: string): AssetRecord {
    if (!/^asset_[a-f0-9]{24}$/.test(assetId)) {
      throw new AssetStoreError("ASSET_NOT_FOUND", "Invalid asset id.");
    }
    const record = readState(this.stateDir).items.find((item) => item.assetId === assetId);
    if (!record) throw new AssetStoreError("ASSET_NOT_FOUND", "Unknown asset id: " + assetId);
    return record;
  }

  save(
    record: AssetRecord,
    bytes: Buffer,
    input: { filename?: string | null; mime?: string | null; maxBytes: number }
  ): SavedAsset {
    if (bytes.length > input.maxBytes) {
      throw new AssetStoreError(
        "ASSET_TOO_LARGE",
        "Asset is " + bytes.length + " bytes; limit is " + input.maxBytes + "."
      );
    }
    const fallback = record.kind === "image" ? "image.bin" : "attachment.bin";
    const filename = sanitizeAssetFilename(input.filename ?? record.filename, fallback);
    const target = path.join(stagingDir(this.stateDir), record.assetId + "-" + filename);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new AssetStoreError("ASSET_STATE_CORRUPT", "Refusing symlinked staged asset.");
    }
    const temp = target + "." + randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, target);
    return {
      assetId: record.assetId,
      kind: record.kind,
      filename,
      mime: input.mime ?? record.mime ?? null,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stagingPath: target,
    };
  }
}
