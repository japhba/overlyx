#!/bin/bash
# Debug replay and reduced fuzz settings must never weaken a release candidate's checks.
set -euo pipefail
cd "$(dirname "$0")/.."
for fuzz_key in "${!OVERLYX_FUZZ_@}"; do
  [ -n "$fuzz_key" ] && unset "$fuzz_key"
done
export OVERLYX_FUZZ_STRICT=1
npx vitest run
OVERLYX_FUZZ_JOINS=1 npx vitest run tests/split-fuzz.test.ts
