import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
const oldState = process.env.CGW_STATE_DIR;
const oldHeadless = process.env.CGW_HEADLESS;
const oldTimeout = process.env.CGW_TIMEOUT_MS;
const oldStable = process.env.CGW_STABLE_MS;
const oldRequireWorkspace = process.env.CGW_REQUIRE_WORKSPACE_PROJECT;
const oldBrowserExecutable = process.env.CGW_BROWSER_EXECUTABLE;

afterEach(() => {
  if (oldState === undefined) delete process.env.CGW_STATE_DIR;
  else process.env.CGW_STATE_DIR = oldState;
  if (oldHeadless === undefined) delete process.env.CGW_HEADLESS;
  else process.env.CGW_HEADLESS = oldHeadless;
  if (oldTimeout === undefined) delete process.env.CGW_TIMEOUT_MS;
  else process.env.CGW_TIMEOUT_MS = oldTimeout;
  if (oldStable === undefined) delete process.env.CGW_STABLE_MS;
  else process.env.CGW_STABLE_MS = oldStable;
  if (oldRequireWorkspace === undefined) delete process.env.CGW_REQUIRE_WORKSPACE_PROJECT;
  else process.env.CGW_REQUIRE_WORKSPACE_PROJECT = oldRequireWorkspace;
  if (oldBrowserExecutable === undefined) delete process.env.CGW_BROWSER_EXECUTABLE;
  else process.env.CGW_BROWSER_EXECUTABLE = oldBrowserExecutable;

  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("config", () => {
  it("uses an isolated private state directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-state-"));
    dirs.push(dir);
    process.env.CGW_STATE_DIR = dir;
    process.env.CGW_HEADLESS = "false";
    process.env.CGW_TIMEOUT_MS = "45000";
    process.env.CGW_STABLE_MS = "7000";

    const config = loadConfig();
    expect(config.stateDir).toBe(dir);
    expect(config.profileDir).toBe(path.join(dir, "browser-profile"));
    expect(config.headless).toBe(false);
    expect(config.timeoutMs).toBe(45_000);
    expect(config.stableMs).toBe(7_000);
    expect(config.maxAssetBytes).toBe(25 * 1024 * 1024);
    expect(config.maxInlineBlobBytes).toBe(1024 * 1024);
    expect(config.requireWorkspaceProject).toBe(true);
  });

  it("allows intentional legacy general-chat opt-out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-state-"));
    dirs.push(dir);
    process.env.CGW_STATE_DIR = dir;
    process.env.CGW_REQUIRE_WORKSPACE_PROJECT = "false";
    expect(loadConfig().requireWorkspaceProject).toBe(false);
  });

  it("accepts an explicit browser executable override", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-state-"));
    dirs.push(dir);
    process.env.CGW_STATE_DIR = dir;
    process.env.CGW_BROWSER_EXECUTABLE = "/custom/browser";
    expect(loadConfig().browserExecutable).toBe("/custom/browser");
  });

  it("allows the caller to force headed login independently of env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-state-"));
    dirs.push(dir);
    process.env.CGW_STATE_DIR = dir;
    process.env.CGW_HEADLESS = "true";
    expect(loadConfig({ headless: false }).headless).toBe(false);
  });
});
