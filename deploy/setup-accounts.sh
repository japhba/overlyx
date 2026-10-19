#!/bin/bash
# Accounts on the OverLyX server (DOCS.md "Accounts on the server"). Run as root from the production
# checkout, and again after a change — every step is idempotent:
#
#   bash /root/lyx/overlyx-production/deploy/setup-accounts.sh
#
#   root           the administrator — no agents run here
#   jan            development and every agent you start: its own projects, no other user's data;
#                  no sudo but `sudo overlyx-deploy`
#   overlyx-maint  the unattended maintenance worker (its timer is left as it is)
#
# Logins it cannot make for you are printed at the end. Personal files for jan (its CLAUDE.md files,
# a memory note) come from $OVERLYX_ACCOUNT_FILES (default /root/admin/jan) when that exists.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")/.." && pwd)
VOL=/mnt/HC_Volume_107166861
PROJECTS=$VOL/projects
DATA=/root/lyx/overlyx/data
REPO=japhba/overlyx
DEV=jan
DEV_HOME=/home/$DEV
MAINT=overlyx-maint
MAINT_HOME=/var/lib/overlyx-maintenance
INBOX=/var/lib/overlyx-maintenance-inbox
PERSONAL=${OVERLYX_ACCOUNT_FILES:-/root/admin/jan}
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
as() { local u=$1; shift; (cd / && runuser -u "$u" -- env HOME="$(getent passwd "$u" | cut -d: -f6)" PATH=/usr/local/bin:/usr/bin:/bin "$@"); }

step "accounts"
id "$DEV" >/dev/null 2>&1 || useradd --create-home --uid 1000 --user-group --shell /bin/bash --comment "development (no access to other users' data)" "$DEV"
chmod 700 "$DEV_HOME"
id "$MAINT" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$MAINT_HOME" --no-create-home --shell /usr/sbin/nologin --comment "OverLyX maintenance worker" "$MAINT"

step "users' data: root's alone"
for d in "$PROJECTS" "$VOL/backups" "$VOL/scratch" "$DATA" /root/lyx/overlyx-production/data; do
  if [ -e "$d" ]; then chmod 700 "$d"; fi
done
# leftovers of root's sessions and tests in /tmp, copies of documents among them (root keeps them)
find /tmp /var/tmp -maxdepth 1 -mindepth 1 -user root ! -type s ! -name '.*' ! -name 'systemd-private-*' ! -name 'snap-private-tmp' -perm /o+rwx -exec chmod go-rwx {} +

step "$DEV's own OverLyX projects at $DEV_HOME/projects, scratch space at $VOL/$DEV"
if [ -d "$PROJECTS/$DEV" ]; then
  # a bind mount, not a way through $PROJECTS: no one but root may traverse that
  setfacl -R -m "u:$DEV:rwX" "$PROJECTS/$DEV"
  find "$PROJECTS/$DEV" -type d -exec setfacl -m "d:u:$DEV:rwX" {} +
  install -d -o "$DEV" -g "$DEV" -m 700 "$DEV_HOME/projects"
  grep -q " $DEV_HOME/projects " /etc/fstab ||
    echo "$PROJECTS/$DEV $DEV_HOME/projects none bind,nofail,x-systemd.requires-mounts-for=$VOL 0 0" >> /etc/fstab
  systemctl daemon-reload
  mountpoint -q "$DEV_HOME/projects" || mount "$DEV_HOME/projects"
fi
install -d -o "$DEV" -g "$DEV" -m 700 "$VOL/$DEV"

step "ssh: $DEV logs in with root's keys and gets no forwarded agent"
install -d -o "$DEV" -g "$DEV" -m 700 "$DEV_HOME/.ssh"
[ -s "$DEV_HOME/.ssh/authorized_keys" ] || install -o "$DEV" -g "$DEV" -m 600 /root/.ssh/authorized_keys "$DEV_HOME/.ssh/authorized_keys"
conf=/etc/ssh/sshd_config.d/60-overlyx-accounts.conf
probe() { sshd -T -C "user=$1,host=client.example,addr=203.0.113.9" | sort; }
rm -f "$conf"
before_root=$(probe root); before_other=$(probe nobody)
cat > "$conf" <<EOF
# DOCS.md "Accounts on the server": a process running as $DEV must not be able to use a forwarded
# agent (the laptop's key) to log in as root
Match User $DEV
	AllowAgentForwarding no
