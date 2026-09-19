import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { ensurePrivateDir } from "../config.js";
import type { ChatGptWebClient, ChatGptCapabilities } from "../browser/chatgpt.js";
import type { TurnManager, TurnView } from "../turns/manager.js";

export type E2ETestStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type E2ERunStatus = "running" | "completed" | "blocked" | "interrupted";

export interface E2ETestResult {
  id: string;
  name: string;
  status: E2ETestStatus;
  durationMs: number;
  expected: string;
  observed: string;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  turnId: string | null;
  projectId: string | null;
}

export interface E2ERunState {
  version: 1;
  runId: string;
  status: E2ERunStatus;
  workspaceId: string;
  workspaceName: string | null;
  includeSelection: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  projectId: string | null;
  tests: E2ETestResult[];
  summary: {
    pass: number;
    fail: number;
    blocked: number;
    notRun: number;
  };
  reportPath: string;
}

type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

function e2eDir(stateDir: string): string {
  return ensurePrivateDir(path.join(stateDir, "e2e"));
}

function statePath(stateDir: string, runId: string): string {
  return path.join(e2eDir(stateDir), runId + ".json");
}

function reportPath(stateDir: string, runId: string): string {
  return path.join(e2eDir(stateDir), runId + ".md");
}

function errorInfo(error: unknown): { code: string | null; message: string } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : null,
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : String(error),
    };
  }
  return { code: null, message: String(error) };
}

