import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    CONTEXT_MAX_CHARS,
    DOCS_SKELETON,
    buildContext,
    checkDocsRegistry,
    main,
    parseDocsRegistry,
    readLockVersions
} from "../memory.js";

const NOW = Date.parse("2026-03-05T10:00:00Z");

async function tempRepo(t) {
    const repo = await mkdtemp(path.join(os.tmpdir(), "aeo-memory-docs-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    await mkdir(path.join(repo, ".aeo", "memory", "tasks"), { recursive: true });
    return repo;
}

async function run(argv, { env = {}, now = () => NOW, stdin } = {}) {
    const out = [];
    const err = [];
    const code = await main(argv, {
        env,
        cwd: os.tmpdir(),
        stdout: (x) => out.push(x),
        stderr: (x) => err.push(x),
        resolveRoot: () => null,
        now,
        ...(stdin === undefined ? {} : { stdin })
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
}

const docsFile = (repo) => path.join(repo, ".aeo", "memory", "docs.md");
const writeJson = (file, data) => writeFile(file, JSON.stringify(data), "utf8");

function table(...rows) {
    return `${DOCS_SKELETON}${rows.join("\n")}\n`;
}

test("readLockVersions: npm v3, nested ignored, scoped included", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
            "": { name: "root", version: "1.0.0" },
            "node_modules/react": { version: "18.2.0" },
            "node_modules/@scope/pkg": { version: "2.0.0" },
            "node_modules/react/node_modules/inner": { version: "9.9.9" }
        }
    });
    const map = readLockVersions(repo, "npm");
    assert.equal(map.get("react"), "18.2.0");
    assert.equal(map.get("@scope/pkg"), "2.0.0");
    assert.equal(map.has("inner"), false);
    assert.equal(map.has("root"), false);
});

test("readLockVersions: npm v1, composer, missing, bad json", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), { lockfileVersion: 1, dependencies: { lodash: { version: "4.17.21" } } });
    assert.equal(readLockVersions(repo, "npm").get("lodash"), "4.17.21");

    await writeJson(path.join(repo, "composer.lock"), {
        packages: [{ name: "laravel/framework", version: "v11.0.1" }],
        "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.0" }]
    });
    const c = readLockVersions(repo, "composer");
    assert.equal(c.get("laravel/framework"), "v11.0.1");
    assert.equal(c.get("phpunit/phpunit"), "10.5.0");

    assert.equal(readLockVersions(repo, "composer@nope"), null);
    await writeFile(path.join(repo, "package-lock.json"), "{oops", "utf8");
    assert.equal(readLockVersions(repo, "npm"), null);
});

test("readLockVersions: @dir suffix and rejected paths", async (t) => {
    const repo = await tempRepo(t);
    await mkdir(path.join(repo, "platform"));
    await writeJson(path.join(repo, "platform", "composer.lock"), { packages: [{ name: "a/b", version: "1.0.0" }] });
    await writeJson(path.join(repo, "composer.lock"), { packages: [{ name: "a/b", version: "0.0.1" }] });
    assert.equal(readLockVersions(repo, "composer@platform").get("a/b"), "1.0.0");
    assert.equal(readLockVersions(repo, "composer@../platform"), null);
    assert.equal(readLockVersions(repo, "composer@platform/../.."), null);
    assert.equal(readLockVersions(repo, `composer@${path.resolve(repo)}`), null);
});

test("parseDocsRegistry tolerates spacing and ignores malformed rows", () => {
    const text = `${DOCS_SKELETON}|  react  |npm|18.2.0|  src  | 2026-01-01 |  n |\r\n| short | row |\n| a\\|b | npm | 1 | s | d | |\n`;
    const rows = parseDocsRegistry(text);
    assert.deepEqual(rows.map((r) => r.library), ["react", "a|b"]);
    assert.equal(rows[0].source, "src");
    assert.equal(rows[0].notes, "n");
});

test("checkDocsRegistry: mismatch, missing, unchecked, leading v, noLockfile", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), {
        lockfileVersion: 3,
        packages: { "node_modules/react": { version: "18.2.0" }, "node_modules/vue": { version: "3.0.0" } }
    });
    await writeFile(docsFile(repo), table(
        "| react | npm | v18.2.0 | s | 2026-01-01 | |",
        "| vue | npm | 2.0.0 | s | 2026-01-01 | |",
        "| gone | npm | 1.0.0 | s | 2026-01-01 | |",
        "| pip-thing | pip | 1.0.0 | s | 2026-01-01 | |",
        "| x/y | composer | 1.0.0 | s | 2026-01-01 | |"
    ), "utf8");
    const r = checkDocsRegistry(repo);
    assert.deepEqual(r.mismatches, [{ library: "vue", ecosystem: "npm", registry: "2.0.0", lockfile: "3.0.0" }]);
    assert.deepEqual(r.missing, [{ library: "gone", ecosystem: "npm" }]);
    assert.deepEqual(r.unchecked, [{ library: "pip-thing", ecosystem: "pip" }]);
    assert.deepEqual(r.noLockfile, ["composer"]);
});

