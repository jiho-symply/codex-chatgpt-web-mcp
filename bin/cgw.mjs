#!/usr/bin/env node

import { register } from "tsx/esm/api";

register();

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "mcp") {
    await import("../src/mcp-entry.ts");
  } else {
    await import("../src/cli.ts");
  }
} catch (error) {
  process.stderr.write(
    "Error: " + (error instanceof Error ? error.message : String(error)) + "\n"
  );
  process.exitCode = 1;
}
