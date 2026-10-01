import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const bridgeDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const entrypoint = path.join(bridgeDirectory, "index.js");
const packageVersion = JSON.parse(readFileSync(path.join(bridgeDirectory, "package.json"), "utf8")).version;

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

test("stdio server starts and exposes delegate_antigravity, apply_delegation, and discard_delegation", { timeout: 20_000 }, async () => {
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
                version: "1.1.0"
            }
        }
    })}\n`);

    try {
        const initialized = await stdout.next(15_000);
        assert.equal(initialized.nonJson, undefined);
        assert.equal(initialized.id, 1);
        assert.equal(initialized.error, undefined);
        assert.equal(initialized.result.serverInfo.name, "antigravity-mcp");
        assert.equal(initialized.result.serverInfo.version, packageVersion);
        assert.ok(initialized.result.instructions.toLowerCase().includes("parallel delegations must use isolation \"worktree\""));
        assert.ok(initialized.result.instructions.includes("apply_delegation"));
        assert.ok(initialized.result.instructions.includes("discard_delegation"));
        assert.ok(initialized.result.instructions.includes("apply_conflict is not a revision"));

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
        assert.deepEqual(names, [
            "delegate_antigravity",
            "apply_delegation",
            "discard_delegation"
        ]);

        const delegateTool = tools.result.tools.find((t) => t.name === "delegate_antigravity");
        assert.equal(delegateTool.annotations.readOnlyHint, false);
        assert.equal(delegateTool.annotations.destructiveHint, false);
        assert.equal(delegateTool.annotations.idempotentHint, false);
        assert.equal(delegateTool.annotations.openWorldHint, true);
        assert.ok(delegateTool.description.includes("Implementation Engineer"));
        assert.ok(delegateTool.description.includes("worktree"));
        assert.ok(delegateTool.inputSchema.properties.prompt);
        assert.ok(delegateTool.inputSchema.properties.cwd);
        assert.ok(delegateTool.inputSchema.properties.isolation);
        assert.deepEqual(delegateTool.inputSchema.properties.isolation.enum, ["none", "worktree"]);
        assert.ok(delegateTool.inputSchema.properties.delegationId);
        assert.ok(delegateTool.inputSchema.required.includes("prompt"));
        assert.ok(delegateTool.inputSchema.required.includes("cwd"));
        assert.equal(delegateTool.inputSchema.required.includes("isolation"), false);
        assert.equal(delegateTool.inputSchema.required.includes("delegationId"), false);

        const applyTool = tools.result.tools.find((t) => t.name === "apply_delegation");
        assert.equal(applyTool.title, "Apply isolated delegation");
        assert.equal(applyTool.annotations.readOnlyHint, false);
        assert.equal(applyTool.annotations.destructiveHint, true);
        assert.equal(applyTool.annotations.idempotentHint, false);
        assert.equal(applyTool.annotations.openWorldHint, false);
        assert.ok(applyTool.inputSchema.properties.cwd);
        assert.ok(applyTool.inputSchema.properties.delegationId);
        assert.ok(applyTool.inputSchema.required.includes("cwd"));
        assert.ok(applyTool.inputSchema.required.includes("delegationId"));

        const discardTool = tools.result.tools.find((t) => t.name === "discard_delegation");
        assert.equal(discardTool.title, "Discard isolated delegation");
        assert.equal(discardTool.annotations.readOnlyHint, false);
        assert.equal(discardTool.annotations.destructiveHint, true);
        assert.equal(discardTool.annotations.idempotentHint, true);
        assert.equal(discardTool.annotations.openWorldHint, false);
        assert.ok(discardTool.inputSchema.properties.cwd);
        assert.ok(discardTool.inputSchema.properties.delegationId);
        assert.ok(discardTool.inputSchema.required.includes("cwd"));
        assert.ok(discardTool.inputSchema.required.includes("delegationId"));

        assert.equal(stderr.includes("antigravity-mcp: stdio server ready"), true);
        assert.equal(JSON.stringify(initialized).includes("stdio server ready"), false);

        // Rejection via schema error when delegationId regex fails
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "apply_delegation",
                arguments: {
                    cwd: bridgeDirectory,
                    delegationId: "invalid"
                }
            }
        })}\n`);

        const callRes1 = await stdout.next(15_000);
        assert.equal(callRes1.id, 3);
        assert.equal(Boolean(callRes1.error || callRes1.result?.isError), true);

        // Rejection via validation_failure when delegationId does not exist
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
                name: "apply_delegation",
                arguments: {
                    cwd: bridgeDirectory,
                    delegationId: "0123456789"
                }
            }
        })}\n`);

        const callRes2 = await stdout.next(15_000);
        assert.equal(callRes2.id, 4);
        assert.equal(callRes2.result?.isError, true);
        assert.ok(callRes2.result.content[0].text.includes("Outcome: validation_failure"));

        // Rejection via schema error on discard_delegation with invalid delegationId format
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
                name: "discard_delegation",
                arguments: {
                    cwd: bridgeDirectory,
                    delegationId: "invalid"
                }
            }
        })}\n`);

        const callRes3 = await stdout.next(15_000);
        assert.equal(callRes3.id, 5);
        assert.equal(Boolean(callRes3.error || callRes3.result?.isError), true);
    } finally {
        child.kill();
        child.stdin.end();
        await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, 2_000))
        ]);
    }
});
