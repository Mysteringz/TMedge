#!/usr/bin/env bash
# The server half of deploy.sh. It is streamed over ssh and run as root:
#   ssh <host> 'sudo bash -s -- <command> [args]' < deploy/remote.sh
#
#   migrate            one-time: turn the rsync'd /opt/tmedge into a release
#   activate <id>      install deps for an uploaded release, switch to it,
#                      health-check, and switch back by itself if it fails
#   rollback [<id>]    switch to <id>, or to the release before the current one
#   list               releases, newest first, current marked
#   preflight          fail unless migrated; deploy.sh runs it before uploading
#
# Layout it maintains:
#   /opt/tmedge                  -> symlink to the live release; the systemd
#                                   units point here and never need to change
#   /opt/tmedge-releases/<id>/   one build each; <id> = UTC time + git sha, so
#                                   names sort in deploy order
#   /opt/tmedge-shared/.env      the only secret, linked into every release,
#                                   never uploaded and never printed
#
# Why releases and not rsync over the live tree: rsync --delete leaves nothing
# to go back to, and a half-finished copy is live the moment it is written.
# Here the old tree is untouched until one rename makes the new one current.
#
# Every path and command is overridable so test/deploy.test.sh can drive this
# exact file against a scratch directory on the dev Mac.
set -euo pipefail

BASE="${TM_BASE:-/opt}"
LIVE="$BASE/tmedge"
RELEASES="$BASE/tmedge-releases"
SHARED="$BASE/tmedge-shared"
KEEP="${TM_KEEP:-5}"
SERVICES="${TM_SERVICES:-tmedge-edge tmedge-web tmedge-sim}"
SYSTEMCTL="${TM_SYSTEMCTL:-systemctl}"
OWNER="${TM_OWNER:-root:root}"
ENV_OWNER="${TM_ENV_OWNER:-tmedge:tmedge}"
WEB_HEALTH="${TM_WEB_HEALTH:-http://127.0.0.1:8080/healthz}"
CONSOLE_HEALTH="${TM_CONSOLE_HEALTH:-http://127.0.0.1:8090/}"
# The algo debugger, which runs inside the edge process. Empty skips the check,
# for a box that runs with ALGO_PORT=0.
ALGO_HEALTH="${TM_ALGO_HEALTH:-http://127.0.0.1:8091/api/catalogue}"
# How long a service must stay up without systemd restarting it. Restart=always
# makes a crash-looping unit look "active" between attempts, so a plain
# is-active right after restart would pass a release that dies in 2 s.
SETTLE="${TM_SETTLE:-10}"
# sudo's secure_path on Amazon Linux leaves out /usr/local/bin, where node is.
NPM="${TM_NPM:-/usr/local/bin/npm}"
[ -x "$NPM" ] || NPM="$(command -v npm)"

say() { printf '[remote] %s\n' "$*"; }
die() { printf '[remote] ERROR: %s\n' "$*" >&2; exit 1; }

current_id() { basename "$(readlink "$LIVE")"; }

# Newest first. Only directories whose names look like release ids.
release_ids() {
  [ -d "$RELEASES" ] || return 0
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '20*' -exec basename {} \; | sort -r
}

# Point $LIVE at a release with a single rename, so no request ever finds the
# path missing or half-switched. BSD mv (the test Mac) has no -T; ln -sfh is
# its non-atomic stand-in and only ever runs in the test.
point_live_at() {
  local target="$RELEASES/$1"
  ln -sfn "$target" "$LIVE.next"
  if mv -T "$LIVE.next" "$LIVE" 2>/dev/null; then :; else
    rm -f "$LIVE.next"; ln -sfh "$target" "$LIVE"
  fi
}

restart_services() {
  # 9>&-: nothing started from here may inherit the deploy lock, or a process
  # that outlives this script would hold it and block every later deploy.
  # shellcheck disable=SC2086
  "$SYSTEMCTL" restart $SERVICES 9>&-
}

restarts_of() { "$SYSTEMCTL" show -p NRestarts --value "$1" 2>/dev/null || echo 0; }