EOF
# a Match block must change nothing but that, for no one but $DEV
if ! sshd -t || [ "$(probe root)" != "$before_root" ] || [ "$(probe nobody)" != "$before_other" ] ||
   ! probe "$DEV" | grep -qx 'allowagentforwarding no'; then
  rm -f "$conf"; echo "sshd: the Match block would have had other effects — not applied" >&2; exit 1
fi
systemctl reload ssh 2>/dev/null || true

step "AppArmor: user namespaces for bubblewrap and Codex's sandbox"
install -m 644 "$SRC/deploy/apparmor-overlyx-userns" /etc/apparmor.d/overlyx-userns
apparmor_parser -r /etc/apparmor.d/overlyx-userns

step "deploying from $DEV: sudo overlyx-deploy"
install -m 755 "$SRC/deploy/overlyx-deploy" /usr/local/sbin/overlyx-deploy
rule=$(mktemp)
sed "s/^jan /$DEV /" "$SRC/deploy/sudoers-overlyx-deploy" > "$rule"
visudo -cqf "$rule"
install -m 440 "$rule" /etc/sudoers.d/overlyx-deploy
rm -f "$rule"

# a deploy key with write access to $REPO alone: no other repository (not the mirrors), no API
deploy_key() {   # account home title
  local u=$1 home=$2 title=$3 key
  install -d -o "$u" -g "$u" -m 700 "$home/.ssh"
  [ -f "$home/.ssh/id_ed25519" ] || as "$u" ssh-keygen -q -t ed25519 -N '' -C "$title" -f "$home/.ssh/id_ed25519"
  # GitHub's host keys from its API (over TLS), not from a first-use scan
  gh api meta --jq '.ssh_keys[]' | sed 's/^/github.com /' > "$home/.ssh/known_hosts"
  chown "$u:" "$home/.ssh/known_hosts"; chmod 644 "$home/.ssh/known_hosts"
  key=$(cut -d' ' -f1,2 "$home/.ssh/id_ed25519.pub")
  gh api "repos/$REPO/keys" --jq '.[].key' | grep -qxF "$key" ||
    gh repo deploy-key add "$home/.ssh/id_ed25519.pub" -R "$REPO" --allow-write --title "$title"
}
codex_config() {   # the directory Codex may trust; model choices as root's
  grep -E '^(model|model_reasoning_effort|model_provider) *=' /root/.codex/config.toml 2>/dev/null || true
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$1"
}

step "$DEV's development tree: $DEV_HOME/lyx/overlyx"
deploy_key "$DEV" "$DEV_HOME" "$DEV@overlyx.app (development)"
if [ ! -d "$DEV_HOME/lyx" ]; then
  # the LyX source tree, for reference and its layouts — not the OverLyX checkouts beside it
  rsync -a --exclude '/overlyx' --exclude '/overlyx-*' --exclude '/.overlyx-*' --exclude '/.wt-*' --exclude '/node_modules' /root/lyx/ "$DEV_HOME/lyx/"
  chown -R "$DEV:$DEV" "$DEV_HOME/lyx"
fi
if [ ! -d "$DEV_HOME/lyx/overlyx/.git" ]; then
  as "$DEV" git clone -q "git@github.com:$REPO.git" "$DEV_HOME/lyx/overlyx"
  as "$DEV" git -C "$DEV_HOME/lyx/overlyx" config user.name "$(git -C /root/lyx/overlyx config user.name || echo OverLyX)"
  as "$DEV" git -C "$DEV_HOME/lyx/overlyx" config user.email "$(git -C /root/lyx/overlyx config user.email || echo overlyx@localhost)"
fi
[ -d "$DEV_HOME/lyx/overlyx/node_modules" ] || as "$DEV" sh -c 'cd "$1" && npm ci --no-audit --no-fund' sh "$DEV_HOME/lyx/overlyx"

step "Claude Code and Codex for $DEV"
claude_bin=$(readlink -f /root/.local/bin/claude)
if [ ! -e "$DEV_HOME/.local/bin/claude" ]; then
  as "$DEV" mkdir -p "$DEV_HOME/.local/bin" "$DEV_HOME/.local/share/claude/versions"
  install -o "$DEV" -g "$DEV" -m 755 "$claude_bin" "$DEV_HOME/.local/share/claude/versions/$(basename "$claude_bin")"
  as "$DEV" ln -s "$DEV_HOME/.local/share/claude/versions/$(basename "$claude_bin")" "$DEV_HOME/.local/bin/claude"
