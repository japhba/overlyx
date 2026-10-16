#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
state_dir=${OVERLYX_MAINTENANCE_STATE:-/var/lib/overlyx-maintenance}
umask 077
mkdir -p "$state_dir"
exec flock -n "$state_dir/run.lock" npx --no-install tsx scripts/maintenance.ts "$@"
