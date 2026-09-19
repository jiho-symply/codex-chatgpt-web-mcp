import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2ERunner } from "../src/e2e/runner.js";
import type { AppConfig } from "../src/config.js";
import type { ChatGptWebClient } from "../src/browser/chatgpt.js";
import type { TurnManager, TurnView } from "../src/turns/manager.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function config(stateDir: string): AppConfig {
  return {
    stateDir,
    profileDir: path.join(stateDir, "browser-profile"),
    headless: false,
    browserMode: "system-cdp",
    cdpPort: undefined,
    browserChannel: undefined,
    browserExecutable: undefined,
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
  };
}

function completed(
  turnId: string,
  requestId: string,
  projectId: string,
  response: string,
  manifest?: TurnView["manifest"]
): TurnView {
  return {
    turnId,
    requestId,
    conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    workspaceId: "ws_0123456789abcdef",
    projectId,
    status: "completed",
    response,
    responseBytes: Buffer.byteLength(response),
    truncated: false,
    paused: false,
    manifest: manifest ?? {
      version: 1,
      plainText: response,
      parts: [{ type: "text", text: response }],
      assistantIndex: 0,
      structured: false,
      assetCount: 0,
      codeBlockCount: 0,
    },
    requestedModel: null,
    requestedEffort: null,
  };
}