fi
install -d -o "$DEV" -g "$DEV" -m 700 "$DEV_HOME/.claude" "$DEV_HOME/.codex"
for f in settings.json settings.local.json; do
  if [ -f "/root/.claude/$f" ] && [ ! -f "$DEV_HOME/.claude/$f" ]; then
    sed "s#/root/lyx#$DEV_HOME/lyx#g" "/root/.claude/$f" > "$DEV_HOME/.claude/$f"; chown "$DEV:$DEV" "$DEV_HOME/.claude/$f"
  fi
done
# root's memory carries over (sessions started in ~ and in ~/lyx), with a note on what changed
for pair in "-root:-home-$DEV" "-root-lyx:-home-$DEV-lyx"; do
  from=/root/.claude/projects/${pair%%:*}/memory to=$DEV_HOME/.claude/projects/${pair##*:}/memory
  if [ -d "$from" ] && [ ! -d "$to" ]; then mkdir -p "$to"; cp -a "$from/." "$to/"; fi
done
if [ -d "$PERSONAL" ]; then
  if [ -f "$PERSONAL/CLAUDE.md" ]; then install -m 644 "$PERSONAL/CLAUDE.md" "$DEV_HOME/.claude/CLAUDE.md"; fi
  if [ -f "$PERSONAL/lyx-CLAUDE.md" ]; then install -o "$DEV" -g "$DEV" -m 644 "$PERSONAL/lyx-CLAUDE.md" "$DEV_HOME/lyx/CLAUDE.md"; fi
  mem=$DEV_HOME/.claude/projects/-home-$DEV/memory
  mkdir -p "$mem"
  for note in "$PERSONAL"/memory/*.md; do
    if [ -f "$note" ]; then install -m 644 "$note" "$mem/$(basename "$note")"; fi
  done
  # their lines go on top of the memory index, once
  if [ -f "$PERSONAL/memory-index.md" ] && ! grep -qxFf "$PERSONAL/memory-index.md" "$mem/MEMORY.md" 2>/dev/null; then
    cat "$PERSONAL/memory-index.md" "$mem/MEMORY.md" 2>/dev/null > "$mem/MEMORY.new"; mv "$mem/MEMORY.new" "$mem/MEMORY.md"
  fi
fi
chown -R "$DEV:$DEV" "$DEV_HOME/.claude"
[ -f "$DEV_HOME/.codex/config.toml" ] || codex_config "$DEV_HOME/lyx" > "$DEV_HOME/.codex/config.toml"
chown -R "$DEV:$DEV" "$DEV_HOME/.codex"; chmod 600 "$DEV_HOME/.codex/config.toml"

step "maintenance worker: $MAINT"
install -d -o root -g "$MAINT" -m 2750 "$INBOX"
install -d -m 755 /opt/overlyx-production /opt/lyx/lib   # mount points of the unit's read-only binds
if [ "$(stat -c %U "$MAINT_HOME" 2>/dev/null)" = root ]; then
  # transcripts of the runs made as root (that agent could read everything) stay root's
  install -d -m 700 /root/admin/maintenance-root-era
  find "$MAINT_HOME" -mindepth 1 -maxdepth 1 \( -name runs -o -name 'unfinished-*.patch' \) -exec mv -t /root/admin/maintenance-root-era/ {} +
fi
install -d -m 700 "$MAINT_HOME"
chown -R "$MAINT:$MAINT" "$MAINT_HOME"
deploy_key "$MAINT" "$MAINT_HOME" "$MAINT@overlyx.app (maintenance worker)"
install -d -o "$MAINT" -g "$MAINT" -m 700 "$MAINT_HOME/.codex"
if [ ! -f "$MAINT_HOME/.codex/config.toml" ]; then
  codex_config "$MAINT_HOME/checkout" > "$MAINT_HOME/.codex/config.toml"
  chown "$MAINT:$MAINT" "$MAINT_HOME/.codex/config.toml"; chmod 600 "$MAINT_HOME/.codex/config.toml"
fi
install -m 644 "$SRC/deploy/overlyx-maintenance.service" /etc/systemd/system/overlyx-maintenance.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/overlyx-maintenance.service

if [ -d "$PERSONAL" ] && [ -f "$PERSONAL/root-CLAUDE-note.md" ] && ! grep -q 'Accounts on the server' /root/.claude/CLAUDE.md 2>/dev/null; then
  { cat "$PERSONAL/root-CLAUDE-note.md"; echo; cat /root/.claude/CLAUDE.md; } > /root/.claude/CLAUDE.md.new && mv /root/.claude/CLAUDE.md.new /root/.claude/CLAUDE.md
fi

step "checks"
fail=0
ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fail=1; }
other=$(ls "$PROJECTS" | grep -vx "$DEV" | head -1)
for u in "$DEV" "$MAINT"; do
  for p in "$PROJECTS" "$PROJECTS/$other" "$VOL/backups" "$VOL/scratch" "$DATA" /root /root/lyx/overlyx-production; do
    if as "$u" ls "$p" >/dev/null 2>&1; then bad "$u can list $p"; else ok "$u cannot list $p"; fi
  done
done
as "$MAINT" ls "$INBOX" >/dev/null 2>&1 && ok "$MAINT reads its inbox" || bad "$MAINT cannot read $INBOX"
if [ -d "$PROJECTS/$DEV" ]; then
  as "$DEV" test -w "$DEV_HOME/projects" && as "$DEV" ls "$DEV_HOME/projects" >/dev/null && ok "$DEV reads and writes its own projects" || bad "$DEV cannot reach $DEV_HOME/projects"
fi
as "$DEV" bwrap --ro-bind / / --proc /proc --dev /dev --unshare-all true && ok "bubblewrap works for $DEV" || bad "bubblewrap fails for $DEV"
as "$DEV" codex sandbox -- /bin/true >/dev/null 2>&1 && ok "Codex's sandbox works for $DEV" || bad "Codex's sandbox fails for $DEV"
rules=$(sudo -l -U "$DEV" | grep -E '^[[:space:]]+\(' || true)
[ "$(printf '%s\n' "$rules" | grep -c .)" = 1 ] && grep -q /usr/local/sbin/overlyx-deploy <<<"$rules" && ok "$DEV's only sudo: overlyx-deploy" || bad "$DEV's sudo rights: $rules"
# the worker's unit sandbox as the unit sets it up: the runner bound in, Codex's sandbox working,
# /root, /home and /mnt gone
systemd-run --quiet --wait --pipe --collect -p User="$MAINT" -p Group="$MAINT" -p NoNewPrivileges=yes \
  -p ProtectHome=yes -p InaccessiblePaths=-/mnt -p ProtectProc=invisible -p PrivateTmp=yes -p ProtectSystem=strict \
  -p ReadWritePaths="$MAINT_HOME" -p BindReadOnlyPaths=/root/lyx/overlyx-production:/opt/overlyx-production \
  -E HOME="$MAINT_HOME" /bin/sh -c 'test -r /opt/overlyx-production/scripts/maintenance.ts || exit 3
    for p in /root /home /mnt; do ls "$p" >/dev/null 2>&1 && exit 4; done
    codex sandbox -- /bin/true >/dev/null 2>&1 || exit 5' && ok "the worker's unit sandbox: runner bound in, Codex sandbox works, /root /home /mnt hidden" \
  || bad "the worker's unit sandbox (exit $?: 3 runner missing, 4 a hidden path visible, 5 Codex's sandbox fails)"
for u in "$DEV" "$MAINT"; do
  # (ssh -T always exits 1 at GitHub: judge its greeting, not its status — pipefail would)
  greeting=$(as "$u" ssh -o BatchMode=yes -T git@github.com 2>&1 || true)
  grep -q "successfully authenticated" <<<"$greeting" && ok "$u pushes to $REPO" || bad "$u: no GitHub access over ssh ($greeting)"
done
[ "$fail" = 0 ] || { echo; echo "some checks failed (above)" >&2; exit 1; }

cat <<EOF

Done. What only you can do:
  1. Log in as $DEV:  ssh $DEV@overlyx.app   (the same key as root; in VS Code Remote and the Codex
     app, change the SSH target to $DEV@ too)
  2. As $DEV:  claude   (then /login)   and   codex login --device-auth
  3. The worker's Codex login:
       runuser -u $MAINT -- env HOME=$MAINT_HOME codex login --device-auth
  4. Resume the worker when you want (it is still paused if it was):
       systemctl enable --now overlyx-maintenance.timer
  5. End the agent sessions still running as root (tmux, VS Code, the Codex app): they keep full
     access until they stop. Work as $DEV from now on; root is for administration.
EOF
