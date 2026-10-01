import { readFileSync } from "node:fs";
import { assertTagMatchesCanonicalVersions } from "./lib/release-publish.mjs";
import { AEO_VERSION } from "./lib/installer.mjs";

const tag = process.env.RELEASE_TAG || "";
const root = JSON.parse(readFileSync("package.json", "utf8"));
const versions = {
    "package.json": root.version,
    AEO_VERSION
};
if (root.name !== "ai-engineering-orchestrator") {
    console.error(`Unexpected package name ${root.name}.`);
    process.exit(1);
}
for (const directory of ["bridge/antigravity-mcp", "bridge/cursor-mcp"]) {
    const pkg = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
    const lock = JSON.parse(readFileSync(`${directory}/package-lock.json`, "utf8"));
    versions[`${directory}/package.json`] = pkg.version;
    versions[`${directory}/package-lock.json`] = lock.version;
    versions[`${directory}/package-lock.json packages`] = lock.packages?.[""]?.version;
}
const result = assertTagMatchesCanonicalVersions(tag, versions);
if (!result.ok) {
    console.error(result.message);
    process.exit(1);
}
console.log(`Tag ${tag} matches canonical version ${result.version}.`);
