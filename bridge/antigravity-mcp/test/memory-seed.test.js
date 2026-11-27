import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { INDEX_SKELETON, buildContext, buildModuleLines, buildTestLines, main, parseIndexSections } from "../memory.js";

const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function git(repo, ...args) {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
}

const mem = (repo, ...parts) => path.join(repo, ".aeo", "memory", ...parts);

async function put(repo, rel, content) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), content);
}

async function seededRepo(t, { commit = true } = {}) {
    if (!hasGit) {
        t.skip("git not on PATH");
        return null;
    }
    const repo = await mkdtemp(path.join(os.tmpdir(), "aeo-seed-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    git(repo, "init", "-q");
    await put(repo, "package.json", JSON.stringify({ scripts: { test: "node --test", "test:e2e": "x", build: "y" } }));
    await put(repo, "src/lib/a.js", "a\n");
    await put(repo, "src/b.js", "b\n");
    await put(repo, ".github/workflows/ci.yml", "x\n");
    await put(repo, "platform/composer.json", JSON.stringify({ scripts: { test: "phpunit", lint: "x" } }));
    await put(repo, "platform/artisan", "#!/usr/bin/env php\n");
    await put(repo, "platform/app/Domains/User.php", "<?php\n");
    git(repo, "add", ".");
    if (commit) {
        git(repo, "commit", "-q", "-m", "one");
    }
    return repo;
}

async function run(repo, argv, env = {}) {
    const out = [];
    const err = [];
    const code = await main(argv, {
        env,
        cwd: os.tmpdir(),
        stdout: (x) => out.push(x),
        stderr: (x) => err.push(x),
        resolveRoot: () => repo
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
}

test("init --seed fills Modules and Test commands and stamps HEAD", async (t) => {
    const repo = await seededRepo(t);
    if (!repo) {
        return;
    }
    const r = await run(repo, ["init", "--seed"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /seeded Modules \(\d+ lines\)/);
    assert.match(r.out, /seeded Test commands \(4 lines\)/);
    assert.match(r.out, /skipped Conventions \(not seedable\)/);
    const index = await readFile(mem(repo, "INDEX.md"), "utf8");
    const head = git(repo, "rev-parse", "HEAD");
    assert.ok(index.includes(`## Modules\n<!-- verified: ${head} -->\n- platform/ (3 files)`), index);
    assert.ok(index.includes("- src/lib/ (1 files)"));
    assert.ok(!index.includes(".github"), "dot directories are skipped");
    assert.ok(index.includes(`<!-- verified: ${head} paths: package.json, platform/composer.json, platform/artisan -->`), index);
    assert.ok(index.includes("- .: npm test\n- .: npm run test:e2e\n- platform: composer test\n- platform: php artisan test\n"), index);
    const sections = parseIndexSections(index);
    assert.equal(sections.find((s) => s.heading === "Conventions").empty, true);
    assert.equal(sections.find((s) => s.heading === "Modules").empty, false);
});

test("seed is idempotent and never touches non-empty sections", async (t) => {
    const repo = await seededRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["init", "--seed"]);
    const before = await readFile(mem(repo, "INDEX.md"), "utf8");
    const r = await run(repo, ["seed"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /skipped Modules \(not empty\)/);
    assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), before);
});

test("seed keeps CRLF and other bytes", async (t) => {
    const repo = await seededRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["init"]);
    const crlf = INDEX_SKELETON.replace("## Conventions\n<!-- verified: none -->\n", "## Conventions\n<!-- verified: none -->\n- keep me\n").replaceAll("\n", "\r\n");
    await writeFile(mem(repo, "INDEX.md"), crlf, "utf8");
    const r = await run(repo, ["seed"]);
    assert.equal(r.code, 0, r.err);
    const after = await readFile(mem(repo, "INDEX.md"), "utf8");
    assert.ok(!/[^\r]\n/.test(after), "every newline stays CRLF");
    assert.ok(after.includes("- keep me\r\n"));
    assert.ok(after.includes("- src/ (2 files)\r\n"));
    const restored = after.split("\r\n").filter((l) => !l.startsWith("- ") || l === "- keep me" || l === "- (no decisions recorded yet)")
        .map((l) => l.replace(/^<!-- verified: [0-9a-f]{40}.*-->$/, "<!-- verified: none -->")).join("\r\n");
    assert.equal(restored, crlf);
});

test("seed fails without a HEAD and changes nothing", async (t) => {
    const repo = await seededRepo(t, { commit: false });
    if (!repo) {
        return;
    }
    await run(repo, ["init"]);
    const r = await run(repo, ["seed"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /No git HEAD/);
    assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), INDEX_SKELETON);
});

test("seed refuses when AEO_MEMORY=off and --seed is rejected on other commands", async (t) => {
    const repo = await seededRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["init"]);
    assert.equal((await run(repo, ["seed"], { AEO_MEMORY: "off" })).code, 1);
    assert.equal((await run(repo, ["status", "--seed"])).code, 1);
});

test("buildModuleLines keeps shallow levels and the largest deeper directories", () => {
    const files = [];
    for (let i = 0; i < 30; i++) {
        files.push(`a/b${String(i).padStart(2, "0")}/c/x.js`);
    }
    files.push("a/b00/c/y.js", "a/b00/c/z.js");
    const lines = buildModuleLines(files, 40);
    assert.equal(lines.length, 41, lines.join("\n"));
    assert.equal(lines[0], "- a/ (32 files)");
    assert.ok(lines.includes("- a/b00/c/ (3 files)"), "largest depth-3 directory is kept");
    assert.equal(lines.filter((l) => l.split("/").length === 4).length, 9, "31 shallow lines + 9 deep lines");
    assert.equal(lines[40], "- ... (21 more directories)");
    const many = buildModuleLines(Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, "0")}/x.js`), 40);
    assert.equal(many.length, 41);
    assert.equal(many[40], "- ... (20 more directories)");
});

test("buildTestLines finds phpunit and pytest manifests", () => {
    const files = ["svc/phpunit.xml.dist", "py/pyproject.toml", "py/x.py"];
    const r = buildTestLines(files, (rel) => (rel === "py/pyproject.toml" ? "[tool.pytest.ini_options]\n" : null));
    assert.deepEqual(r.lines, ["- py: pytest", "- svc: vendor/bin/phpunit"]);
    assert.deepEqual(r.manifests, ["py/pyproject.toml", "svc/phpunit.xml.dist"]);
});

test("session block asks to fill empty sections", async (t) => {
    const repo = await seededRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["init", "--seed"]);
    const text = await buildContext(repo, { source: "startup" });
    assert.match(text, /- Conventions: empty; after this task add at most 5 lines .*memory\.js verify --section "Conventions"/);
    assert.ok(!/- Modules: /.test(text.split("## INDEX freshness")[1].split("##")[0]), "fresh seeded sections are not listed");
});
