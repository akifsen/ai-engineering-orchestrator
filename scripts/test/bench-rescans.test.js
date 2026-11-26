import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRescans, analyzeSession, main } from "../bench/analyze-rescans.mjs";

let n = 0;
const use = (name, input, extra = {}) => {
    const id = `t${++n}`;
    return {
        id,
        line: { type: "assistant", timestamp: extra.ts, isSidechain: extra.side, message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } }
    };
};
const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join("\n");

function session(id, ts, steps) {
    const lines = [{ type: "user", sessionId: id, timestamp: ts, message: { content: "hi" } }];
    for (const [name, input, text, extra] of steps) {
        const u = use(name, input, extra);
        lines.push(u.line);
        if (text !== undefined) lines.push(result(u.id, text));
    }
    return jsonl(lines);
}

test("categorizes discovery incl. bash and explorer agents", () => {
    const s = analyzeSession(
        session("a", "2026-01-01T00:00:00Z", [
            ["Read", { file_path: "/x/a.js" }, "abcd"],
            ["Grep", { pattern: "x" }, "12345678"],
            ["Bash", { command: "  git ls-files | head" }, "z"],
            ["Bash", { command: "npm test" }, "nope"],
            ["PowerShell", { command: "Get-ChildItem ." }, "q"],
            ["Agent", { subagent_type: "code-explorer" }],
            ["Task", { subagent_type: "Explore" }],
            ["Agent", { subagent_type: "general-purpose" }]
        ])
    );
    assert.equal(s.discovery.calls, 6);
    assert.deepEqual(s.discovery.byCategory, { Read: 1, Grep: 1, Bash: 1, PowerShell: 1, ExploreAgent: 2 });
    assert.equal(s.discovery.resultChars, 14);
    assert.equal(s.discovery.approxTokens, 4);
});

test("startup cutoff at first Edit and first delegate call", () => {
    const e = analyzeSession(
        session("a", "2026-01-01T00:00:00Z", [["Read", { file_path: "/a" }, "1"], ["Edit", {}, "ok"], ["Read", { file_path: "/b" }, "22"]])
    );
    assert.equal(e.discovery.calls, 2);
    assert.equal(e.startupDiscovery.calls, 1);
    const d = analyzeSession(
        session("a", "2026-01-01T00:00:00Z", [["Grep", {}, "1"], ["mcp__x__delegate_cursor", {}, "ok"], ["Grep", {}, "1"]])
    );
    assert.equal(d.startupDiscovery.calls, 1);
    const none = analyzeSession(session("a", "2026-01-01T00:00:00Z", [["Grep", {}, "1"], ["Grep", {}, "1"]]));
    assert.equal(none.startupDiscovery.calls, 2);
});

test("result size matched by tool_use_id and sidechain skipped", () => {
    const a = use("Read", { file_path: "/a" });
    const b = use("Read", { file_path: "/b" });
    const side = use("Read", { file_path: "/c" }, { side: true });
    const raw = jsonl([
        { type: "user", sessionId: "s" },
        a.line,
        b.line,
        side.line,
        result(b.id, "xxxxx"),
        result(a.id, "yy")
    ]);
    const s = analyzeSession(raw);
    assert.equal(s.discovery.calls, 2);
    assert.equal(s.discovery.resultChars, 7);
    assert.deepEqual(s.filesRead, ["/a", "/b"]);
});

test("cross-session reread and project-root normalization", () => {
    const s1 = session("s1", "2026-01-01T00:00:00Z", [["Read", { file_path: "C:\\Repo\\src\\a.js" }, "1234"], ["Read", { file_path: "C:\\Repo\\b.js" }, "1"]]);
    const s2 = session("s2", "2026-01-02T00:00:00Z", [["Read", { file_path: "c:/repo/src/a.js" }, "12345678"], ["Read", { file_path: "c:/repo/new.js" }, "1"]]);
    const out = analyzeRescans([s2, s1], { projectRoot: "C:\\Repo" });
    assert.deepEqual(out.sessions.map((x) => x.session), ["s1", "s2"]);
    assert.deepEqual(out.sessions[0].filesRead, ["b.js", "src/a.js"]);
    assert.equal(out.sessions[0].rereadRatio, null);
    assert.equal(out.sessions[1].rereadRatio, 0.5);
    const c = out.crossSession;
    assert.equal(c.totalSessions, 2);
    assert.equal(c.uniqueFilesRead, 3);
    assert.deepEqual(c.rereadFiles, [{ path: "src/a.js", sessions: 2 }]);
    assert.equal(c.rereadFilesTotal, 1);
    assert.equal(c.overallRereadRatio, 0.25);
    assert.equal(c.rereadChars, 8);
    assert.equal(c.rereadApproxTokens, 2);
});

test("directory argument is non-recursive; unreadable path exits 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rescans-"));
    const origWrite = process.stdout.write;
    const origErr = process.stderr.write;
    try {
        mkdirSync(path.join(dir, "sub"));
        writeFileSync(path.join(dir, "a.jsonl"), session("top", "2026-01-01T00:00:00Z", [["Read", { file_path: "/a" }, "1"]]));
        writeFileSync(path.join(dir, "sub", "b.jsonl"), session("nested", "2026-01-02T00:00:00Z", []));
        let out = "";
        process.stdout.write = (c) => ((out += c), true);
        assert.equal(main([dir]), 0);
        process.stdout.write = origWrite;
        const parsed = JSON.parse(out);
        assert.deepEqual(parsed.sessions.map((s) => s.session), ["top"]);
        process.stderr.write = () => true;
        assert.equal(main([path.join(dir, "missing.jsonl")]), 1);
        assert.equal(main([]), 1);
    } finally {
        process.stdout.write = origWrite;
        process.stderr.write = origErr;
        process.exitCode = 0;
        rmSync(dir, { recursive: true, force: true });
    }
});


