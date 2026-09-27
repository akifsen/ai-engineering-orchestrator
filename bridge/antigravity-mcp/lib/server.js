import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { delegateToAntigravity } from "./delegate.js";

const instructions = `
Antigravity is the Implementation Engineer, not a read-only reviewer and not the Team Lead.

Use delegate_antigravity for bounded substantive implementation inside the absolute repository path passed as cwd.

The Team Lead remains the final authority. After every delegation, inspect the diff and tests before deciding APPROVED or CHANGES REQUIRED. Send substantive revisions back through this tool.

A tool description cannot replace the project policy file. Follow AGENTS.md or CLAUDE.md for when delegation is mandatory.
`.trim();

export function createServer() {
    const server = new McpServer(
        {
            name: "antigravity-mcp",
            version: "1.0.0"
        },
        {
            instructions
        }
    );

    server.registerTool(
        "delegate_antigravity",
        {
            title: "Delegate to Antigravity",
            description: "Delegate a bounded implementation task to the Antigravity Implementation Engineer (Gemini). The engineer may inspect the repository and edit files inside cwd. The Team Lead must independently verify the diff and tests. Antigravity does not approve its own work.",
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
                    .describe("Absolute path of the repository Antigravity may inspect and modify."),
                model: z
                    .string()
                    .trim()
                    .min(1)
                    .regex(/^[A-Za-z0-9._:-]+$/)
                    .optional()
                    .describe("Optional Antigravity model slug. Omit to use the configured default model."),
                effort: z
                    .enum(["low", "medium", "high"])
                    .optional()
                    .describe("Optional reasoning effort: low, medium, or high.")
            })
        },
        async ({ prompt, cwd, model, effort }) => {
            const result = await delegateToAntigravity(
                {
                    prompt,
                    cwd,
                    model,
                    effort
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
