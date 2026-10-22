import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    computeCosts,
    extractEngineerTokens,
    formatRow
} from "../measure-delegation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts", "measure-delegation.mjs");

test("extracts usage.total_tokens", () => {
    assert.equal(extractEngineerTokens({ total_tokens: 10 }), 10);
});

test("extracts usage.input_tokens + usage.output_tokens", () => {
    assert.equal(extractEngineerTokens({ input_tokens: 4, output_tokens: 6 }), 10);
});

test("unknown usage schema returns null", () => {
    assert.equal(extractEngineerTokens({ foo: 1, bar: 2 }), null);
    assert.equal(extractEngineerTokens(null), null);
    assert.equal(extractEngineerTokens(undefined), null);
});

test("formatRow prints TODO cells for missing values", () => {
    assert.equal(
        formatRow({
            task: "demo",
            teamLeadTokens: 5,
            engineerTokens: null,
            costWith: null,
            costWithout: null
        }),
        "| demo | 5 | TODO | TODO | TODO |"
    );
});

test("computeCosts does the 1e6 rate math", () => {
    const { withDelegation, withoutDelegation } = computeCosts({
        teamLeadTokens: 1000,
        engineerTokens: 2000,
        teamLeadRate: 5,
        engineerRate: 1,
        withoutDelegationTokens: 3000
    });
    assert.equal(withDelegation, 0.007);
    assert.equal(withoutDelegation, 0.015);
    assert.equal(
        formatRow({
            task: "math",
            teamLeadTokens: 1000,
            engineerTokens: 2000,
            costWith: withDelegation,
            costWithout: withoutDelegation
        }),
        "| math | 1000 | 2000 | $0.0070 | $0.0150 |"
    );
});

test("formatRow escapes pipes in the task name", () => {
    assert.equal(
        formatRow({
            task: "foo|bar",
            teamLeadTokens: 1,
            engineerTokens: 2,
            costWith: null,
            costWithout: null
        }),
        "| foo\\|bar | 1 | 2 | TODO | TODO |"
    );
});

test("cli prints a row from a temp agy json file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aeo-measure-"));
    const jsonPath = path.join(dir, "agy.json");
    await writeFile(jsonPath, JSON.stringify({ usage: { total_tokens: 10 } }));
    try {
        const result = spawnSync(
            process.execPath,
            [script, "--task", "demo", "--team-lead-tokens", "5", "--agy-json", jsonPath],
            { encoding: "utf8" }
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "| demo | 5 | 10 | TODO | TODO |\n");
        assert.match(result.stderr, /--team-lead-rate/);
        assert.match(result.stderr, /--engineer-rate/);
        assert.match(result.stderr, /--without-delegation-tokens/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
