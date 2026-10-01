import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parsePackJson } from "./lib/release-publish.mjs";

const destination = process.env.PACK_DESTINATION;
if (!destination) {
    console.error("PACK_DESTINATION is required.");
    process.exit(1);
}
mkdirSync(destination, { recursive: true });
const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
    encoding: "utf8"
});
if (packed.error || packed.status !== 0) {
    console.error(packed.error?.message || packed.stderr || packed.stdout);
    process.exit(packed.status || 1);
}
const artifact = parsePackJson(packed.stdout);
writeFileSync(path.join(destination, "pack.json"), packed.stdout);
console.log([
    `filename=${artifact.filename}`,
    `name=${artifact.name}`,
    `version=${artifact.version}`,
    `integrity=${artifact.integrity}`,
    `shasum=${artifact.shasum}`,
    `size=${artifact.size}`,
    `unpackedSize=${artifact.unpackedSize}`,
    `entryCount=${artifact.entryCount}`,
    `path=${path.join(destination, artifact.filename)}`
].join("\n"));
