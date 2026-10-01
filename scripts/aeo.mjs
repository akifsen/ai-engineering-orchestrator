#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedNodeMessage } from "./lib/node-version.mjs";

const versionError = unsupportedNodeMessage();
if (versionError) {
    console.error(versionError);
    process.exit(1);
}

const { doctor, formatPlan, install, status, uninstall } = await import("./lib/installer.mjs");

const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
    return args.includes(name);
}

function option(name) {
    const index = args.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    return args[index + 1];
}

function usage() {
    return [
        "Usage:",
        "  aeo <install|update|uninstall|status|doctor>",
        "    --target <project>",
        "    [--codex]",
        "    [--claude]",
        "    [--dry-run]",
        "    [--force-managed-update]",
        "    [--force-remove-modified]",
        "    [--global]",
        "    [--adopt]",
        "    [--replace-codex-agents-md]",
        "",
        "Pass --codex, --claude, or both. AEO does not guess which tools to configure.",
        "install and update reconcile the project. They do not overwrite AEO files you edited.",
        "--dry-run writes nothing. --force-managed-update replaces edited AEO files after writing a backup.",
        "uninstall keeps edited AEO files unless you pass --force-remove-modified.",
        "Project Codex and Claude changes stay inside the target. Global Codex and Claude config is not edited unless --global.",
        "-h and --help print this usage."
    ].join("\n");
}

const known = new Set(["install", "update", "uninstall", "status", "doctor"]);
const help = !command || command === "--help" || command === "-h";
if (help || !known.has(command)) {
    console.log(usage());
    process.exit(help ? 0 : 1);
}

const isGlobal = flag("--global");
const hasTarget = flag("--target");
const target = option("--target");
const adopt = flag("--adopt");
const replaceCodexAgentsMd = flag("--replace-codex-agents-md");

if ((isGlobal && hasTarget) || (!isGlobal && !hasTarget)) {
    console.error("Pass either --target <project> or --global, not both.");
    console.error(usage());
    process.exit(1);
}

if (hasTarget && (!target || target.startsWith("--"))) {
    console.error("Pass --target <project>.");
    console.error(usage());
    process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codex = flag("--codex");
const claude = flag("--claude");
const dryRun = flag("--dry-run");
const forceManagedUpdate = flag("--force-managed-update");
const forceRemoveModified = flag("--force-remove-modified");

try {
    if (command === "install" || command === "update") {
        const result = await install({ target, global: isGlobal, adopt, replaceCodexAgentsMd, codex, claude, dryRun, repoRoot, forceManagedUpdate });
        console.log(formatPlan(result));
        if (result.ok && !dryRun && result.changed.length === 0) {
            console.log("No changes.");
        }
        if (!dryRun && result.backupFiles?.length) {
            console.log("Backups are recovery copies only. Uninstall does not restore them over newer edits.");
        }
        process.exit(result.ok ? 0 : 1);
    }
    if (command === "uninstall") {
        const result = await uninstall({ target, global: isGlobal, adopt, replaceCodexAgentsMd, repoRoot, forceRemoveModified });
        if (!result.ok) {
            console.error(result.error);
            process.exit(1);
        }
        console.log(result.changed.length ? result.changed.join("\n") : "No AEO-owned changes to remove.");
        for (const file of result.preserved || []) {
            console.log(`USER MODIFIED — PRESERVED: ${file}`);
        }
        if (result.preserved?.length) {
            console.log("Customized AEO files were left in place and are no longer tracked. A later install will not overwrite them. Pass --force-remove-modified to delete them.");
            if (result.preserved.some((item) => item.includes("block"))) {
                console.log("A kept managed block is a preserved orphaned AEO block. The markers stay, and this installation no longer owns it. A later install will not adopt or overwrite it.");
            }
        }
        process.exit(0);
    }
    if (command === "status") {
        const report = await status({ target, global: isGlobal, adopt, replaceCodexAgentsMd });
        console.log(JSON.stringify({
            installed: report.installed,
            projectId: report.manifest?.projectId || null,
            ownership: report.ownership,
            codex: report.codex,
            claude: report.claude,
            bridge: report.bridge,
            trustNote: report.trustNote
        }, null, 2));
        process.exit(0);
    }
    const report = await doctor({ target, global: isGlobal, adopt, replaceCodexAgentsMd });
    for (const problem of report.problems) {
        console.error(`Problem: ${problem}`);
    }
    for (const warning of report.warnings) {
        console.log(`Warning: ${warning}`);
    }
    console.log(report.ok ? "Doctor found no problems." : "Doctor found problems.");
    process.exit(report.ok ? 0 : 1);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
