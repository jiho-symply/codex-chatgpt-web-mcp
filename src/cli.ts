#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, CHATGPT_ORIGIN } from "./config.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { ChatGptWebClient } from "./browser/chatgpt.js";
import { TurnManager } from "./turns/manager.js";
import { TurnStore } from "./turns/store.js";
import { runMcpServer } from "./mcp/server.js";
import { PRODUCT_NAME, VERSION } from "./version.js";

const program = new Command();

program
  .name("cgw")
  .description("Browser-backed ChatGPT Web MCP server for Codex")
  .version(VERSION);

function say(value: unknown): void {
  process.stdout.write(
    typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n"
  );
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError("expected an integer");
  return parsed;
}

function hasInteractiveDisplay(): boolean {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function withContext<T>(
  headless: boolean,
  fn: (
    client: ChatGptWebClient,
    runtime: BrowserRuntime,
    turns: TurnManager
  ) => Promise<T>
): Promise<T> {
  const config = loadConfig({ headless });
  const runtime = new BrowserRuntime(config);
  const client = new ChatGptWebClient(runtime, config);
  const turns = new TurnManager(client, new TurnStore(config.stateDir));
  try {
    return await fn(client, runtime, turns);
  } finally {
    await runtime.close();
  }
}

program
  .command("mcp", { isDefault: true })
  .description("Run the MCP server over stdio")
  .action(async () => {
    await runMcpServer(loadConfig());
  });

program
  .command("login")
  .description("Open a headed persistent browser for manual ChatGPT login")
  .action(async () => {
    if (!hasInteractiveDisplay()) {
      throw new Error(
        "No graphical display is available. Initial login requires a visible browser. " +
          "Use SSH X11 forwarding or a temporary trusted VNC/noVNC desktop. " +
          "See docs/headless-linux.md."
      );
    }
    if (!process.stdin.isTTY) {
      throw new Error("cgw login requires an interactive terminal.");
    }

    await withContext(false, async (client, runtime) => {
      const page = await runtime.page();
      await page.goto(CHATGPT_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });

      const before = await client.status();
      if (before.authenticated) {
        say("ChatGPT is already authenticated in this browser profile.");
        return;
      }

      say("Complete ChatGPT login in the opened browser.");
      say("Handle password, CAPTCHA, and 2FA directly on the website.");
      say("This CLI never asks for or stores those credentials separately.");

      const readline = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>((resolve) => {
        readline.question("Press Enter after the ChatGPT composer is visible... ", () => resolve());
      });
      readline.close();

      const after = await client.status();
      if (!after.authenticated) {
        throw new Error(
          "ChatGPT composer is still unavailable. Login may be incomplete or the UI may have changed."
        );
      }
      say("Authentication confirmed. The persistent profile is ready for headless use.");
    });
  });

program
  .command("doctor")
  .description("Verify Playwright, browser profile, authentication, and ChatGPT UI")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    const result = await withContext(true, (client) => client.status());
    if (opts.json) {
      say({ ok: result.authenticated && result.uiReady, ...result });
      return;
    }
    say(PRODUCT_NAME + " " + VERSION);
    say("Authenticated: " + (result.authenticated ? "yes" : "no"));
    say("UI ready: " + (result.uiReady ? "yes" : "no"));
    say("Headless: " + (result.headless ? "yes" : "no"));
    if (!result.authenticated) {
      process.exitCode = 1;
      say("Run cgw login from an interactive graphical session.");
    }
  });

program
  .command("models")
  .description("Show model/effort choices discovered from the live ChatGPT Web UI")
  .action(async () => {
    say(await withContext(true, (client) => client.capabilities()));
  });

program
  .command("send")
  .description("Send a turn without waiting for completion")
  .argument("<prompt>", "prompt text")
  .requiredOption("--request-id <id>", "idempotency key; reuse to prevent duplicate sends")
  .option("--conversation <id>")
  .option("--model <label>")
  .option("--effort <label>")
  .action(
    async (
      prompt: string,
      opts: { requestId: string; conversation?: string; model?: string; effort?: string }
    ) => {
      say(
        await withContext(true, (_client, _runtime, turns) =>
          turns.send({
            requestId: opts.requestId,
            prompt,
            ...(opts.conversation ? { conversationId: opts.conversation } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
          })
        )
      );
    }
  );

program
  .command("wait")
  .description("Wait for a bounded slice of an existing turn")
  .argument("<turn-id>")
  .option("--timeout-ms <n>", "wait slice, 1000-120000 ms", parseInteger, 30_000)
  .action(async (turnId: string, opts: { timeoutMs: number }) => {
    say(
      await withContext(true, (_client, _runtime, turns) =>
        turns.wait(turnId, Math.max(1_000, Math.min(120_000, opts.timeoutMs)))
      )
    );
  });

program
  .command("get-reply")
  .description("Inspect the current reply for an existing turn without sending")
  .argument("<turn-id>")
  .action(async (turnId: string) => {
    say(await withContext(true, (_client, _runtime, turns) => turns.getReply(turnId)));
  });

program
  .command("stop")
  .description("Stop generation for an existing turn")
  .argument("<turn-id>")
  .action(async (turnId: string) => {
    say(await withContext(true, (_client, _runtime, turns) => turns.stop(turnId)));
  });

program
  .command("chat")
  .description("Compatibility command: send and wait for a ChatGPT Web response")
  .argument("<prompt>", "prompt text")
  .option("--request-id <id>", "optional idempotency key")
  .option("--conversation <id>")
  .option("--model <label>")
  .option("--effort <label>")
  .option("--timeout-ms <n>", "overall generation timeout", parseInteger, 180_000)
  .action(
    async (
      prompt: string,
      opts: {
        requestId?: string;
        conversation?: string;
        model?: string;
        effort?: string;
        timeoutMs: number;
      }
    ) => {
      const result = await withContext(true, (_client, _runtime, turns) =>
        turns.chat({
          prompt,
          timeoutMs: Math.max(10_000, Math.min(600_000, opts.timeoutMs)),
          ...(opts.requestId ? { requestId: opts.requestId } : {}),
          ...(opts.conversation ? { conversationId: opts.conversation } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        })
      );
      say(result);
      if (result.timedOut || result.paused || result.status === "error") process.exitCode = 2;
    }
  );

program
  .command("codex-config")
  .description("Print the Codex config.toml MCP block for this build")
  .action(() => {
    const cliPath = fileURLToPath(import.meta.url);
    const nodePath = process.execPath;
    const toml = (value: string): string =>
      value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

    say(
      [
        "[mcp_servers.chatgpt_web]",
        "command = \"" + toml(nodePath) + "\"",
        "args = [\"" + toml(cliPath) + "\", \"mcp\"]",
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 600",
      ].join("\n")
    );
  });

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write("Error: " + error.message + "\n");
  process.exitCode = 1;
});
