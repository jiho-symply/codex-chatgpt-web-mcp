import { loadConfig } from "./config.js";
import { runMcpServer } from "./mcp/server.js";

await runMcpServer(loadConfig());