const T0 = "2026-01-01T00:00:00Z";

test("shell reads: Get-Content with -TotalCount and quoted path", () => {
    const s = analyzeSession(session("a", T0, [["PowerShell", { command: "Get-Content -TotalCount 40 -Path 'C:\\repo\\my docs\\x.md' -Raw" }, "abc"]]));
    assert.deepEqual(s.filesRead, ["c:/repo/my docs/x.md"]);
    assert.equal(s.readCharsByFile["c:/repo/my docs/x.md"], 3);
    const g = analyzeSession(session("a", T0, [["PowerShell", { command: "gc \"a.txt\" -Tail 5" }, "xy"]]));
    assert.deepEqual(g.filesRead, ["a.txt"]);
});

test("shell reads: cat with pipe, sed -n range, head -n", () => {
    const s = analyzeSession(
        session("a", T0, [
            ["Bash", { command: "cat src/a.js | grep foo" }, "1"],
            ["Bash", { command: "sed -n '1,20p' src/b.js" }, "22"],
            ["Bash", { command: "head -n 50 src/c.js && echo done" }, "333"]
        ])
    );
    assert.deepEqual(s.filesRead, ["src/a.js", "src/b.js", "src/c.js"]);
    assert.equal(s.readCharsByFile["src/b.js"], 2);
    assert.equal(s.readCharsByFile["src/c.js"], 3);
});

test("shell reads: relative and absolute resolve to same key with project root", () => {
    const s = analyzeSession(
        session("a", T0, [
            ["Bash", { command: "cat docs/x.md" }, "1"],
            ["PowerShell", { command: "type C:\\repo\\docs\\x.md" }, "1"],
            ["Read", { file_path: "C:\\repo\\docs\\x.md" }, "1"]
        ]),
        { projectRoot: "C:\\repo" }
    );
    assert.deepEqual(s.filesRead, ["docs/x.md"]);
    const noRoot = analyzeSession(session("a", T0, [["Bash", { command: "cat docs/x.md" }, "1"]]));
    assert.deepEqual(noRoot.filesRead, ["docs/x.md"]);
});

test("shell reads: glob and variable paths ignored", () => {
    const s = analyzeSession(
        session("a", T0, [
            ["Bash", { command: "cat src/*.js" }, "1"],
            ["PowerShell", { command: "Get-Content $env:FOO" }, "1"]
        ])
    );
    assert.deepEqual(s.filesRead, []);
    assert.equal(s.discovery.calls, 2);
});

test("shell reads: chars attributed to first file only", () => {
    const s = analyzeSession(session("a", T0, [["Bash", { command: "cat a.js b.js" }, "12345"]]));
    assert.deepEqual(s.filesRead, ["a.js", "b.js"]);
    assert.equal(s.readCharsByFile["a.js"], 5);
    assert.equal(s.readCharsByFile["b.js"], 0);
});

test("within-session repeat reads and filesReadVia", () => {
    const s = analyzeSession(
        session("a", T0, [
            ["Read", { file_path: "/x/a.js" }, "1234"],
            ["Bash", { command: "cat /x/a.js" }, "123"],
            ["Read", { file_path: "/x/a.js" }, "12"],
            ["Read", { file_path: "/x/b.js" }, "1"]
        ])
    );
    assert.deepEqual(s.filesReadVia, { Read: 3, shell: 1 });
    assert.equal(s.repeatReadsInSession, 2);
    assert.equal(s.repeatReadChars, 5);
    const out = analyzeRescans([session("a", T0, [["Read", { file_path: "/x/a.js" }, "1"]])]);
    assert.deepEqual(out.sessions[0].filesReadVia, { Read: 1, shell: 0 });
    assert.equal(out.sessions[0].repeatReadsInSession, 0);
});

test("shell segments: cd prefix, && chains and Git Bash drive paths", async () => {
    const m = await import("../bench/analyze-rescans.mjs");
    assert.deepEqual(m.extractShellReadFiles("cd /c/bench/repo/platform; cat app/x.php", "C:/bench/repo"), ["platform/app/x.php"]);
    assert.deepEqual(
        m.extractShellReadFiles("cd platform && sed -n 1,20p a.php && grep -n foo b.php", "C:/bench/repo"),
        ["platform/a.php"]
    );
    assert.deepEqual(m.extractShellReadFiles("cat a.txt 2>/dev/null | head -5", "C:/r"), ["a.txt"]);
    assert.equal(m.categorizeToolUse({ name: "Bash", input: { command: "cd /c/bench/repo; ls routes" } }), "Bash");
    assert.equal(m.categorizeToolUse({ name: "Bash", input: { command: "cd platform && npm test" } }), null);
    assert.equal(m.normalizePath("/c/bench/repo/a.js", "C:/bench/repo"), "a.js");
    assert.deepEqual(m.splitShellSegments("a 'x;y' ; b | c && d || e\nf"), ["a 'x;y'", "b", "d", "e", "f"]);
});
