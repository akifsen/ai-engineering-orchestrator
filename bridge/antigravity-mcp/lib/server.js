import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const packageVersion = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

import {
    applyDelegation,
    delegateToAntigravity,
    discardDelegation
} from "./delegate.js";

const instructions = `
Antigravity is the Implementation Engineer, not a read-only reviewer and not the Team Lead.

Use delegate_antigravity for bounded substantive implementation inside the absolute repository path passed as cwd.

The Team Lead remains the final authority. After every delegation, inspect the diff and tests before deciding APPROVED or CHANGES REQUIRED. Send substantive revisions back through this tool.

Parallel delegations must use isolation "worktree" with non-overlapping file scopes; apply them one at a time with apply_delegation, verifying after each; call discard_delegation when done or abandoned; apply_conflict is not a revision.

A tool description cannot replace the project policy file. Follow AGENTS.md or CLAUDE.md for when delegation is mandatory.
`.trim();

export function createServer() {
    const server = new McpServer(
        {
            name: "antigravity-mcp",
            version: packageVersion
        },
        {
            instructions
        }
    );

    server.registerTool(
        "delegate_antigravity",
        {
            title: "Delegate to Antigravity",
            description: "Delegate a bounded implementation task to the Antigravity Implementation Engineer (Gemini). The engineer may inspect the repository and edit files inside cwd. The Team Lead must independently verify the diff and tests. Antigravity does not approve its own work. Use isolation \"worktree\" for parallel work.",
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
                    .describe("Optional reasoning effort: low, medium, or high."),
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
        async ({ prompt, cwd, model, effort, isolation, delegationId }) => {
            const result = await delegateToAntigravity(
                {
                    prompt,
                    cwd,
                    model,
                    effort,
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
