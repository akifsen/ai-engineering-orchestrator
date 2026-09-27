import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const bridgeDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const entrypoint = path.join(bridgeDirectory, "index.js");

class NdjsonReader {
    constructor(stream) {
        this.buffer = "";
        this.messages = [];
        this.waiters = [];
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            this.buffer += chunk;
            const lines = this.buffer.split(/\r?\n/);
            this.buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    message = { nonJson: line };
                }

                const waiter = this.waiters.shift();
                if (waiter) {
                    waiter.resolve(message);
                } else {
                    this.messages.push(message);
                }
            }
        });
    }

    next(timeoutMs) {
        if (this.messages.length > 0) {
            return Promise.resolve(this.messages.shift());
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
                reject(new Error("timed out waiting for an MCP message"));
            }, timeoutMs);

            this.waiters.push({
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                }
            });
        });
    }
}

test("stdio server starts and exposes delegate_antigravity", { timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, [entrypoint], {
        cwd: bridgeDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false
    });
    const stdout = new NdjsonReader(child.stdout);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    const exitPromise = once(child, "exit");
    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
                name: "antigravity-mcp-test",
                version: "1.0.0"
            }
        }
    })}\n`);

    try {
        const initialized = await stdout.next(15_000);
        assert.equal(initialized.nonJson, undefined);
        assert.equal(initialized.id, 1);
        assert.equal(initialized.error, undefined);
        assert.equal(initialized.result.serverInfo.name, "antigravity-mcp");

        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized"
        })}\n`);
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {}
        })}\n`);

        const tools = await stdout.next(15_000);
        assert.equal(tools.id, 2);
        const names = tools.result.tools.map((tool) => tool.name);
        assert.deepEqual(names, ["delegate_antigravity"]);
        const tool = tools.result.tools[0];
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.ok(tool.description.includes("Implementation Engineer"));
        assert.ok(tool.inputSchema.properties.prompt);
        assert.ok(tool.inputSchema.properties.cwd);
        assert.ok(tool.inputSchema.required.includes("prompt"));
        assert.ok(tool.inputSchema.required.includes("cwd"));
        assert.equal(stderr.includes("antigravity-mcp: stdio server ready"), true);
        assert.equal(JSON.stringify(initialized).includes("stdio server ready"), false);
    } finally {
        child.kill();
        child.stdin.end();
        await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, 2_000))
        ]);
    }
});
