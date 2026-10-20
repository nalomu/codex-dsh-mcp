#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node dist/cli.js launchd-uninstall "$@"
