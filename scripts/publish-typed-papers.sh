#!/usr/bin/env bash
# Publish the typed-via-GUI e2e paper projects into the production projects directory, owned by
# the admin account — so the latest results of the "a user writes a paper" suites can always be
# inspected by signing in as admin on the live instance.
#
# Run the paperwriting suites against an isolated instance with OVERLYX_E2E_KEEP=1 first
# (README "Tests"), then:
#
#   scripts/publish-typed-papers.sh <projects-dir-of-the-isolated-run>
#
# Every e2e-paper* directory found there (e2e-paperwriting, e2e-paperwriting-more,
# e2e-paper-gan, e2e-paper-adam, e2e-paper-vae) is rsynced into $OVERLYX_PROJECTS_DIR (default
# /root/projects) and its projects row is created/updated to belong to the instance owner's
# account — the admin user whose e-mail is $OVERLYX_OWNER_EMAIL (default japhba@gmail.com, the
# account the papers are inspected from), falling back to the seeded `admin` user; the running
# server picks up the new content through its file watcher, so no restart is needed.
set -euo pipefail

SRC=${1:?usage: publish-typed-papers.sh <projects dir of the isolated e2e run>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=${OVERLYX_PROJECTS_DIR:-/root/projects}
DB=${OVERLYX_DATA_DIR:-$ROOT/data}/overlyx.sqlite
OWNER_EMAIL=${OVERLYX_OWNER_EMAIL:-japhba@gmail.com}

ADMIN=$(sqlite3 "$DB" "SELECT id FROM users WHERE lower(email)=lower('$OWNER_EMAIL') AND is_admin=1 ORDER BY id LIMIT 1")
[ -n "$ADMIN" ] || ADMIN=$(sqlite3 "$DB" "SELECT id FROM users WHERE username='admin' AND is_admin=1 ORDER BY id LIMIT 1")
[ -n "$ADMIN" ] || { echo "no admin user in $DB" >&2; exit 1; }
OWNER=$(sqlite3 "$DB" "SELECT username FROM users WHERE id=$ADMIN")

published=0
for dir in "$SRC"/e2e-paper*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  mkdir -p "$DEST/$name"
  # test markers, citation-key caches, build products and the scratch git history stay behind
  rsync -a --delete --exclude _build --exclude .git --exclude '.keys.json' --exclude '.complete' --exclude '.appendix*' "$dir/" "$DEST/$name/"
  sqlite3 "$DB" "INSERT INTO projects (name, owner_id, kind, created_at) VALUES ('$name', $ADMIN, 'project', CAST(strftime('%s','now') AS INTEGER) * 1000)
                 ON CONFLICT(name) DO UPDATE SET owner_id = $ADMIN;"
  echo "published $name -> $DEST/$name (owner: $OWNER, user #$ADMIN)"
  published=$((published + 1))
done

[ "$published" -gt 0 ] || { echo "no e2e-paper* projects in $SRC — run the paperwriting suites with OVERLYX_E2E_KEEP=1 first" >&2; exit 1; }
