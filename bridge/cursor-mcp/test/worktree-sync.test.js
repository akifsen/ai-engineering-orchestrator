import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const cursorWorktree = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "lib",
    "worktree.js"
);
const antigravityWorktree = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "antigravity-mcp",
    "lib",
    "worktree.js"
);

function normalizeNewlines(text) {
    return text.replace(/\r\n/g, "\n");
}

test("cursor worktree.js matches antigravity worktree.js when sibling exists", async () => {
    let agyContent;
    try {
        agyContent = await readFile(antigravityWorktree, "utf8");
    } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
            return;
        }
        throw error;
    }

    const cursorContent = await readFile(cursorWorktree, "utf8");
    assert.equal(
        normalizeNewlines(cursorContent),
        normalizeNewlines(agyContent)
    );
});