http_status() { curl -s -o /dev/null -m 4 -w '%{http_code}' "$1" 2>/dev/null || true; }

# Healthy = every unit active and not restarted by systemd during SETTLE,
# the student site's /healthz answers 200, and the console and the algo
# debugger answer at all (401 is correct: they want the admin password).
healthy() {
  local s before=() i=0 web console algo
  for s in $SERVICES; do before+=("$(restarts_of "$s")"); done
  sleep "$SETTLE"
  for s in $SERVICES; do
    "$SYSTEMCTL" is-active --quiet "$s" || { say "$s is not active"; return 1; }
    [ "$(restarts_of "$s")" = "${before[$i]}" ] || { say "$s restarted by itself while settling (crash loop)"; return 1; }
    i=$((i + 1))
  done
  for i in $(seq 15); do
    web="$(http_status "$WEB_HEALTH")"
    console="$(http_status "$CONSOLE_HEALTH")"
    algo=ok
    [ -z "$ALGO_HEALTH" ] || case "$(http_status "$ALGO_HEALTH")" in
      200|401) algo=ok ;;
      *) algo="$(http_status "$ALGO_HEALTH")" ;;
    esac
    if [ "$web" = 200 ] && { [ "$console" = 200 ] || [ "$console" = 401 ]; } && [ "$algo" = ok ]; then
      say "healthy: web $web, console $console, algo $algo"
      return 0
    fi
    sleep 2
  done
  say "unhealthy: web ${web:-none}, console ${console:-none}, algo ${algo:-none}"
  return 1
}

# Links the shared secret (and, if the old install had one, the data dir) into
# a release, so the units' EnvironmentFile=/opt/tmedge/.env keeps resolving.
link_shared() {
  local dir="$1"
  ln -sfn "$SHARED/.env" "$dir/.env"
  if [ -d "$SHARED/data" ]; then rm -rf "$dir/data"; ln -sfn "$SHARED/data" "$dir/data"; fi
}

require_migrated() {
  [ -L "$LIVE" ] || die "$LIVE is not a release symlink yet. Run: deploy/deploy.sh migrate"
  [ -f "$SHARED/.env" ] || die "$SHARED/.env is missing"
}

prune() {
  local cur prev n=0 id
  cur="$(current_id)"; prev="${1:-}"
  for id in $(release_ids); do
    n=$((n + 1))
    [ "$n" -le "$KEEP" ] && continue
    [ "$id" = "$cur" ] || [ "$id" = "$prev" ] && continue
    say "pruning $id"
    rm -rf "${RELEASES:?}/$id"
  done
}

cmd_migrate() {
  if [ -L "$LIVE" ]; then say "already migrated: $LIVE -> $(readlink "$LIVE")"; return 0; fi
  [ -d "$LIVE" ] || die "$LIVE does not exist"
  [ -f "$LIVE/.env" ] || die "$LIVE/.env not found; refusing to guess where the secret is"
  local id; id="$(date -u +%Y%m%dT%H%M%SZ)-pre-pipeline"
  mkdir -p "$RELEASES" "$SHARED"
  say "moving the current install to releases/$id"
  mv "$LIVE/.env" "$SHARED/.env"
  if [ -d "$LIVE/data" ] && [ ! -L "$LIVE/data" ]; then mv "$LIVE/data" "$SHARED/data"; fi
  mv "$LIVE" "$RELEASES/$id"
  link_shared "$RELEASES/$id"
  point_live_at "$id"
  restart_services
  if healthy; then say "migrated; live = $id"; return 0; fi
  # Undo exactly, so a failed migration leaves the box as it was found.
  say "unhealthy after migration; restoring the original layout"
  rm -f "$LIVE" "$RELEASES/$id/.env"
  [ -L "$RELEASES/$id/data" ] && rm -f "$RELEASES/$id/data" && mv "$SHARED/data" "$RELEASES/$id/data"
  mv "$RELEASES/$id" "$LIVE"
  mv "$SHARED/.env" "$LIVE/.env"
  restart_services
  die "migration rolled back; nothing changed"
}

