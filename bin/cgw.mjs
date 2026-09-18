#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const result = spawnSync(
  process.execPath,
  [tsxCli, cli, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  }
);

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
