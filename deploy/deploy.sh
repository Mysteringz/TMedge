#!/usr/bin/env bash
# Release TMedge to the live box. The one way code reaches production, whether
# you run it from the dev Mac or CI runs it after a merge.
#
#   deploy/deploy.sh                 check, build, upload, switch, health-check
#   deploy/deploy.sh artifact <archive>  promote a tested runtime archive
#   deploy/deploy.sh migrate         one-time: convert the box to releases/
#   deploy/deploy.sh rollback [id]   back to the previous release (or <id>)
#   deploy/deploy.sh list            releases on the box, current marked
#   deploy/deploy.sh receiver-check  fail unless the box's pinned deploy tools
#                                    match this checkout's deploy/ (run before
#                                    every artifact upload, too)
#   deploy/deploy.sh receiver-install  admin key only: install this checkout's
#                                    reviewed deploy tools on the box (a clean
#                                    copy of origin/main), then check them
#
# Options for a deploy:
#   --skip-checks   do not re-run typecheck/test/crosscheck (CI already did)
#   --allow-dirty   deploy uncommitted changes; the release id says "-dirty"
#
# Environment:
#   DEPLOY_HOST     ssh target (default: the Singapore EC2 box)
#   DEPLOY_SSH_KEY  identity file (default: ../TMcloudkey.pem if present)
#   DEPLOY_RESTRICTED_KEY=1 uses the CI forced-command key for artifacts.
#   DEPLOY_HOST=local runs remote.sh here against $TM_BASE -- test only.
#
# What it guarantees: nothing that failed a check is uploaded; the running
# release is untouched until the new one is fully in place; a release that
# comes up unhealthy is switched back automatically; .env never leaves the box.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

HOST="${DEPLOY_HOST:-ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com}"
KEY="${DEPLOY_SSH_KEY:-}"
[ -z "$KEY" ] && [ -f "$REPO/../TMcloudkey.pem" ] && KEY="$REPO/../TMcloudkey.pem"
REMOTE_BASE="${TM_BASE:-/opt}"

say() { printf '\033[1m[deploy]\033[0m %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=yes)
[ -n "$KEY" ] && SSH+=(-i "$KEY")

# Runs remote.sh on the box as root. Over ssh nothing from this shell's
# environment goes along; locally the TM_* test overrides do.
remote() {
  case "${1:-}" in
    rollback|activate) [ "$#" -le 2 ] || die "too many arguments"; if [ -n "${2:-}" ]; then [[ "$2" =~ ^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9-]+$ ]] || die "invalid release id"; fi ;;
    list|preflight|migrate) [ "$#" -eq 1 ] || die "unexpected argument" ;;
    *) die "unknown remote command" ;;
  esac
  if [ "$HOST" = local ]; then
    bash "$REPO/deploy/remote.sh" "$@"
  else
    "${SSH[@]}" "$HOST" "sudo bash -s -- $*" < "$REPO/deploy/remote.sh"
  fi
}

cmd_deploy() {
  local skip_checks=0 allow_dirty=0
  for a in "$@"; do
    case "$a" in
      --skip-checks) skip_checks=1 ;;
      --allow-dirty) allow_dirty=1 ;;
      *) die "unknown option $a" ;;
    esac
  done

  if [ -n "$(git status --porcelain)" ]; then
    [ "$allow_dirty" = 1 ] || die "uncommitted changes; commit them, or pass --allow-dirty to deploy them anyway"
  fi

  # Before any build or upload, so a box that is not ready costs nothing.
  say "preflight on $HOST"
  remote preflight

  if [ "$skip_checks" = 0 ]; then
    say "typecheck"; npm run typecheck >/dev/null
    say "test";      npm test >/dev/null 2>&1 || { npm test 2>&1 | tail -40; die "tests failed"; }
    # The crosscheck is the only thing that notices the firmware and the edge
    # disagreeing about the wire format, so a deploy without it is refused.
    local fw="${TMSENSE_DIR:-$REPO/../TMsense}"
    [ -d "$fw" ] || die "crosscheck needs TMsense at $fw (set TMSENSE_DIR), or pass --skip-checks if CI ran it"
    say "crosscheck"; npm run crosscheck >/dev/null
  fi
  say "build"; npm run build >/dev/null

  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  python3 deploy/release.py package "$REPO" "$STAGE/tmedge.tar.gz" >/dev/null
  say "upload artifact"
  say "activate artifact"
  cmd_artifact "$STAGE/tmedge.tar.gz"
  say "done: release is live"
}

