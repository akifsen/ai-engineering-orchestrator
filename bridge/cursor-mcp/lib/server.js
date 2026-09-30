import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
    applyDelegation,
    delegateToCursor,
    discardDelegation
} from "./delegate.js";

const instructions = `
Cursor is the secondary Implementation Engineer (fallback when Antigravity is unavailable per policy) and a parallel peer for worktree-isolated delegations with non-overlapping scopes, not a read-only reviewer and not the Team Lead.

Use delegate_cursor for bounded substantive implementation inside the absolute repository path passed as cwd when Antigravity cannot run the work, or for parallel isolated work on independent scopes.

The Team Lead remains the final authority. After every delegation, inspect the diff and tests before deciding APPROVED or CHANGES REQUIRED. Send substantive revisions back through the appropriate implementation tool.

Parallel delegations must use isolation "worktree" with non-overlapping file scopes; apply them one at a time with apply_delegation on the same MCP server that created the delegation, verifying after each; call discard_delegation when done or abandoned; apply_conflict is not a revision.

A tool description cannot replace the project policy file. Follow AGENTS.md or CLAUDE.md for when delegation is mandatory and when to fall back from Antigravity to Cursor.
`.trim();

export function createServer() {
    const server = new McpServer(
        {
            name: "cursor-mcp",
            version: "1.1.0"
        },
        {
            instructions
        }
    );

    server.registerTool(
        "delegate_cursor",
        {
            title: "Delegate to Cursor",
            description: "Delegate a bounded implementation task to the Cursor Implementation Engineer (Composer). The engineer may inspect the repository and edit files inside cwd. Use when Antigravity is unavailable (quota, auth, or CLI failure) per orchestration policy, or as a parallel peer with isolation \"worktree\" for independent scopes. The Team Lead must independently verify the diff and tests. Cursor does not approve its own work.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            },
            inputSchema: z.object({
                prompt: z
                    .string()
                    .trim()
                    .min(1)
                    .max(24_000)
                    .describe("Bounded implementation assignment: objective, constraints, acceptance criteria, and verification."),
                cwd: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("Absolute path of the repository Cursor may inspect and modify."),
                model: z
                    .string()
                    .trim()
                    .min(1)
                    .regex(/^[A-Za-z0-9._:[\]=,-]+$/)
                    .optional()
                    .describe("Optional Cursor model slug. Omit to use the configured default model (composer-2.5)."),
                timeoutMinutes: z
                    .number()
                    .int()
                    .min(1)
                    .max(120)
                    .optional()
                    .describe("Optional hard timeout in minutes (1..120). Overrides the bridge default for this call."),
                isolation: z
                    .enum(["none", "worktree"])
                    .optional()
                    .describe("Optional. \"worktree\" runs the engineer in a bridge-owned detached git worktree so parallel delegations cannot touch the main working tree or each other. Nothing lands in the main tree until apply_delegation. Default \"none\" edits cwd in place (current behavior)."),
                delegationId: z
                    .string()
                    .regex(/^[a-f0-9]{10}$/)
                    .optional()
                    .describe("Optional. With isolation \"worktree\", revise an existing isolated delegation in its existing worktree instead of creating a new one.")
            })
        },
        async ({ prompt, cwd, model, timeoutMinutes, isolation, delegationId }) => {
            const result = await delegateToCursor(
                {
                    prompt,
                    cwd,
                    model,
                    timeoutMinutes,
                    isolation,
                    delegationId
                },
                {
                    log: (message) => {
                        console.error(message);
                    }
                }
            );

            return {
                isError: result.isError,
                content: [
                    {
                        type: "text",
                        text: result.text
                    }
                ]
            };
        }
    );

    server.registerTool(
        "apply_delegation",
        {
            title: "Apply isolated delegation",
            description: "Applies the patch of a worktree-isolated delegation to the main working tree as unstaged changes, after a `git apply --check`; returns apply_conflict without changing anything if the patch no longer applies; the Team Lead must review the diff and re-run tests after each apply; apply one delegation at a time.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false
            },
            inputSchema: z.object({
                cwd: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("Absolute path of the main repository the delegation was created from."),
                delegationId: z
                    .string()
                    .regex(/^[a-f0-9]{10}$/)
                    .describe("10-character hexadecimal delegation ID.")
            })
        },
        async ({ cwd, delegationId }) => {
            const result = await applyDelegation(
                {
                    cwd,
                    delegationId
                },
                {
                    log: (message) => {
                        console.error(message);
                    }
                }
            );

            return {
                isError: result.isError,
                content: [
                    {
                        type: "text",
                        text: result.text
                    }
                ]
            };
        }
    );

    server.registerTool(
        "discard_delegation",
        {
            title: "Discard isolated delegation",
            description: "Removes the bridge-owned worktree and patch for a delegation (call after apply or to abandon it); never touches the main working tree.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false
            },
            inputSchema: z.object({
                cwd: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("Absolute path of the main repository the delegation was created from."),
                delegationId: z
                    .string()
                    .regex(/^[a-f0-9]{10}$/)
                    .describe("10-character hexadecimal delegation ID.")
            })
        },
        async ({ cwd, delegationId }) => {
            const result = await discardDelegation(
                {
                    cwd,
                    delegationId
                },
                {
                    log: (message) => {
                        console.error(message);
                    }
                }
            );

            return {
                isError: result.isError,
                content: [
                    {
                        type: "text",
                        text: result.text
                    }
                ]
            };
        }
    );

    return server;
}