test("docs check: output and exit codes", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/react": { version: "19.0.0" } } });
    await writeFile(docsFile(repo), table("| react | npm | 18.0.0 | s | d | |", "| foo | pip | 1 | s | d | |"), "utf8");
    const r = await run(["docs", "check", "--repo", repo]);
    assert.equal(r.code, 0);
    assert.match(r.out, /mismatch: react \(npm\): registry 18\.0\.0 -> lockfile 19\.0\.0/);
    assert.match(r.out, /unchecked: foo \(pip\)/);
    assert.match(r.out, /Docs registry: 2 rows, 1 checked, 1 mismatched/);

    const empty = await mkdtemp(path.join(os.tmpdir(), "aeo-memory-docs-"));
    t.after(() => rm(empty, { recursive: true, force: true }));
    const bad = await run(["docs", "check", "--repo", empty]);
    assert.equal(bad.code, 1);
});

test("docs set inserts with lockfile version and today's date", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/react": { version: "18.2.0" } } });
    await writeFile(docsFile(repo), DOCS_SKELETON, "utf8");
    const r = await run(["docs", "set", "--library", "react", "--ecosystem", "npm", "--source", "node_modules/react", "--repo", repo]);
    assert.equal(r.code, 0, r.err);
    const text = await readFile(docsFile(repo), "utf8");
    assert.ok(text.startsWith(DOCS_SKELETON));
    assert.ok(text.endsWith("| react | npm | 18.2.0 | node_modules/react | 2026-03-05 |  |\n"));
});

test("docs set updates in place and keeps other lines byte-identical (CRLF)", async (t) => {
    const repo = await tempRepo(t);
    const original = "# Hand written\r\n\r\nSome note | with pipe\r\n| library | ecosystem | version | source | verified | notes |\r\n| --- | --- | --- | --- | --- | --- |\r\n| react | npm | 17.0.0 | old | 2020-01-01 | old |\r\n| vue | npm | 3.0.0 | v | 2020-01-01 | |\r\ntrailing text";
    await writeFile(docsFile(repo), original, "utf8");
    const r = await run(["docs", "set", "--library", "react", "--ecosystem", "npm", "--version", "18.2.0", "--source", "new", "--notes", "hi", "--repo", repo]);
    assert.equal(r.code, 0, r.err);
    const expected = original.replace("| react | npm | 17.0.0 | old | 2020-01-01 | old |", "| react | npm | 18.2.0 | new | 2026-03-05 | hi |");
    assert.equal(await readFile(docsFile(repo), "utf8"), expected);
});

test("docs set escapes pipes, strips newlines, caps notes; recreates missing file", async (t) => {
    const repo = await tempRepo(t);
    const r = await run(["docs", "set", "--library", "a", "--ecosystem", "pip", "--version", "1", "--source", "x|y\nz", "--notes", "n".repeat(300), "--repo", repo]);
    assert.equal(r.code, 0, r.err);
    const text = await readFile(docsFile(repo), "utf8");
    assert.ok(text.startsWith(DOCS_SKELETON));
    const rows = parseDocsRegistry(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "x|y z");
    assert.equal(rows[0].notes.length, 200);
});

test("docs set fails without version, when off, or without memory", async (t) => {
    const repo = await tempRepo(t);
    const noVersion = await run(["docs", "set", "--library", "a", "--ecosystem", "npm", "--source", "s", "--repo", repo]);
    assert.equal(noVersion.code, 1);
    const off = await run(["docs", "set", "--library", "a", "--ecosystem", "npm", "--version", "1", "--source", "s", "--repo", repo], { env: { AEO_MEMORY: "off" } });
    assert.equal(off.code, 1);
    const empty = await mkdtemp(path.join(os.tmpdir(), "aeo-memory-docs-"));
    t.after(() => rm(empty, { recursive: true, force: true }));
    const none = await run(["docs", "set", "--library", "a", "--ecosystem", "npm", "--version", "1", "--source", "s", "--repo", empty]);
    assert.equal(none.code, 1);
});

test("context shows mismatch lines only when they exist, within the cap", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/react": { version: "18.2.0" } } });
    await writeFile(docsFile(repo), table("| react | npm | 18.2.0 | s | d | |"), "utf8");
    const ok = await buildContext(repo);
    assert.doesNotMatch(ok, /registry .* -> lockfile/);
    assert.match(ok, /All checked versions match the lockfiles\./);

    const many = [];
    for (let i = 0; i < 12; i++) {
        many.push(`| lib${i} | npm | 1.0.0 | s | d | |`);
    }
    await writeFile(docsFile(repo), table("| react | npm | 1.0.0 | s | d | |", ...many), "utf8");
    const bad = await buildContext(repo);
    assert.match(bad, /- react \(npm\): registry 1\.0\.0 -> lockfile 18\.2\.0; re-resolve the source and notes, then run memory\.js docs set/);
    assert.match(bad, /not in the lockfile any more; remove or update the row/);
    assert.match(bad, /\(\+3 more\)/);
    assert.doesNotMatch(bad, /All checked versions match/);
    assert.ok(bad.length <= CONTEXT_MAX_CHARS);
});

test("session-start stats line includes docsMismatches", async (t) => {
    const repo = await tempRepo(t);
    await writeJson(path.join(repo, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/react": { version: "18.2.0" } } });
    await writeFile(docsFile(repo), table("| react | npm | 1.0.0 | s | d | |"), "utf8");
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
    assert.match(out.join("\n"), /registry 1\.0\.0 -> lockfile 18\.2\.0/);
    const stats = await readFile(path.join(repo, ".aeo", "memory", "stats", "session-start.jsonl"), "utf8");
    assert.equal(JSON.parse(stats.trim()).docsMismatches, 1);
});