# The receiver and remote.sh that run a CI deploy are installed on the box by
# hand and a release cannot replace them (pipeline.md). When they fall behind
# this checkout, the release is health-checked by rules it was not tested
# against: on 2026-10-04 a release that passed every check here was rolled
# back by an older remote.sh. So promote nothing until they match.
cmd_receiver_check() {
  local want got
  want="$(python3 - "$REPO/deploy" <<'PY'
import hashlib, json, sys
from pathlib import Path
d = Path(sys.argv[1])
print(json.dumps({n: hashlib.sha256((d / n).read_bytes()).hexdigest()
                  for n in ('remote.sh', 'release.py', 'ci-receiver.py')}, sort_keys=True))
PY
)"
  if [ "$HOST" = local ]; then
    # Test only: compare against a scratch install, if the test made one.
    [ -n "${TM_RECEIVER_DIR:-}" ] || { say "receiver check skipped (local)"; return 0; }
    got="$(python3 "$TM_RECEIVER_DIR/ci-receiver.py" version 2>/dev/null || true)"
  elif [ "${DEPLOY_RESTRICTED_KEY:-0}" = 1 ]; then
    got="$("${SSH[@]}" "$HOST" version 2>/dev/null || true)"
  else
    got="$("${SSH[@]}" "$HOST" "sudo /opt/tmedge-deploy/ci-receiver.py version" 2>/dev/null || true)"
  fi
  if [ "$got" != "$want" ]; then
    local stale
    stale="$(python3 - "$want" "${got:-{\}}" <<'PY'
import json, sys
want = json.loads(sys.argv[1])
try:
    got = json.loads(sys.argv[2])
except ValueError:
    got = {}
print(', '.join(n for n in want if got.get(n) != want[n]) or 'all (no version reported)')
PY
)"
    die "the box's deploy tools in /opt/tmedge-deploy differ from this release's deploy/ ($stale). Reinstall the reviewed files first (deploy/pipeline.md, \"Receiver installation\"); nothing was uploaded."
  fi
  say "receiver matches this release's deploy tools"
}

# The privileged half of the pipeline, updated the only way it may be: by an
# administrator, from reviewed code. "Reviewed" here means exactly what main
# is -- merged through a PR with green CI -- so the checkout must be a clean
# copy of origin/main. Each file is written beside its target and renamed
# over it, so a receiver mid-deploy never reads half a file. The CI key and
# account are untouched (install-ci-receiver.sh is for creating or rotating
# those).
cmd_receiver_install() {
  [ "$HOST" != local ] || die "receiver-install needs a real host"
  [ "${DEPLOY_RESTRICTED_KEY:-0}" != 1 ] || die "the CI key cannot install the receiver; use the administrator's key"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes; install only reviewed files"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main; check out main (reviewed) first"
  local f
  for f in remote.sh release.py ci-receiver.py; do
    "${SSH[@]}" "$HOST" "sudo sh -c 'umask 022; cat > /opt/tmedge-deploy/.$f.new && chown root:root /opt/tmedge-deploy/.$f.new && chmod 755 /opt/tmedge-deploy/.$f.new && mv -f /opt/tmedge-deploy/.$f.new /opt/tmedge-deploy/$f'" \
      < "$REPO/deploy/$f" || die "installing $f failed"
    say "installed $f"
  done
  cmd_receiver_check
}

cmd_artifact() {
  local archive="${1:?archive required}" digest id
  cmd_receiver_check
  digest="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$archive")"
  if [ "$HOST" = local ]; then
    local incoming; incoming="$(mktemp -d "$REMOTE_BASE/tmedge-releases/.incoming-XXXXXX")"
    python3 deploy/release.py extract "$archive" "$incoming/stage" >/dev/null
    id="$(node -p 'require(process.argv[1]).id' "$incoming/stage/RELEASE.json")"
    [ ! -e "$REMOTE_BASE/tmedge-releases/$id" ] || die "release already exists"
    mv "$incoming/stage" "$REMOTE_BASE/tmedge-releases/$id"
    rmdir "$incoming"
    remote activate "$id"
  elif [ "${DEPLOY_RESTRICTED_KEY:-0}" = 1 ]; then
    "${SSH[@]}" "$HOST" "deploy $digest" < "$archive"
  else
    "${SSH[@]}" "$HOST" "sudo /opt/tmedge-deploy/ci-receiver.py 'deploy $digest'" < "$archive"
  fi
}

cmd="${1:-deploy}"
case "$cmd" in
  deploy)   shift || true; cmd_deploy "$@" ;;
  --*)      cmd_deploy "$@" ;;
  artifact) shift; cmd_artifact "$@" ;;
  migrate)  remote migrate ;;
  rollback) shift; remote rollback "$@" ;;
  list)     remote list ;;
  receiver-check) cmd_receiver_check ;;
  receiver-install) cmd_receiver_install ;;
  *) die "usage: deploy.sh [deploy] [--skip-checks] [--allow-dirty] | migrate | rollback [id] | list | receiver-check | receiver-install" ;;
esac
