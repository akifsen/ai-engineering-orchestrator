import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { delegateToCursor } from "./delegate.js";

const instructions = `
Cursor is the secondary Implementation Engineer (fallback when Antigravity is unavailable per policy), not a read-only reviewer and not the Team Lead.

Use delegate_cursor for bounded substantive implementation inside the absolute repository path passed as cwd when Antigravity cannot run the work.

The Team Lead remains the final authority. After every delegation, inspect the diff and tests before deciding APPROVED or CHANGES REQUIRED. Send substantive revisions back through the appropriate implementation tool.

Parallel Cursor delegations need non-overlapping file scopes or separate repository clones. This bridge does not provide worktree isolation.

A tool description cannot replace the project policy file. Follow AGENTS.md or CLAUDE.md for when delegation is mandatory and when to fall back from Antigravity to Cursor.
`.trim();

export function createServer() {
    const server = new McpServer(
        {
            name: "cursor-mcp",
            version: "1.0.0"
        },
        {
            instructions
        }
    );

    server.registerTool(
        "delegate_cursor",
        {
            title: "Delegate to Cursor",
            description: "Delegate a bounded implementation task to the Cursor Implementation Engineer (Composer). The engineer may inspect the repository and edit files inside cwd. Use when Antigravity is unavailable (quota, auth, or CLI failure) per orchestration policy. The Team Lead must independently verify the diff and tests. Cursor does not approve its own work.",
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
                    .describe("Optional hard timeout in minutes (1..120). Overrides the bridge default for this call.")
            })
        },
        async ({ prompt, cwd, model, timeoutMinutes }) => {
            const result = await delegateToCursor(
                {
                    prompt,
                    cwd,
                    model,
                    timeoutMinutes
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
