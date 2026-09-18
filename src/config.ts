import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_STABLE_MS = 5_000;
export const MAX_PROMPT_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_STAGED_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_INPUT_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_ATTACHMENTS = 10;
export const DEFAULT_INPUT_TTL_HOURS = 24;

export interface AppConfig {
  stateDir: string;
  profileDir: string;
  headless: boolean;
  browserChannel: string | undefined;
  timeoutMs: number;
  stableMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
  maxAssetBytes: number;
  maxStagedTextBytes: number;
  maxInputAssetBytes: number;
  maxInputTotalBytes: number;
  maxInputAttachments: number;
  inputTtlMs: number;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Invalid boolean environment value: " + value);
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("Expected integer between " + min + " and " + max + ", got: " + value);
  }
  return parsed;
}

export function defaultStateDir(): string {
  const override = process.env.CGW_STATE_DIR?.trim();
  if (override) return path.resolve(override);

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "codex-chatgpt-web-mcp");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "codex-chatgpt-web-mcp"
    );
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    "codex-chatgpt-web-mcp"
  );
}

export function ensurePrivateDir(dir: string): string {
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error("Refusing to use a symlink as private state directory: " + dir);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error("Refusing to use a symlink as private state directory: " + dir);
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows and some filesystems do not implement POSIX mode bits.
  }
  return dir;
}

export function loadConfig(overrides: { headless?: boolean } = {}): AppConfig {
  const stateDir = ensurePrivateDir(defaultStateDir());
  const profileDir = ensurePrivateDir(path.join(stateDir, "browser-profile"));
  const channel = process.env.CGW_BROWSER_CHANNEL?.trim();

  return {
    stateDir,
    profileDir,
    headless: overrides.headless ?? boolEnv(process.env.CGW_HEADLESS, true),
    browserChannel: channel || undefined,
    timeoutMs: intEnv(process.env.CGW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 10_000, 600_000),
    stableMs: intEnv(process.env.CGW_STABLE_MS, DEFAULT_STABLE_MS, 1_000, 30_000),
    maxPromptBytes: MAX_PROMPT_BYTES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxAssetBytes: MAX_ASSET_BYTES,
    maxStagedTextBytes: MAX_STAGED_TEXT_BYTES,
    maxInputAssetBytes: MAX_INPUT_ASSET_BYTES,
    maxInputTotalBytes: MAX_INPUT_TOTAL_BYTES,
    maxInputAttachments: MAX_INPUT_ATTACHMENTS,
    inputTtlMs:
      intEnv(process.env.CGW_INPUT_TTL_HOURS, DEFAULT_INPUT_TTL_HOURS, 1, 168) *
      60 *
      60 *
      1000,
  };
}
