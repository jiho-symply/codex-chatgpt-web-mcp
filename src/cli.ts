#!/usr/bin/env node

import { Command } from "commander";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, CHATGPT_ORIGIN } from "./config.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { ChatGptWebClient } from "./browser/chatgpt.js";
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

function hasInteractiveDisplay(): boolean {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function withClient<T>(
  headless: boolean,
  fn: (client: ChatGptWebClient, runtime: BrowserRuntime) => Promise<T>
): Promise<T> {
  const config = loadConfig({ headless });
  const runtime = new BrowserRuntime(config);
  const client = new ChatGptWebClient(runtime, config);
  try {
    return await fn(client, runtime);
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

    await withClient(false, async (client, runtime) => {
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
    const result = await withClient(true, (client) => client.status());
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
    say(await withClient(true, (client) => client.capabilities()));
  });

program
  .command("chat")
  .description("Send a one-off ChatGPT Web message for diagnostics")
  .argument("<prompt>", "prompt text")
  .option("--conversation <id>")
  .option("--model <label>")
  .option("--effort <label>")
  .option("--timeout-ms <n>", "generation timeout", (value) => Number.parseInt(value, 10))
  .action(
    async (
      prompt: string,
      opts: { conversation?: string; model?: string; effort?: string; timeoutMs?: number }
    ) => {
      const result = await withClient(true, (client) =>
        client.chat({
          prompt,
          ...(opts.conversation ? { conversationId: opts.conversation } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        })
      );
      say(result);
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
