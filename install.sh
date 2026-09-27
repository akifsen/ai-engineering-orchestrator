#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20 or newer is required." >&2
    exit 1
fi
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec node "$root/scripts/aeo.mjs" "$@"
