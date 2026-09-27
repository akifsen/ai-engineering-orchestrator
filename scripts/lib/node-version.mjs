export function unsupportedNodeMessage(version = process.versions.node) {
    const text = version == null ? "" : String(version);
    const major = Number(text.split(".")[0]);
    if (Number.isInteger(major) && major >= 20) {
        return null;
    }
    const shown = text.trim() ? text : "unknown";
    return [
        "AEO requires Node.js 20 or newer.",
        `Current version: ${shown}`,
        "",
        "Upgrade Node.js before continuing."
    ].join("\n");
}
