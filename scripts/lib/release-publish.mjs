const STABLE_TAG = /^v([0-9]+\.[0-9]+\.[0-9]+)$/;

export function releaseVersionFromTag(tag) {
    const match = STABLE_TAG.exec(tag || "");
    if (!match) {
        return {
            ok: false,
            message: `Refusing to publish from ${tag || "(missing tag)"}. Use a stable vX.Y.Z tag.`
        };
    }
    return { ok: true, version: match[1] };
}

export function assertTagMatchesCanonicalVersions(tag, versions) {
    const parsed = releaseVersionFromTag(tag);
    if (!parsed.ok) {
        return parsed;
    }
    for (const [label, value] of Object.entries(versions)) {
        if (value !== parsed.version) {
            return {
                ok: false,
                version: parsed.version,
                message: `${label} is ${value}, tag ${tag} requires ${parsed.version}.`
            };
        }
    }
    return { ok: true, version: parsed.version };
}

export function parsePackJson(stdout) {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start < 0 || end <= start) {
        throw new Error("npm pack did not return a JSON artifact list.");
    }
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error("npm pack must describe exactly one artifact.");
    }
    const artifact = parsed[0];
    for (const field of ["name", "version", "filename", "integrity", "shasum", "size", "unpackedSize", "entryCount"]) {
        if (artifact[field] === undefined || artifact[field] === null || artifact[field] === "") {
            throw new Error(`npm pack artifact is missing ${field}.`);
        }
    }
    return artifact;
}

export function classifyRegistryLookup({ status, stdout = "", stderr = "", error = null }) {
    if (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "error", message };
    }
    const output = `${stdout}\n${stderr}`;
    if (status !== 0) {
        if (/\bE404\b/.test(output) || /404 Not Found/.test(output)) {
            return { kind: "absent" };
        }
        const message = output.trim() || `npm view exited ${status}.`;
        return { kind: "error", message };
    }
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) {
        return { kind: "error", message: "npm view succeeded without a dist object." };
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
    } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        return { kind: "error", message };
    }
    return {
        kind: "present",
        version: typeof parsed.version === "string" ? parsed.version : undefined,
        integrity: typeof parsed.integrity === "string" ? parsed.integrity : undefined,
        shasum: typeof parsed.shasum === "string" ? parsed.shasum : undefined
    };
}

export function decideReleasePublish({ artifact, registry }) {
    const name = artifact?.name;
    const version = artifact?.version;
    if (!name || !version || !artifact?.integrity || !artifact?.shasum) {
        return {
            ok: false,
            shouldPublish: false,
            alreadyPublished: false,
            message: "Packed artifact is missing its name, version, integrity, or shasum."
        };
    }
    if (!registry || registry.kind === "error") {
        return {
            ok: false,
            shouldPublish: false,
            alreadyPublished: false,
            message: `npm registry lookup failed.\n${registry?.message || "Unknown registry error."}`
        };
    }
    if (registry.kind === "absent") {
        return {
            ok: true,
            shouldPublish: true,
            alreadyPublished: false,
            message: `${name}@${version} is not on npm yet.`
        };
    }
    if (registry.kind !== "present") {
        return {
            ok: false,
            shouldPublish: false,
            alreadyPublished: false,
            message: "npm registry lookup returned an unexpected result."
        };
    }
    if (registry.version && registry.version !== version) {
        return mismatch(name, version, artifact, registry);
    }
    if (registry.integrity === artifact.integrity && registry.shasum === artifact.shasum) {
        return {
            ok: true,
            shouldPublish: false,
            alreadyPublished: true,
            message: `${name}@${version} already exists and matches the exact packed artifact.\nNothing to publish.`
        };
    }
    return mismatch(name, version, artifact, registry);
}

function mismatch(name, version, artifact, registry) {
    return {
        ok: false,
        shouldPublish: false,
        alreadyPublished: false,
        message: [
            "SECURITY ERROR:",
            `${name}@${version} already exists but its registry artifact does not match this release.`,
            "Refusing to continue.",
            `integrity local=${artifact.integrity} registry=${registry.integrity ?? ""}`,
            `shasum local=${artifact.shasum} registry=${registry.shasum ?? ""}`
        ].join("\n")
    };
}

export function publishArguments(tarballPath) {
    return ["publish", tarballPath, "--access", "public"];
}