describe("autonomous E2E runner", () => {
  it("checkpoints a full run and can recover the latest report without remembering run id", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-e2e-"));
    dirs.push(stateDir);
    const projectId = "g-p-0123456789abcdef";
    const turnsById = new Map<string, TurnView>();
    const requests = new Map<string, { prompt: string; turnId: string }>();
    let turnCounter = 0;
    let remoteDispatches = 0;

    const fakeClient = {
      async status() {
        return {
          authenticated: true,
          uiReady: true,
          conversationId: null,
          projectId: null,
          headless: false,
          ui: {
            state: "ready",
            message: null,
            actions: { stop: false, continue: false, retry: false, regenerate: false },
          },
        };
      },
      async bindWorkspaceProject() {
        const now = new Date().toISOString();
        return {
          workspaceId: "ws_0123456789abcdef",
          workspaceName: "CGW-E2E-Test",
          namingMode: "workspace-name",
          projectId,
          projectName: "CGW-CGW-E2E-Test · 012345",
          projectUrl: "https://chatgpt.com/g/" + projectId + "/project",
          memoryMode: "project-only",
          memoryVerifiedAt: now,
          memoryVerificationSource: "creation",
          status: "ready",
          createdAt: now,
          updatedAt: now,
        };
      },
      async capabilities() {
        return {
          modelPicker: { found: true, current: "GPT-X", options: ["GPT-X"] },
          effortPicker: { found: false, current: null, options: [] },
          flattenedPicker: true,
        };
      },
      stageTextInput() {
        return {
          inputAssetId: "input_0123456789abcdef01234567",
          kind: "text",
          filename: "cgw-e2e-sentinel.txt",
          mime: "text/plain",
          sizeBytes: 24,
          sha256: "0".repeat(64),
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          status: "staged",
        };
      },
      discardStagedInput(inputAssetId: string) {
        return { inputAssetId, discarded: true };
      },
    } as unknown as ChatGptWebClient;

    const fakeTurns = {
      async send(input: {
        requestId: string;
        prompt: string;
        workspaceId?: string;
        inputAssetIds?: string[];
        model?: string;
        effort?: string;
      }) {
        if (!input.workspaceId) {
          const error = new Error("workspace required") as Error & { code?: string };
          error.code = "WORKSPACE_REQUIRED";
          throw error;
        }
        const existing = requests.get(input.requestId);
        if (existing) {
          if (existing.prompt !== input.prompt) {
            const error = new Error("request conflict") as Error & { code?: string };
            error.code = "REQUEST_ID_CONFLICT";
            throw error;
          }
          const record = turnsById.get(existing.turnId)!;
          return { ...record, status: "generating", response: undefined, manifest: undefined, deduplicated: true };
        }

        const turnId = "turn_" + String(++turnCounter).padStart(24, "0");
        requests.set(input.requestId, { prompt: input.prompt, turnId });
        remoteDispatches++;

        let final: TurnView;
        if (input.requestId.endsWith(":compact")) {
          const response =
            "ATTACHMENT_SENTINEL_7F3A\n\n" +
            "```python\nprint('CGW')\n```\n\n" +
            "| A | B |\n| --- | --- |\n| 1 | 2 |";
          final = completed(turnId, input.requestId, projectId, response, {
            version: 1,
            plainText: response,
            parts: [
              { type: "text", text: "ATTACHMENT_SENTINEL_7F3A" },
              { type: "code", language: "python", text: "print('CGW')" },
              {
                type: "table",
                headers: ["A", "B"],
                rows: [["1", "2"]],
                markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |",
              },
            ],
            assistantIndex: 0,
            structured: true,
            assetCount: 0,
            codeBlockCount: 1,
          });
          final = {
            ...final,
            requestedModel: input.model ?? null,
            requestedEffort: input.effort ?? null,
          };
        } else {
          final = completed(turnId, input.requestId, projectId, "OK");
        }
        turnsById.set(turnId, final);
        return {
          ...final,
          status: "generating",
          response: undefined,
          manifest: undefined,
          deduplicated: false,
        };
      },
      async getReply(turnId: string) {
        const turn = turnsById.get(turnId);
        if (!turn) {
          const error = new Error("unknown turn") as Error & { code?: string };
          error.code = "TURN_NOT_FOUND";
          throw error;
        }
        return turn;
      },
      async wait(turnId: string) {
        return this.getReply(turnId);
      },
    } as unknown as TurnManager;

    const runner = new E2ERunner(
      fakeClient,
      fakeTurns,
      config(stateDir),
      async (fn) => fn()
    );

    const started = runner.start({
      workspaceId: "ws_0123456789abcdef",
      workspaceName: "CGW-E2E-Test",
      includeSelection: true,
    });

    let latest = runner.status(started.runId);
    const deadline = Date.now() + 5_000;
    while (latest.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      latest = runner.status(started.runId);
    }

    expect(latest.status).toBe("completed");
    expect(latest.summary.fail).toBe(0);
    expect(latest.summary.blocked).toBe(0);
    expect(latest.summary.pass).toBeGreaterThanOrEqual(12);
    expect(latest.tests.find((test) => test.id === "E2")?.status).toBe("PASS");
    expect(remoteDispatches).toBe(1);
    expect(fs.existsSync(latest.reportPath)).toBe(true);
    expect(fs.readFileSync(latest.reportPath, "utf8")).toContain("# CGW Windows E2E Report");

    const recovered = runner.latest();
    expect(recovered?.runId).toBe(started.runId);
    expect(runner.report(started.runId).markdown).toContain("C1");
  });

  it("marks browser-send dependents NOT_RUN when workspace binding fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-e2e-"));
    dirs.push(stateDir);

    const fakeClient = {
      async status() {
        return {
          authenticated: true,
          uiReady: true,
          conversationId: null,
          projectId: null,
          headless: false,
          ui: {
            state: "ready",
            message: null,
            actions: { stop: false, continue: false, retry: false, regenerate: false },
          },
        };
      },
      async bindWorkspaceProject() {
        const error = new Error("project missing") as Error & { code?: string };
        error.code = "PROJECT_NOT_FOUND";
        throw error;
      },
      async capabilities() {
        return {
          modelPicker: { found: false, current: null, options: [] },
          effortPicker: { found: false, current: null, options: [] },
          flattenedPicker: false,
        };
      },
    } as unknown as ChatGptWebClient;

    const fakeTurns = {
      async send(input: { workspaceId?: string }) {
        if (!input.workspaceId) {
          const error = new Error("workspace required") as Error & { code?: string };
          error.code = "WORKSPACE_REQUIRED";
          throw error;
        }
        throw new Error("remote send must not run after B1 failure");
      },
      async getReply() {
        const error = new Error("unknown turn") as Error & { code?: string };
        error.code = "TURN_NOT_FOUND";
        throw error;
      },
    } as unknown as TurnManager;

    const runner = new E2ERunner(
      fakeClient,
      fakeTurns,
      config(stateDir),
      async (fn) => fn()
    );

    const started = runner.start({
      workspaceId: "ws_0123456789abcdef",
      workspaceName: "CGW-E2E-Test",
    });

    let latest = runner.status(started.runId);
    const deadline = Date.now() + 2_000;
    while (latest.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      latest = runner.status(started.runId);
    }

    expect(latest.status).toBe("completed");
    expect(latest.tests.find((test) => test.id === "B1")?.status).toBe("FAIL");
    expect(latest.tests.find((test) => test.id === "E1")?.status).toBe("FAIL");
    expect(latest.tests.find((test) => test.id === "C1")?.status).toBe("NOT_RUN");
    expect(latest.tests.find((test) => test.id === "F1")?.status).toBe("NOT_RUN");
    expect(latest.tests.find((test) => test.id === "G1")?.status).toBe("NOT_RUN");
    expect(latest.tests.find((test) => test.id === "I1")?.status).toBe("NOT_RUN");
    expect(latest.tests.find((test) => test.id === "H1")?.status).toBe("PASS");
    expect(latest.tests.find((test) => test.id === "H2")?.status).toBe("PASS");
  });

  it("stops early and persists BLOCKED when human authentication is required", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-e2e-"));
    dirs.push(stateDir);

    const fakeClient = {
      async status() {
        return {
          authenticated: false,
          uiReady: false,
          conversationId: null,
          projectId: null,
          headless: false,
          ui: {
            state: "auth_required",
            message: "login required",
            actions: { stop: false, continue: false, retry: false, regenerate: false },
          },
        };
      },
    } as unknown as ChatGptWebClient;

    const runner = new E2ERunner(
      fakeClient,
      {} as TurnManager,
      config(stateDir),
      async (fn) => fn()
    );

    const started = runner.start({
      workspaceId: "ws_0123456789abcdef",
      workspaceName: "CGW-E2E-Test",
    });

    let latest = runner.status(started.runId);
    const deadline = Date.now() + 2_000;
    while (latest.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      latest = runner.status(started.runId);
    }

    expect(latest.status).toBe("blocked");
    expect(latest.summary.blocked).toBe(1);
    expect(latest.tests[0]?.errorCode).toBe("AUTH_REQUIRED");
  });
});
