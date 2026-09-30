#!/usr/bin/env node

// MCP stdio server. stdout is reserved for protocol messages.
// Diagnostics belong on stderr.

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./lib/server.js";

const handle = serveStdio(createServer);

console.error("cursor-mcp: stdio server ready");

process.on("SIGINT", () => {
    Promise.resolve(handle.close()).finally(() => {
        process.exit(0);
    });
});
