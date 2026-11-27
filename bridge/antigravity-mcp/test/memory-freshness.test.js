import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DOCS_SKELETON, INDEX_SKELETON, buildContext, checkFreshness, main, parseIndexSections } from "../memory.js";

const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function git(repo, ...args) {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
}

const mem = (repo, ...parts) => path.join(repo, ".aeo", "memory", ...parts);

async function gitRepo(t, index = INDEX_SKELETON) {
    if (!hasGit) {
        t.skip("git not on PATH");
        return null;
    }
    const repo = await mkdtemp(path.join(os.tmpdir(), "aeo-fresh-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    git(repo, "init", "-q");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "a.js"), "a\n");
    await writeFile(path.join(repo, "other.txt"), "o\n");
    await mkdir(mem(repo, "tasks"), { recursive: true });
    await writeFile(mem(repo, "INDEX.md"), index, "utf8");
    await writeFile(mem(repo, "docs.md"), DOCS_SKELETON, "utf8");
    git(repo, "add", "src", "other.txt");
    git(repo, "commit", "-q", "-m", "one");
    return repo;
}

async function commit(repo, file, content, msg = "c") {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", msg);
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

const statusOf = (repo, heading) => checkFreshness(repo).find((s) => s.heading === heading);
const readIndex = (repo) => readFile(mem(repo, "INDEX.md"), "utf8");

test("parseIndexSections reads markers and ignores Recent tasks", () => {
    const text = [
        "# Project index",
        "## Modules",
        "<!-- verified: abc1234 paths: src, lib/x.js -->",
        "text",
        "## Conventions",
        "<!-- verified: none -->",
        "## Test commands",
        "no marker here",
        "## Recent tasks",
        "<!-- aeo:recent-tasks:start -->",
        "## Fake heading",
        "<!-- aeo:recent-tasks:end -->",
        "## Open decisions",
        "<!-- verified: deadbeef -->"
    ].join("\r\n");
    const s = parseIndexSections(text);
    assert.deepEqual(s.map((x) => x.heading), ["Modules", "Conventions", "Test commands", "Open decisions"]);
    assert.equal(s[0].sha, "abc1234");
    assert.deepEqual(s[0].paths, ["src", "lib/x.js"]);
    assert.equal(s[0].markerLine, 2);
    assert.equal(s[1].sha, null);
    assert.equal(s[2].markerLine, -1);
    assert.equal(s[3].sha, "deadbeef");
    assert.deepEqual(s[3].paths, []);
});

test("verify sets HEAD, keeps, replaces and clears paths", async (t) => {
    const repo = await gitRepo(t);
    if (!repo) {
        return;
    }
    const head = git(repo, "rev-parse", "HEAD");
    let r = await run(repo, ["verify", "--section", "modules", "--paths", "src,lib\\x.js"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(head.slice(0, 7)));
    assert.match(await readIndex(repo), new RegExp(`## Modules\\n<!-- verified: ${head} paths: src, lib/x.js -->\\n`));

    await commit(repo, "src/b.js", "b\n");
    const head2 = git(repo, "rev-parse", "HEAD");
    r = await run(repo, ["verify", "--section", "Modules"]);
    assert.equal(r.code, 0, r.err);
    assert.match(await readIndex(repo), new RegExp(`<!-- verified: ${head2} paths: src, lib/x.js -->`));

    r = await run(repo, ["verify", "--section", "Modules", "--paths", "src"]);
    assert.match(await readIndex(repo), new RegExp(`<!-- verified: ${head2} paths: src -->`));
    r = await run(repo, ["verify", "--section", "Modules", "--paths", ""]);
    assert.equal(r.code, 0, r.err);
    assert.match(await readIndex(repo), new RegExp(`<!-- verified: ${head2} -->`));
});

test("verify inserts a missing marker and preserves other bytes incl. CRLF", async (t) => {
    const index = "# Project index\r\n\r\n## Modules\r\nsrc stuff\r\n\r\n## Conventions\r\n<!-- verified: none -->\r\nstyle  \r\n";
    const repo = await gitRepo(t, index);
    if (!repo) {
        return;
    }
    const head = git(repo, "rev-parse", "HEAD");
    const r = await run(repo, ["verify", "--section", "MODULES"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(
        await readIndex(repo),
        `# Project index\r\n\r\n## Modules\r\n<!-- verified: ${head} -->\r\nsrc stuff\r\n\r\n## Conventions\r\n<!-- verified: none -->\r\nstyle  \r\n`
    );
});

test("verify rejects unknown heading, Recent tasks, and missing memory", async (t) => {
    const repo = await gitRepo(t);
    if (!repo) {
        return;
    }
    const before = await readIndex(repo);
    let r = await run(repo, ["verify", "--section", "Nope"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Modules, Conventions, Test commands, Open decisions/);
    r = await run(repo, ["verify", "--section", "recent tasks"]);
    assert.equal(r.code, 1);
    r = await run(repo, ["verify", "--section", "Modules"], { AEO_MEMORY: "off" });
    assert.equal(r.code, 1);
    assert.equal(await readIndex(repo), before);
    await rm(mem(repo), { recursive: true, force: true });
    assert.equal((await run(repo, ["verify", "--section", "Modules"])).code, 1);
    assert.equal((await run(repo, ["freshness"])).code, 1);
});

test("freshness: fresh, stale, outside paths, uncommitted, memory ignored", async (t) => {
    const repo = await gitRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["verify", "--section", "Modules", "--paths", "src"]);
    assert.equal(statusOf(repo, "Modules").status, "fresh");

    await commit(repo, "other.txt", "changed\n");
    assert.equal(statusOf(repo, "Modules").status, "fresh");

    await commit(repo, "src/a.js", "a2\n");
    let s = statusOf(repo, "Modules");
    assert.equal(s.status, "stale");
    assert.deepEqual(s.changedFiles, ["src/a.js"]);
    assert.equal(s.total, 1);

    await writeFile(path.join(repo, "src", "a.js"), "a3\n");
    await writeFile(path.join(repo, "src", "new.js"), "n\n");
    await mkdir(mem(repo, "tasks"), { recursive: true });
    await writeFile(mem(repo, "tasks", "x.md"), "x");
    s = statusOf(repo, "Modules");
    assert.deepEqual(s.changedFiles.sort(), ["src/a.js", "src/new.js"]);

    const cli = await run(repo, ["freshness"]);
    assert.equal(cli.code, 0);
    assert.match(cli.out, /Modules: stale: 2 files changed since [0-9a-f]{7} \(/);
    assert.match(cli.out, /Conventions: unverified/);
});

test("freshness: .aeo/memory changes are ignored for a whole-repo section", async (t) => {
    const repo = await gitRepo(t);
    if (!repo) {
        return;
    }
    await run(repo, ["verify", "--section", "Conventions"]);
    await writeFile(mem(repo, "INDEX.md"), (await readIndex(repo)) + "\nmore\n", "utf8");
    assert.equal(statusOf(repo, "Conventions").status, "fresh");
});

test("freshness: unknown commit and unverified", async (t) => {
    const index = "## Modules\n<!-- verified: 1234567890abcdef1234567890abcdef12345678 -->\n## Conventions\n";
    const repo = await gitRepo(t, index);
    if (!repo) {
        return;
    }
    assert.equal(statusOf(repo, "Modules").status, "unknown-commit");
    assert.equal(statusOf(repo, "Conventions").status, "unverified");
    const cli = await run(repo, ["freshness"]);
    assert.match(cli.out, /Modules: unknown commit 1234567/);
});

test("freshness: no git means no-git for verified sections", () => {
    const fake = () => ({ status: 128, stdout: "" });
    assert.deepEqual(checkFreshness(path.join(os.tmpdir(), "does-not-exist-aeo"), { git: fake }), []);
});

test("context shows only non-fresh lines, the all-fresh line, and stats", async (t) => {
    const repo = await gitRepo(t);
    if (!repo) {
        return;
    }
    for (const h of ["Modules", "Conventions", "Test commands", "Open decisions"]) {
        await run(repo, ["verify", "--section", h, "--paths", h === "Modules" ? "src" : "other.txt"]);
    }
    let text = await buildContext(repo, { source: "startup" });
    assert.match(text, /## INDEX freshness\n\nAll verified sections are fresh\.\n/);

    await commit(repo, "src/a.js", "a2\n");
    await writeFile(mem(repo, "INDEX.md"), (await readIndex(repo)).replace(/(## Conventions\n)<!-- verified: [^\n]*-->/, "$1<!-- verified: none -->"), "utf8");
    text = await buildContext(repo, { source: "startup" });
    assert.match(text, /- Modules: stale, 1 files changed since [0-9a-f]{7} \(src\/a\.js\); rescan only these, then run memory\.js verify --section "Modules"/);
    // The skeleton Conventions section is empty, so it gets the fill hint rather than the generic unverified line.
    assert.match(text, /- Conventions: empty; after this task add at most 5 lines/);
    assert.doesNotMatch(text, /- Test commands:/);
    assert.ok(text.length <= 9000);

    const out = [];
    const code = await main(["hook", "session-start"], {
        env: {},
        cwd: repo,
        stdout: (x) => out.push(x),
        stderr: () => {},
        resolveRoot: () => repo,
        stdin: JSON.stringify({ cwd: repo, source: "startup" })
    });
    assert.equal(code, 0);
    const stats = (await readFile(mem(repo, "stats", "session-start.jsonl"), "utf8")).trim().split("\n").pop();
    assert.equal(JSON.parse(stats).staleSections, 1);
});

test("context reports git unavailable", async (t) => {
    const repo = await gitRepo(t, "## Modules\n<!-- verified: abcdef1234 -->\n");
    if (!repo) {
        return;
    }
    const text = await buildContext(repo, { git: () => ({ status: 1, stdout: "" }) });
    assert.match(text, /INDEX freshness unknown \(git unavailable\)\./);
});