cmd_activate() {
  local id="${1:?release id}" dir prev cur
  require_migrated
  dir="$RELEASES/$id"
  [ -f "$dir/dist/src/web/main.js" ] || die "$dir has no build (dist/src/web/main.js)"
  prev="$(current_id)"
  [ "$prev" != "$id" ] || die "$id is already live"

  # Same lockfile as the running release -> reuse its node_modules: faster,
  # and a deploy does not depend on the npm registry being up.
  if [ -d "$RELEASES/$prev/node_modules" ] && cmp -s "$RELEASES/$prev/package-lock.json" "$dir/package-lock.json"; then
    say "dependencies unchanged; copying node_modules from $prev"
    cp -a "$RELEASES/$prev/node_modules" "$dir/"
  else
    say "installing runtime dependencies"
    (cd "$dir" && "$NPM" ci --omit=dev --no-audit --no-fund)
  fi
  link_shared "$dir"
  # rsync as root keeps the uploader's uid and modes; the service may read its
  # code and never write it, whatever umask or mktemp the uploader had.
  # (chmod -R does not follow the .env symlink; the secret is re-locked below.)
  chown -R "$OWNER" "$dir"
  chown -h "$OWNER" "$dir/.env"
  chmod -R u=rwX,go=rX "$dir"
  chown "$ENV_OWNER" "$SHARED/.env" && chmod 600 "$SHARED/.env"

  say "switching $prev -> $id"
  point_live_at "$id"
  restart_services
  if healthy; then
    say "live: $id"
    prune "$prev"
    return 0
  fi
  say "rolling back to $prev"
  point_live_at "$prev"
  restart_services
  healthy || say "WARNING: $prev is not healthy either; look at journalctl -u tmedge-web -u tmedge-edge"
  # A release that failed its health check is deleted, so a later
  # "rollback" (which picks the release before the live one) can never land
  # on it. Its id stays in this output and the journal.
  rm -rf "${RELEASES:?}/$id"
  die "deploy of $id failed and was rolled back to $prev (release deleted)"
}

cmd_rollback() {
  local target="${1:-}" cur
  require_migrated
  cur="$(current_id)"
  if [ -z "$target" ]; then
    target="$(release_ids | awk -v c="$cur" 'found { print; exit } $0 == c { found = 1 }')"
    [ -n "$target" ] || die "no release older than $cur to roll back to"
  fi
  [ -d "$RELEASES/$target" ] || die "no release $target"
  [ "$target" != "$cur" ] || die "$target is already live"
  say "rolling back $cur -> $target"
  point_live_at "$target"
  restart_services
  if healthy; then say "live: $target"; return 0; fi
  say "$target is unhealthy; switching back to $cur"
  point_live_at "$cur"
  restart_services
  healthy || say "WARNING: $cur is not healthy either; look at journalctl -u tmedge-web -u tmedge-edge"
  die "rollback to $target failed; $cur is live again"
}

cmd_list() {
  local cur=""; [ -L "$LIVE" ] && cur="$(current_id)"
  local id
  for id in $(release_ids); do
    if [ "$id" = "$cur" ]; then printf '* %s\n' "$id"; else printf '  %s\n' "$id"; fi
  done
}

cmd="${1:-}"; shift || true

# One deploy at a time: CI and a hand deploy racing would each roll back onto
# the other's half-switched state. flock is util-linux; the test Mac lacks it.
if [ "$cmd" != list ] && [ "$cmd" != preflight ] && command -v flock >/dev/null; then
  mkdir -p "$RELEASES"
  exec 9>"$RELEASES/.lock"
  flock -n 9 || die "another deploy is running"
fi

case "$cmd" in
  migrate)  cmd_migrate ;;
  activate) cmd_activate "$@" ;;
  rollback) cmd_rollback "$@" ;;
  list)     cmd_list ;;
  preflight) require_migrated; say "ready; live = $(current_id)" ;;
  *) die "usage: remote.sh migrate | activate <id> | rollback [<id>] | list | preflight" ;;
esac
