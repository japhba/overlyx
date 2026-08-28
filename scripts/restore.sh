#!/bin/bash
# Restore a backup made by scripts/backup.sh (<backups>/<timestamp>/{overlyx.sqlite,secret.key,projects.tar.gz})
# into a data directory and a projects directory:
#
#   scripts/restore.sh <backup dir> <data dir> <projects dir> [--force]
#
# Targets must be empty (or absent) unless --force is given; with --force the existing database and
# projects directory are moved aside as *.before-restore-<timestamp> first, never deleted. Then start
# the server on the restored directories — for a drill, an isolated instance:
#
#   OVERLYX_DATA_DIR=<data dir> OVERLYX_PROJECTS_DIR=<projects dir> PORT=3002 HOST=127.0.0.1 npx tsx packages/server/src/index.ts
#
# For the real thing: systemctl stop overlyx; restore into the production directories with --force;
# systemctl start overlyx. Passwords are in the database (hashed); data/credentials.txt is *not* part
# of a backup. The projects' git repositories are restored with the projects.
set -euo pipefail
src=${1:?backup dir}; data=${2:?data dir}; projects=${3:?projects dir}; force=${4:-}
[ -f "$src/overlyx.sqlite" ] || { echo "$src has no overlyx.sqlite" >&2; exit 1; }
[ -f "$src/projects.tar.gz" ] || { echo "$src has no projects.tar.gz" >&2; exit 1; }
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
aside() { if [ -e "$1" ]; then [ "$force" = "--force" ] || { echo "$1 exists — pass --force to move it aside" >&2; exit 1; }; mv "$1" "$1.before-restore-$stamp"; echo "moved $1 aside"; fi; }

# database (+ the JWT secret, so that sessions survive)
mkdir -p "$data"
aside "$data/overlyx.sqlite"
sqlite3 "$src/overlyx.sqlite" "PRAGMA integrity_check" | grep -qx ok || { echo "backup database fails integrity_check" >&2; exit 1; }
cp -p "$src/overlyx.sqlite" "$data/overlyx.sqlite"
rm -f "$data/overlyx.sqlite-wal" "$data/overlyx.sqlite-shm"
[ -f "$src/secret.key" ] && { aside "$data/secret.key"; install -m 600 "$src/secret.key" "$data/secret.key"; }

# projects: the tarball holds one top-level directory (the basename of the projects dir at backup time)
if [ -d "$projects" ] && [ -n "$(ls -A "$projects")" ]; then aside "$projects"; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar --extract --gzip --file "$src/projects.tar.gz" -C "$tmp"
top=$(ls -1 "$tmp" | head -1)
mkdir -p "$projects"
cp -a "$tmp/$top/." "$projects/"

echo "restored $src:"
echo "  users=$(sqlite3 "$data/overlyx.sqlite" 'SELECT COUNT(*) FROM users') projects=$(sqlite3 "$data/overlyx.sqlite" 'SELECT COUNT(*) FROM projects') versions=$(sqlite3 "$data/overlyx.sqlite" 'SELECT COUNT(*) FROM versions') ydocs=$(sqlite3 "$data/overlyx.sqlite" 'SELECT COUNT(*) FROM ydocs')"
echo "  project directories: $(ls -1 "$projects" | wc -l), .lyx files: $(find "$projects" -name '*.lyx' -not -path '*/.git/*' | wc -l)"
