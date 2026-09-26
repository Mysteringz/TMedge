#!/usr/bin/env bash
# Drives deploy.sh + remote.sh end to end on this machine, against a scratch
# "/opt" with a fake systemctl that really starts the web tier and the edge
# from /opt/tmedge (as the units do) with EnvironmentFile-style .env loading.
# So "healthy" here means real processes answering real HTTP, and a broken
# release really fails to start.
#
#   deploy/test-deploy.sh            (~1 min; runs the full checks once)
#
# Each block states the claim it proves. Never touches a real server: the
# host is forced to "local" and every path lives under a mktemp directory.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
export DEPLOY_HOST=local TM_BASE="$T/opt" TM_SETTLE=2 TM_KEEP=3
export TM_SYSTEMCTL="$T/bin/systemctl" TM_OWNER="$(id -u):$(id -g)" TM_ENV_OWNER="$(id -u):$(id -g)"
export TM_WEB_HEALTH=http://127.0.0.1:18080/healthz TM_CONSOLE_HEALTH=http://127.0.0.1:18090/ TM_ALGO_HEALTH=http://127.0.0.1:18091/api/catalogue
TM_NPM="$(command -v npm)"; export TM_NPM
export FAKE_RUN="$T/run"
mkdir -p "$T/bin" "$T/run" "$T/var" "$TM_BASE"

pass=0
ok()   { pass=$((pass + 1)); printf '  \033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
live() { basename "$(readlink "$TM_BASE/tmedge")"; }
web_up() { [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$TM_WEB_HEALTH")" = 200 ]; }

cleanup() {
  for f in "$FAKE_RUN"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

# --- a systemctl that runs the units' ExecStart from WorkingDirectory=/opt/tmedge
cat > "$TM_SYSTEMCTL" <<'EOF'
#!/usr/bin/env bash
entry() { case "$1" in tmedge-web) echo dist/src/web/main.js ;; tmedge-edge) echo dist/src/edge/main.js ;; *) echo "" ;; esac; }
stop() {
  local f="$FAKE_RUN/$1.pid"; [ -f "$f" ] || return 0
  local p; p="$(cat "$f")"; kill "$p" 2>/dev/null || true
  for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
  rm -f "$f"
}
start() {
  local e; e="$(entry "$1")"
  if [ -z "$e" ]; then echo 0 > "$FAKE_RUN/$1.noop"; return 0; fi
  (cd "$TM_BASE/tmedge" && exec node --env-file=.env "$e" >>"$FAKE_RUN/$1.log" 2>&1) &
  echo $! > "$FAKE_RUN/$1.pid"
}
case "$1" in
  restart) [ ! -f "$TM_BASE/tmedge/FAIL_RESTART" ] || exit 1; shift; for s in "$@"; do stop "$s"; start "$s"; done ;;
  is-active) s="${!#}"; [ -f "$FAKE_RUN/$s.noop" ] && exit 0
             [ -f "$FAKE_RUN/$s.pid" ] && kill -0 "$(cat "$FAKE_RUN/$s.pid")" 2>/dev/null ;;
  show) echo 0 ;;
  *) echo "fake systemctl: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$TM_SYSTEMCTL"

