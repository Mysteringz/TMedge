#!/usr/bin/env bash
# Release TMedge to the live box. The one way code reaches production, whether
# you run it from the dev Mac or CI runs it after a merge.
#
#   deploy/deploy.sh                 check, build, upload, switch, health-check
#   deploy/deploy.sh migrate         one-time: convert the box to releases/
#   deploy/deploy.sh rollback [id]   back to the previous release (or <id>)
#   deploy/deploy.sh list            releases on the box, current marked
#
# Options for a deploy:
#   --skip-checks   do not re-run typecheck/test/crosscheck (CI already did)
#   --allow-dirty   deploy uncommitted changes; the release id says "-dirty"
#
# Environment:
#   DEPLOY_HOST     ssh target (default: the Singapore EC2 box)
#   DEPLOY_SSH_KEY  identity file (default: ../TMcloudkey.pem if present)
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

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20)
[ -n "$KEY" ] && SSH+=(-i "$KEY")

# Runs remote.sh on the box as root. Over ssh nothing from this shell's
# environment goes along; locally the TM_* test overrides do.
remote() {
  if [ "$HOST" = local ]; then
    bash "$REPO/deploy/remote.sh" "$@"
  else
    "${SSH[@]}" "$HOST" "sudo bash -s -- $*" < "$REPO/deploy/remote.sh"
  fi
}

upload() {
  local src="$1" id="$2"
  if [ "$HOST" = local ]; then
    mkdir -p "$REMOTE_BASE/tmedge-releases/$id"
    rsync -a "$src/" "$REMOTE_BASE/tmedge-releases/$id/"
  else
    rsync -az -e "${SSH[*]}" --rsync-path="sudo rsync" "$src/" "$HOST:$REMOTE_BASE/tmedge-releases/$id/"
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

  local sha dirty=""
  sha="$(git rev-parse --short=10 HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    [ "$allow_dirty" = 1 ] || die "uncommitted changes; commit them, or pass --allow-dirty to deploy them anyway"
    dirty="-dirty"
  fi
  local id; id="$(date -u +%Y%m%dT%H%M%SZ)-$sha$dirty"

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

  # Stage exactly what runs: tracked files as they are on disk, plus the
  # git-ignored build output. Never node_modules (installed on the box for its
  # platform), never data/ or .env (they live on the box and stay there).
  # Global, not local: the EXIT trap runs after this function has returned.
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  # mktemp -d is 0700 and rsync -a carries that onto the release directory,
  # which the service user then cannot even enter (systemd: status=200/CHDIR).
  chmod 755 "$STAGE"
  local stage="$STAGE"
  git ls-files -z | tar --null -T - -cf - | tar -C "$stage" -xf -
  cp -R dist "$stage/"
  mkdir -p "$stage/public-web" "$stage/public-console"
  cp -R public-web/app "$stage/public-web/"
  cp -R public-console/js "$stage/public-console/"
  # The algo debugger's editor is built whole into public-algo, which is
  # git-ignored like the others; without this the API ships and its UI does not.
  [ -d public-algo ] && cp -R public-algo "$stage/"
  rm -rf "$stage/.env" "$stage/data" "$stage/node_modules" \
         "$stage/web-app/node_modules" "$stage/algo-app/node_modules"
  printf '{"id":"%s","commit":"%s","deployedAt":"%s"}\n' \
    "$id" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/RELEASE.json"

  say "upload $id"
  upload "$stage" "$id"
  say "activate $id"
  remote activate "$id"
  say "done: $id is live"
}

cmd="${1:-deploy}"
case "$cmd" in
  deploy)   shift || true; cmd_deploy "$@" ;;
  --*)      cmd_deploy "$@" ;;
  migrate)  remote migrate ;;
  rollback) shift; remote rollback "$@" ;;
  list)     remote list ;;
  *) die "usage: deploy.sh [deploy] [--skip-checks] [--allow-dirty] | migrate | rollback [id] | list" ;;
esac