function summary(tests: E2ETestResult[]) {
  return {
    pass: tests.filter((test) => test.status === "PASS").length,
    fail: tests.filter((test) => test.status === "FAIL").length,
    blocked: tests.filter((test) => test.status === "BLOCKED").length,
    notRun: tests.filter((test) => test.status === "NOT_RUN").length,
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdown(state: E2ERunState): string {
  const lines = [
    "# CGW Windows E2E Report",
    "",
    "Run: `" + state.runId + "`",
    "Status: **" + state.status.toUpperCase() + "**",
    "Workspace: `" + state.workspaceId + "`",
    "Project: " + (state.projectId ? "`" + state.projectId + "`" : "(not established)"),
    "Started: " + state.startedAt,
    "Completed: " + (state.completedAt ?? "(not yet)"),
    "",
    "## Summary",
    "",
    "| PASS | FAIL | BLOCKED | NOT RUN |",
    "| ---: | ---: | ---: | ---: |",
    "| " +
      state.summary.pass +
      " | " +
      state.summary.fail +
      " | " +
      state.summary.blocked +
      " | " +
      state.summary.notRun +
      " |",
    "",
    "## Tests",
    "",
    "| ID | Result | Test | Expected | Observed | Error |",
    "| --- | --- | --- | --- | --- | --- |",
    ...state.tests.map(
      (test) =>
        "| " +
        test.id +
        " | " +
        test.status +
        " | " +
        escapeCell(test.name) +
        " | " +
        escapeCell(test.expected) +
        " | " +
        escapeCell(test.observed) +
        " | " +
        escapeCell(
          test.errorCode
            ? test.errorCode + ": " + (test.errorMessage ?? "")
            : test.errorMessage ?? ""
        ) +
        " |"
    ),
    "",
    "## References",
    "",
    ...state.tests
      .filter((test) => test.requestId || test.turnId || test.projectId)
      .map(
        (test) =>
          "- " +
          test.id +
          ": request=" +
          (test.requestId ?? "-") +
          ", turn=" +
          (test.turnId ?? "-") +
          ", project=" +
          (test.projectId ?? "-")
      ),
    "",
  ];
  return lines.join("\n");
}

function writeState(stateDir: string, state: E2ERunState): void {
  state.summary = summary(state.tests);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath(stateDir, state.runId), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  fs.writeFileSync(state.reportPath, markdown(state), { mode: 0o600 });
}

function readState(stateDir: string, runId: string): E2ERunState {
  const file = statePath(stateDir, runId);
  if (!fs.existsSync(file)) throw new Error("Unknown E2E run: " + runId);
  return JSON.parse(fs.readFileSync(file, "utf8")) as E2ERunState;
}

function testResult(input: Omit<E2ETestResult, "durationMs"> & { durationMs?: number }): E2ETestResult {
  return { durationMs: input.durationMs ?? 0, ...input };
}

async function waitCompleted(
  exclusive: Exclusive,
  turns: TurnManager,
  turnId: string,
  timeoutMs = 90_000
): Promise<TurnView> {
  const deadline = Date.now() + timeoutMs;
  let latest = await exclusive(() => turns.getReply(turnId));
  while (
    Date.now() < deadline &&
    latest.status !== "completed" &&
    latest.status !== "error" &&
    latest.status !== "stopped" &&
    !latest.paused
  ) {
    const slice = Math.min(30_000, Math.max(1_000, deadline - Date.now()));
    latest = await exclusive(() => turns.wait(turnId, slice));
  }
  return latest;
}

function manifestDiagnostic(turn: TurnView): string {
  const manifest = turn.manifest;
  if (!manifest) {
    return "response=" + JSON.stringify(turn.response ?? null) + "; manifest=null";
  }
  const parts = manifest.parts.map((part) => {
    if (part.type === "code") {
      return "code(language=" + JSON.stringify(part.language) + ", text=" + JSON.stringify(part.text.slice(0, 160)) + ")";
    }
    if (part.type === "table") {
      return "table(headers=" + JSON.stringify(part.headers) + ", rows=" + JSON.stringify(part.rows.slice(0, 3)) + ")";
    }
    if (part.type === "text") {
      return "text(" + JSON.stringify(part.text.slice(0, 160)) + ")";
    }
    return part.type;
  });
  return (
    "response=" +
    JSON.stringify((turn.response ?? "").slice(0, 500)) +
    "; plainText=" +
    JSON.stringify(manifest.plainText.slice(0, 500)) +
    "; codeBlockCount=" +
    manifest.codeBlockCount +
    "; parts=[" +
    parts.join(", ") +
    "]"
  );
}

function manifestHasStructuredContract(turn: TurnView, expectedText: string): boolean {
  const manifest = turn.manifest;
  if (!manifest) return false;
  const hasText =
    manifest.plainText.includes(expectedText) ||
    manifest.parts.some(
      (part) => part.type === "text" && part.text.includes(expectedText)
    );
  const hasCode = manifest.parts.some(
    (part) =>
      part.type === "code" &&
      /python/i.test(part.language ?? "") &&
      part.text.includes("print('CGW')")
  );
  const hasTable = manifest.parts.some(
    (part) =>
      part.type === "table" &&
      part.headers[0] === "A" &&
      part.headers[1] === "B" &&
      part.rows.some((row) => row[0] === "1" && row[1] === "2")
  );
  return hasText && hasCode && hasTable && manifest.codeBlockCount >= 1;
}

function selectionCandidate(capabilities: ChatGptCapabilities): {
  model?: string;
  effort?: string;
} | null {
  const model = capabilities.modelPicker.current?.trim() || undefined;
  if (!model || !capabilities.modelPicker.options.includes(model)) return null;

  const effort = capabilities.effortPicker.current?.trim() || undefined;
  const effortUsable =
    effort && capabilities.effortPicker.options.includes(effort) ? effort : undefined;

  return { model, ...(effortUsable ? { effort: effortUsable } : {}) };
}

export class E2ERunner {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly client: ChatGptWebClient,
    private readonly turns: TurnManager,
    private readonly config: AppConfig,
    private readonly exclusive: Exclusive
  ) {}

  start(input: {
    workspaceId: string;
    workspaceName?: string;
    includeSelection?: boolean;
  }): E2ERunState {
    if (this.active.size > 0) {
      throw new Error("An E2E run is already active in this MCP process.");
    }

    const runId = "e2e_" + randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    const state: E2ERunState = {
      version: 1,
      runId,
      status: "running",
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName ?? null,
      includeSelection: input.includeSelection ?? true,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      projectId: null,
      tests: [],
      summary: { pass: 0, fail: 0, blocked: 0, notRun: 0 },
      reportPath: reportPath(this.config.stateDir, runId),
    };
    writeState(this.config.stateDir, state);

    const task = this.run(state).finally(() => {
      this.active.delete(runId);
    });
    this.active.set(runId, task);
    return state;
  }

  latest(): E2ERunState | null {
    const dir = e2eDir(this.config.stateDir);
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^e2e_[a-f0-9]{16}\.json$/.test(name))
      .map((name) => ({
        name,
        stat: fs.statSync(path.join(dir, name)),
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = files[0];
    if (!latest) return null;
    return this.status(latest.name.slice(0, -5));
  }

  status(runId: string): E2ERunState {
    const state = readState(this.config.stateDir, runId);
    if (state.status === "running" && !this.active.has(runId)) {
      state.status = "interrupted";
      state.completedAt = new Date().toISOString();
      writeState(this.config.stateDir, state);
    }
    return state;
  }

  report(runId: string): { state: E2ERunState; markdown: string } {
    const state = this.status(runId);
    return { state, markdown: fs.readFileSync(state.reportPath, "utf8") };
  }

  private append(state: E2ERunState, result: E2ETestResult): void {
    state.tests.push(result);
    writeState(this.config.stateDir, state);
  }

  private async step(
    state: E2ERunState,
    meta: { id: string; name: string; expected: string },
    fn: () => Promise<{
      observed: string;
      requestId?: string | null;
      turnId?: string | null;
      projectId?: string | null;
    }>
  ): Promise<boolean> {
    const started = Date.now();
    try {
      const result = await fn();
      this.append(
        state,
        testResult({
          ...meta,
          status: "PASS",
          durationMs: Date.now() - started,
          observed: result.observed,
          errorCode: null,
          errorMessage: null,
          requestId: result.requestId ?? null,
          turnId: result.turnId ?? null,
          projectId: result.projectId ?? state.projectId,
        })
      );
      return true;
    } catch (error) {
      const info = errorInfo(error);
      const blocked = ["AUTH_REQUIRED", "CHALLENGE_REQUIRED", "RATE_LIMITED"].includes(
        info.code ?? ""
      );
      this.append(
        state,
        testResult({
          ...meta,
          status: blocked ? "BLOCKED" : "FAIL",
          durationMs: Date.now() - started,
          observed: blocked ? "Human/account action required." : "Operation failed.",
          errorCode: info.code,
          errorMessage: info.message,
          requestId: null,
          turnId: null,
          projectId: state.projectId,
        })
      );
      if (blocked) state.status = "blocked";
      return false;
    }
  }

  private notRun(
    state: E2ERunState,
    id: string,
    name: string,
    expected: string,
    observed: string
  ): void {
    this.append(
      state,
      testResult({
        id,
        name,
        status: "NOT_RUN",
        expected,
        observed,
        errorCode: null,
        errorMessage: null,
        requestId: null,
        turnId: null,
        projectId: state.projectId,
      })
    );
  }

  private async runLocalSafetyChecks(state: E2ERunState): Promise<void> {
    await this.step(
      state,
      {
        id: "H1",
        name: "Missing workspace is rejected before ChatGPT send",
        expected: "WORKSPACE_REQUIRED",
      },
      async () => {
        const requestId = state.runId + ":missing-workspace";
        try {
          await this.exclusive(() =>
            this.turns.send({
              requestId,
              prompt: "THIS MUST NOT BE SENT",
            })
          );
        } catch (error) {
          const info = errorInfo(error);
          if (info.code === "WORKSPACE_REQUIRED") {
            return { observed: "WORKSPACE_REQUIRED returned locally.", requestId };
          }
          throw error;
        }
        throw new Error("Missing workspace request was unexpectedly accepted.");
      }
    );

    await this.step(
      state,
      {
        id: "H2",
        name: "Unknown turn is rejected",
        expected: "TURN_NOT_FOUND",
      },
      async () => {
        try {
          await this.exclusive(() =>
            this.turns.getReply("turn_000000000000000000000000")
          );
        } catch (error) {
          const info = errorInfo(error);
          if (info.code === "TURN_NOT_FOUND") {
            return { observed: "TURN_NOT_FOUND returned locally." };
          }
          throw error;
        }
        throw new Error("Unknown turn_id was unexpectedly accepted.");
      }
    );
  }

  private async run(state: E2ERunState): Promise<void> {
    try {
      const statusOk = await this.step(
        state,
        {
          id: "A1",
          name: "Authenticated ChatGPT Web status",
          expected: "authenticated=true, uiReady=true, ui.state=ready",
        },
        async () => {
          const status = await this.exclusive(() => this.client.status());
          if (!status.authenticated) {
            const error = new Error("ChatGPT login is required.") as Error & { code?: string };
            error.code = "AUTH_REQUIRED";
            throw error;
          }
          if (!status.uiReady || status.ui.state !== "ready") {
            throw new Error(
              "Expected ready UI, got authenticated=" +
                status.authenticated +
                ", uiReady=" +
                status.uiReady +
                ", state=" +
                status.ui.state
            );
          }
          return { observed: "Authenticated and ready." };
        }
      );
      if (!statusOk && state.status === "blocked") return;

      const bindOk = await this.step(
        state,
        {
          id: "B1",
          name: "Workspace binding and Project-only memory",
          expected: "ready binding with project-only memory",
        },
        async () => {
          const binding = await this.exclusive(() =>
            this.client.bindWorkspaceProject({
              workspaceId: state.workspaceId,
              ...(state.workspaceName ? { workspaceName: state.workspaceName } : {}),
              namingMode: "workspace-name",
            })
          );
          if (
            binding.status !== "ready" ||
            binding.memoryMode !== "project-only" ||
            !binding.memoryVerifiedAt
          ) {
            throw new Error("Binding was not ready with verified Project-only memory.");
          }
          state.projectId = binding.projectId;
          writeState(this.config.stateDir, state);
          return {
            observed:
              "ready; memory=" +
              binding.memoryMode +
              "; source=" +
              (binding.memoryVerificationSource ?? "unknown"),
            projectId: binding.projectId,
          };
        }
      );
      if (!bindOk && state.status === "blocked") return;

      if (state.projectId) {
        await this.step(
          state,
          {
            id: "B2",
            name: "Repeated workspace binding is idempotent",
            expected: "same projectId; no duplicate Project",
          },
          async () => {
            const binding = await this.exclusive(() =>
              this.client.bindWorkspaceProject({
                workspaceId: state.workspaceId,
                ...(state.workspaceName ? { workspaceName: state.workspaceName } : {}),
                namingMode: "workspace-name",
              })
            );
            if (binding.projectId !== state.projectId) {
              throw new Error(
                "Project changed from " + state.projectId + " to " + binding.projectId
              );
            }
            return { observed: "Same projectId returned.", projectId: binding.projectId };
          }
        );
      } else {
        this.notRun(state, "B2", "Repeated workspace binding is idempotent", "same projectId", "No projectId from B1.");
      }

      let capabilities: ChatGptCapabilities | null = null;
      await this.step(
        state,
        {
          id: "E1",
          name: "Live model/effort capability discovery",
          expected: "capabilities call succeeds without changing the conversation",
        },
        async () => {
          const discovered = await this.exclusive(() => this.client.capabilities());
          if (!discovered.modelPicker.found || discovered.modelPicker.options.length === 0) {
            throw new Error(
              "Model capability discovery returned no usable model options: current=" +
                (discovered.modelPicker.current ?? "-") +
                ", found=" +
                discovered.modelPicker.found +
                ", options=" +
                discovered.modelPicker.options.length
            );
          }
          capabilities = discovered;
          return {
            observed:
              "model=" +
              (discovered.modelPicker.current ?? "-") +
              "; models=" +
              discovered.modelPicker.options.length +
              "; effort=" +
              (discovered.effortPicker.current ?? "-"),
          };
        }
      );

      if (!bindOk) {
        this.notRun(state, "C1", "Idempotent send", "same deduplicated turn", "B1 workspace binding failed.");
        this.notRun(state, "C2", "Wait for idempotency response", "completed exact response", "B1 workspace binding failed.");
        this.notRun(state, "C3", "Request-id conflict is rejected locally", "REQUEST_ID_CONFLICT", "B1 workspace binding failed.");
        this.notRun(state, "D1", "Completed turn recovery", "same completed response", "B1 workspace binding failed.");
        this.notRun(state, "F1", "Structured response extraction", "text + code + table manifest", "B1 workspace binding failed.");
        this.notRun(state, "G1", "Staged text attachment upload and readback", "exact sentinel response", "B1 workspace binding failed.");
        this.notRun(
          state,
          "E2",
          "Explicit current model/effort selection smoke",
          "one short send using the current selection",
          "B1 workspace binding failed."
        );
        this.notRun(
          state,
          "I1",
          "Workspace Project isolation across E2E sends",
          "every real send stays on the bound projectId",
          "No bound Project was established."
        );
        await this.runLocalSafetyChecks(state);
        return;
      }

      // Keep the real ChatGPT message budget to ONE per E2E run. The same
      // turn simultaneously exercises idempotency, structured extraction,
      // attachment upload/readback, explicit current selection, recovery, and
      // Project isolation. All other checks stay local/read-only.
      const compactRequest = state.runId + ":compact";
      const attachmentSentinel = "ATTACHMENT_SENTINEL_7F3A";
      const selection =
        state.includeSelection && capabilities
          ? selectionCandidate(capabilities)
          : null;
      let stagedId: string | null = null;
      let compactTurnId: string | null = null;
      let compactTurn: TurnView | null = null;

      const compactInput = {
        requestId: compactRequest,
        workspaceId: state.workspaceId,
        prompt:
          "Read the attached file. Return exactly these three items and nothing else:\n" +
          "1. The exact contents of the attached file as a single plain-text line.\n" +
          "2. A fenced python code block containing exactly: print('CGW')\n" +
          "3. A markdown table with columns A and B and one data row 1 and 2.",
        ...(selection?.model ? { model: selection.model } : {}),
        ...(selection?.effort ? { effort: selection.effort } : {}),
      };

      const compactSent = await this.step(
        state,
        {
          id: "C1",
          name: "Single-send idempotent E2E dispatch",
          expected:
            "one real ChatGPT message; second identical request is deduplicated locally",
        },
        async () => {
          const staged = this.client.stageTextInput({
            filename: "cgw-e2e-sentinel.txt",
            content: attachmentSentinel,
            mime: "text/plain",
          });
          stagedId = staged.inputAssetId;

          const input = {
            ...compactInput,
            inputAssetIds: [staged.inputAssetId],
          };
          const first = await this.exclusive(() => this.turns.send(input));
          compactTurnId = first.turnId;
          const second = await this.exclusive(() => this.turns.send(input));
          if (!second.deduplicated || first.turnId !== second.turnId) {
            throw new Error(
              "Duplicate request did not resolve to the same deduplicated turn."
            );
          }
          return {
            observed:
              "One combined remote turn dispatched; identical retry returned the same turn with deduplicated=true.",
            requestId: compactRequest,
            turnId: first.turnId,
            projectId: first.projectId,
          };
        }
      );

      if (!compactSent || !compactTurnId) {
        if (stagedId) this.client.discardStagedInput(stagedId);
        this.notRun(state, "C2", "Wait for combined E2E response", "completed combined turn", "C1 dispatch failed.");
        this.notRun(state, "C3", "Request-id conflict is rejected locally", "REQUEST_ID_CONFLICT", "C1 dispatch failed.");
        this.notRun(state, "D1", "Completed turn recovery", "same completed response", "C1 dispatch failed.");
        this.notRun(state, "F1", "Structured response extraction", "text + code + table manifest", "C1 dispatch failed.");
        this.notRun(state, "G1", "Staged text attachment upload and readback", "attached sentinel appears in response", "C1 dispatch failed.");
        this.notRun(
          state,
          "E2",
          "Explicit current model/effort selection smoke",
          "combined send accepts the currently selected explicit model/effort",
          "C1 dispatch failed."
        );
        this.notRun(
          state,
          "I1",
          "Workspace Project isolation across E2E sends",
          "combined real send stays on the bound projectId",
          "C1 dispatch failed."
        );
        await this.runLocalSafetyChecks(state);
        return;
      }

      await this.step(
        state,
        {
          id: "C2",
          name: "Wait for combined E2E response",
          expected: "combined turn completes inside the bound Project",
        },
        async () => {
          compactTurn = await waitCompleted(
            this.exclusive,
            this.turns,
            compactTurnId!
          );
          if (compactTurn.status !== "completed") {
            throw new Error("Combined turn did not complete: " + compactTurn.status);
          }
          if (state.projectId && compactTurn.projectId !== state.projectId) {
            throw new Error("Combined turn escaped the bound Project.");
          }
          return {
            observed: "Combined remote turn completed.",
            requestId: compactRequest,
            turnId: compactTurn.turnId,
            projectId: compactTurn.projectId,
          };
        }
      );

      // Upload is complete once dispatch returns. Remove the local staged copy
      // before running the purely local/read-only assertions below.
      if (stagedId) {
        this.client.discardStagedInput(stagedId);
        stagedId = null;
      }

      await this.step(
        state,
        {
          id: "C3",
          name: "Request-id conflict is rejected locally",
          expected: "REQUEST_ID_CONFLICT without sending another ChatGPT message",
        },
        async () => {
          try {
            await this.exclusive(() =>
              this.turns.send({
                requestId: compactRequest,
                workspaceId: state.workspaceId,
                prompt: "THIS MUST NOT BE SENT",
              })
            );
          } catch (error) {
            const info = errorInfo(error);
            if (info.code === "REQUEST_ID_CONFLICT") {
              return {
                observed: "REQUEST_ID_CONFLICT returned before dispatch.",
                requestId: compactRequest,
                turnId: compactTurnId,
                projectId: state.projectId,
              };
            }
            throw error;
          }
          throw new Error("Conflicting request_id was unexpectedly accepted.");
        }
      );

      if (compactTurn?.status === "completed") {
        await this.step(
          state,
          {
            id: "D1",
            name: "Completed turn recovery",
            expected: "getReply recovers the same combined response without resending",
          },
          async () => {
            const recovered = await this.exclusive(() =>
              this.turns.getReply(compactTurnId!)
            );
            if (
              recovered.status !== "completed" ||
              recovered.response !== compactTurn!.response
            ) {
              throw new Error("Completed combined turn could not be recovered exactly.");
            }
            return {
              observed: "Recovered the same completed combined turn.",
              requestId: compactRequest,
              turnId: recovered.turnId,
              projectId: recovered.projectId,
            };
          }
        );

        await this.step(
          state,
          {
            id: "F1",
            name: "Structured response extraction",
            expected: "attachment text + python code + markdown table in manifest",
          },
          async () => {
            if (!manifestHasStructuredContract(compactTurn!, attachmentSentinel)) {
              throw new Error(
                "Manifest did not contain the required text/code/table contract. " +
                  manifestDiagnostic(compactTurn!)
              );
            }
            return {
              observed: "Combined manifest contains text, python code, and table parts.",
              requestId: compactRequest,
              turnId: compactTurnId,
              projectId: compactTurn!.projectId,
            };
          }
        );

        await this.step(
          state,
          {
            id: "G1",
            name: "Staged text attachment upload and readback",
            expected: "response contains the sentinel that appeared only in the attachment",
          },
          async () => {
            const body =
              compactTurn!.manifest?.plainText ??
              compactTurn!.response ??
              "";
            if (!body.includes(attachmentSentinel)) {
              throw new Error(
                "Combined response did not reproduce the attached sentinel. " +
                  manifestDiagnostic(compactTurn!)
              );
            }
            return {
              observed: "Attached sentinel was read back in the combined response.",
              requestId: compactRequest,
              turnId: compactTurnId,
              projectId: compactTurn!.projectId,
            };
          }
        );

        if (state.includeSelection) {
          if (!selection?.model) {
            this.notRun(
              state,
              "E2",
              "Explicit current model/effort selection smoke",
              "combined send explicitly names the current visible selection",
              "Current model could not be mapped exactly to a visible option."
            );
          } else {
            await this.step(
              state,
              {
                id: "E2",
                name: "Explicit current model/effort selection smoke",
                expected:
                  "the same combined send succeeds with explicit current model/effort metadata",
              },
              async () => {
                if (compactTurn!.requestedModel !== selection.model) {
                  throw new Error(
                    "requestedModel mismatch: expected " +
                      selection.model +
                      ", got " +
                      String(compactTurn!.requestedModel)
                  );
                }
                if (
                  selection.effort &&
                  compactTurn!.requestedEffort !== selection.effort
                ) {
                  throw new Error(
                    "requestedEffort mismatch: expected " +
                      selection.effort +
                      ", got " +
                      String(compactTurn!.requestedEffort)
                  );
                }
                return {
                  observed:
                    "Combined send accepted explicit current selection: model=" +
                    selection.model +
                    (selection.effort ? ", effort=" + selection.effort : ""),
                  requestId: compactRequest,
                  turnId: compactTurnId,
                  projectId: compactTurn!.projectId,
                };
              }
            );
          }
        } else {
          this.notRun(
            state,
            "E2",
            "Explicit current model/effort selection smoke",
            "combined send explicitly names the current selection",
            "Disabled by caller."
          );
        }

        await this.step(
          state,
          {
            id: "I1",
            name: "Workspace Project isolation across E2E sends",
            expected: "the single combined real send stays on the bound projectId",
          },
          async () => {
            if (!state.projectId || compactTurn!.projectId !== state.projectId) {
              throw new Error(
                "Combined turn project mismatch: expected " +
                  String(state.projectId) +
                  ", got " +
                  String(compactTurn!.projectId)
              );
            }
            return {
              observed: "The combined real send stayed on the bound Project.",
              requestId: compactRequest,
              turnId: compactTurnId,
              projectId: compactTurn!.projectId,
            };
          }
        );
      } else {
        this.notRun(state, "D1", "Completed turn recovery", "same completed response", "C2 did not produce a completed turn.");
        this.notRun(state, "F1", "Structured response extraction", "text + code + table manifest", "C2 did not produce a completed turn.");
        this.notRun(state, "G1", "Staged text attachment upload and readback", "attached sentinel appears in response", "C2 did not produce a completed turn.");
        this.notRun(state, "E2", "Explicit current model/effort selection smoke", "combined send accepts explicit current selection", "C2 did not produce a completed turn.");
        this.notRun(state, "I1", "Workspace Project isolation across E2E sends", "combined real send stays on the bound projectId", "C2 did not produce a completed turn.");
      }

      await this.runLocalSafetyChecks(state);
    } catch (error) {
      const info = errorInfo(error);
      this.append(
        state,
        testResult({
          id: "Z0",
          name: "E2E runner internal integrity",
          status: "FAIL",
          expected: "runner continues and writes a terminal report",
          observed: "Unexpected runner-level exception.",
          errorCode: info.code,
          errorMessage: info.message,
          requestId: null,
          turnId: null,
          projectId: state.projectId,
        })
      );
    } finally {
      if (state.status === "running") state.status = "completed";
      state.completedAt = new Date().toISOString();
      writeState(this.config.stateDir, state);
    }
  }
}
