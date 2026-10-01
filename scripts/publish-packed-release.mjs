import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
    classifyRegistryLookup,
    decideReleasePublish,
    parsePackJson,
    publishArguments,
    releaseVersionFromTag
} from "./lib/release-publish.mjs";

const destination = process.env.PACK_DESTINATION;
const tag = process.env.RELEASE_TAG || "";
if (!destination) {
    console.error("PACK_DESTINATION is required.");
    process.exit(1);
}
const tagged = releaseVersionFromTag(tag);
if (!tagged.ok) {
    console.error(tagged.message);
    process.exit(1);
}
const artifact = parsePackJson(readFileSync(path.join(destination, "pack.json"), "utf8"));
if (artifact.name !== "ai-engineering-orchestrator" || artifact.version !== tagged.version) {
    console.error(`Packed ${artifact.name}@${artifact.version} does not match tag ${tag}.`);
    process.exit(1);
}
const tarball = path.join(destination, artifact.filename);
const viewed = spawnSync("npm", ["view", `${artifact.name}@${artifact.version}`, "dist", "--json"], {
    encoding: "utf8"
});
const registry = classifyRegistryLookup({
    status: viewed.status,
    stdout: viewed.stdout,
    stderr: viewed.stderr,
    error: viewed.error
});
const decision = decideReleasePublish({ artifact, registry });
console.log(decision.message);
if (!decision.ok) {
    process.exit(1);
}
if (!decision.shouldPublish) {
    process.exit(0);
}
const published = spawnSync("npm", publishArguments(tarball), {
    encoding: "utf8",
    stdio: "inherit"
});
if (published.error) {
    console.error(published.error.message);
    process.exit(1);
}
process.exit(published.status ?? 1);