# --- the box as it is today: a plain directory rsync'd over, .env inside it
cd "$REPO"
echo "building the pre-pipeline install..."
npm run build >/dev/null
OLD="$TM_BASE/tmedge"
mkdir -p "$OLD"
git ls-files -z | tar --null -T - -cf - | tar -C "$OLD" -xf -
cp -R dist node_modules "$OLD/"
cp -R public-web/app "$OLD/public-web/"; cp -R public-console/js "$OLD/public-console/"
# Throwaway values made up here, per run; the real .env is never read.
rnd() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
cat > "$OLD/.env" <<EOF
TM_KEY=$(rnd)
WEB_PUSH_TOKEN=$(rnd)
SESSION_SECRET=$(rnd)
ADMIN_PASSWORD=$(rnd)
WEB_PORT=18080
WEB_HOST=127.0.0.1
CONSOLE_PORT=18090
CONSOLE_HOST=127.0.0.1
NODE_PORT=18211
ALGO_PORT=18091
ALGO_HOST=127.0.0.1
UDP_PORT=15200
UDP_HOST=127.0.0.1
GATEWAY_PORT=0
WEB_PUSH_URLS=http://127.0.0.1:18080
DATA_DIR=$T/var
EOF
"$TM_SYSTEMCTL" restart tmedge-edge tmedge-web tmedge-sim
for _ in $(seq 30); do web_up && break; sleep 0.5; done
web_up || { cat "$FAKE_RUN"/*.log; fail "the pre-pipeline install did not start"; }
env_before="$(cat "$OLD/.env")"
echo

echo "claim: nothing is built or uploaded to a box that has not been migrated"
out="$("$REPO/deploy/deploy.sh" --allow-dirty --skip-checks 2>&1)" && fail "deploy succeeded before migrate"
grep -q "Run: deploy/deploy.sh migrate" <<<"$out" || fail "unexpected refusal: $out"
[ ! -d "$TM_BASE/tmedge-releases" ] || [ -z "$(ls "$TM_BASE/tmedge-releases")" ] || fail "a release was uploaded anyway"
ok "deploy refused with a pointer to migrate; no release uploaded"

echo "claim: migrate keeps the running code and the secret, and changes only the layout"
"$REPO/deploy/deploy.sh" migrate >/dev/null
[ -L "$TM_BASE/tmedge" ] || fail "/opt/tmedge is not a symlink"
[[ "$(live)" == *-pre-pipeline ]] || fail "live release is $(live)"
[ "$(cat "$TM_BASE/tmedge-shared/.env")" = "$env_before" ] || fail ".env changed"
[ "$(cat "$TM_BASE/tmedge/.env")" = "$env_before" ] || fail "/opt/tmedge/.env no longer resolves (EnvironmentFile would break)"
web_up || fail "site down after migrate"
ok "old tree is release $(live), .env moved to shared and still at /opt/tmedge/.env, site up"
out="$("$REPO/deploy/deploy.sh" migrate)"
grep -q "already migrated" <<<"$out" || fail "second migrate was not a no-op"
ok "migrate is idempotent"

echo "claim: a deploy runs every check, switches, and the site stays up"
first="$(live)"
"$REPO/deploy/deploy.sh" --allow-dirty > "$T/deploy1.log" 2>&1 || { cat "$T/deploy1.log"; fail "deploy failed"; }
for step in preflight typecheck test crosscheck build upload activate; do
  grep -q "\[deploy\].* $step" "$T/deploy1.log" || fail "deploy skipped $step"
done
second="$(live)"
[ "$second" != "$first" ] || fail "live did not change"
[ -f "$TM_BASE/tmedge/RELEASE.json" ] && [ "$(node -p 'require(process.argv[1]).id' "$TM_BASE/tmedge/RELEASE.json")" = "$second" ] || fail "RELEASE.json missing or wrong"
[ -L "$TM_BASE/tmedge/.env" ] || fail ".env in the release is not the shared symlink"
[ -z "$(find "$TM_BASE/tmedge-releases/$second" -name .env -type f)" ] || fail "a real .env file was uploaded"
grep -q "copying node_modules" "$T/deploy1.log" || fail "unchanged lockfile still ran npm ci"
# The units run as another user (tmedge) than the uploader, so the code must
# be readable and every directory enterable by others. The real EC2 deploy
# failed exactly here once (mktemp's 0700 carried over by rsync -a).
rel="$TM_BASE/tmedge-releases/$second"
[ -z "$(find "$rel" -path "$rel/node_modules" -prune -o -type d ! -perm -o+rx -print)" ] || fail "a release directory is not enterable by the service user"
[ -z "$(find "$rel" -path "$rel/node_modules" -prune -o -type f ! -perm -o+r -print)" ] || fail "a release file is not readable by the service user"
[ -z "$(find "$rel" -path "$rel/node_modules" -prune -o -perm -o+w ! -type l -print)" ] || fail "release code is writable by others"
[ "$(stat -c %a "$TM_BASE/tmedge-shared/.env" 2>/dev/null || stat -f %Lp "$TM_BASE/tmedge-shared/.env")" = 600 ] || fail ".env is not 600"
web_up || fail "site down after deploy"
# .env sets NODE_PORT, so the direct node listener is part of "healthy".
grep -q "healthy: .*nodes 200" "$T/deploy1.log" || fail "the direct node listener was not health-checked"
ok "all seven steps ran; live = $second; no .env uploaded; deps reused; site and node listener up"

echo "claim: a corrupted retained release cannot be activated"
corrupt="29990101T000003Z-corrupt"
cp -R "$TM_BASE/tmedge-releases/$second" "$TM_BASE/tmedge-releases/$corrupt"
printf '\n// corrupted\n' >> "$TM_BASE/tmedge-releases/$corrupt/dist/src/web/main.js"
bash "$REPO/deploy/remote.sh" rollback "$corrupt" >/dev/null 2>&1 && fail "corrupt rollback accepted"
[ "$(live)" = "$second" ] && web_up || fail "corrupt rollback disturbed live services"
rm -rf "$TM_BASE/tmedge-releases/$corrupt"
ok "manifest rejects changed files before activation"

echo "claim: a release that cannot start is switched back automatically"
bad="29990101T000000Z-broken"
cp -R "$TM_BASE/tmedge-releases/$second" "$TM_BASE/tmedge-releases/$bad"
rm -f "$TM_BASE/tmedge-releases/$bad/MANIFEST.json"
rm -rf "$TM_BASE/tmedge-releases/$bad/node_modules" "$TM_BASE/tmedge-releases/$bad/.env"
echo 'process.exit(1);' > "$TM_BASE/tmedge-releases/$bad/dist/src/web/main.js"
out="$(bash "$REPO/deploy/remote.sh" activate "$bad" 2>&1)" && fail "a broken release activated"
[ "$(live)" = "$second" ] || fail "live is $(live), expected rollback to $second"
web_up || fail "site not restored after rollback"
grep -q "rolled back to $second" <<<"$out" || fail "no rollback message: $out"
[ ! -d "$TM_BASE/tmedge-releases/$bad" ] || fail "the failed release was kept (a later rollback could land on it)"
ok "broken release refused and deleted; live back on $second and answering"

echo "claim: a systemctl restart error restores the previous release"
failed_restart="29990101T000002Z-restart-error"
cp -R "$TM_BASE/tmedge-releases/$second" "$TM_BASE/tmedge-releases/$failed_restart"
rm -f "$TM_BASE/tmedge-releases/$failed_restart/MANIFEST.json"
touch "$TM_BASE/tmedge-releases/$failed_restart/FAIL_RESTART"
rm -rf "$TM_BASE/tmedge-releases/$failed_restart/node_modules"
bash "$REPO/deploy/remote.sh" activate "$failed_restart" >/dev/null 2>&1 && fail "restart failure accepted"
[ "$(live)" = "$second" ] && web_up || fail "restart error did not restore the working release"
[ ! -d "$TM_BASE/tmedge-releases/$failed_restart" ] || fail "failed restart release retained"
ok "restart error restores previous release"

out="$("$REPO/deploy/deploy.sh" rollback '../escape' 2>&1)" && fail "unsafe release id accepted"
grep -q 'invalid release id' <<<"$out" || fail "unexpected unsafe id result"
ok "unsafe release id rejected before SSH"

echo "claim: a release that starts and then dies is caught too (not just a failed start)"
late="29990101T000001Z-dies-late"
cp -R "$TM_BASE/tmedge-releases/$second" "$TM_BASE/tmedge-releases/$late"
rm -f "$TM_BASE/tmedge-releases/$late/MANIFEST.json"
rm -rf "$TM_BASE/tmedge-releases/$late/node_modules" "$TM_BASE/tmedge-releases/$late/.env"
printf 'setTimeout(() => process.exit(1), 1000);\n' > "$TM_BASE/tmedge-releases/$late/dist/src/web/main.js"
bash "$REPO/deploy/remote.sh" activate "$late" >/dev/null 2>&1 && fail "a release that dies after 1 s activated"
[ ! -d "$TM_BASE/tmedge-releases/$late" ] || fail "the failed release was kept"
[ "$(live)" = "$second" ] || fail "live is $(live)"
ok "caught after the settle period; live still $second"

echo "claim: rollback with no argument goes to the release before the live one, and back"
"$REPO/deploy/deploy.sh" rollback >/dev/null
[ "$(live)" = "$first" ] || fail "rollback went to $(live), expected $first"
web_up || fail "site down after rollback"
"$REPO/deploy/deploy.sh" rollback "$second" >/dev/null
[ "$(live)" = "$second" ] || fail "roll forward went to $(live)"
ok "rollback -> $first, rollback $second -> forward again, site up both times"

echo "claim: old releases are pruned to TM_KEEP, never the live one or the one before it"
sleep 1; "$REPO/deploy/deploy.sh" --allow-dirty --skip-checks >/dev/null 2>&1 || fail "deploy 3 failed"
sleep 1; "$REPO/deploy/deploy.sh" --allow-dirty --skip-checks >/dev/null 2>&1 || fail "deploy 4 failed"
sleep 1; "$REPO/deploy/deploy.sh" --allow-dirty --skip-checks >/dev/null 2>&1 || fail "deploy 5 failed"
listing="$(bash "$REPO/deploy/remote.sh" list)"
n="$(wc -l <<<"$listing" | tr -d ' ')"
[ "$n" -le 3 ] || fail "$n releases kept, TM_KEEP=3"
[ -d "$TM_BASE/tmedge-releases/$first" ] && fail "the oldest release was not pruned"
grep -q "^\* $(live)\$" <<<"$listing" || fail "list does not mark the live release"
ok "$n releases kept; oldest pruned; list marks live"

echo "claim: a second deploy is refused while one holds the lock"
if command -v flock >/dev/null; then
  flock "$TM_BASE/tmedge-releases/.lock" sleep 5 &
  holder=$!; sleep 0.5
  out="$("$REPO/deploy/deploy.sh" rollback 2>&1)" && fail "rollback ran while another deploy held the lock"
  grep -q "another deploy is running" <<<"$out" || fail "unexpected: $out"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
  ok "refused while locked"
else
  ok "(no flock on this machine; the lock is Linux-only and exercised in CI)"
fi

echo "claim: a dirty tree is refused unless asked for"
if [ -n "$(git status --porcelain)" ]; then
  out="$("$REPO/deploy/deploy.sh" 2>&1)" && fail "dirty deploy was allowed"
  grep -q "uncommitted changes" <<<"$out" || fail "unexpected: $out"
  ok "refused without --allow-dirty"
else
  ok "(tree is clean; dirty refusal not exercised this run)"
fi

echo
echo "deploy pipeline: $pass checks passed"
