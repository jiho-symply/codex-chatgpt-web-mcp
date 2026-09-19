import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const child = spawn(process.execPath, ["bin/cgw.mjs", "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const started = performance.now();
let stdout = "";
let stderr = "";

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cgw-startup-smoke", version: "1.0" },
  },
};

child.stdin.write(JSON.stringify(initialize) + "\n");

const deadlineMs = 10_000;
const poll = setInterval(() => {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const message = JSON.parse(line);
      if (message?.id === 1 && message?.result) {
        const elapsed = Math.round(performance.now() - started);
        clearInterval(poll);
        clearTimeout(timeout);
        child.kill();
        process.stdout.write("MCP initialized in " + elapsed + " ms\n");
        process.exitCode = 0;
        return;
      }
    } catch {
      // Wait for a complete JSON line.
    }
  }
}, 25);

const timeout = setTimeout(() => {
  clearInterval(poll);
  child.kill();
  process.stderr.write(
    "MCP did not initialize within " +
      deadlineMs +
      " ms.\nstdout:\n" +
      stdout +
      "\nstderr:\n" +
      stderr +
      "\n"
  );
  process.exitCode = 1;
}, deadlineMs);
