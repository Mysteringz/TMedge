#!/usr/bin/env bash
# Plan A against a fake HKU (HANDOVER.md T2): builds and starts the container,
# pins its host key, runs dist/test/hpcstack.test.js, tears everything down.
#
#   npm run test:hpc-stack            (DOCKER="sudo docker" if you are not in the docker group)
#
# Needs openconnect and ocproxy on this machine. Every name the stack answers
# is under .test: nothing here can reach a real HKU system. Seeds and
# passwords are fake; the PIN_CANARY value is what the tests hunt for in
# logs, files, process tables and the heap.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DOCKER=${DOCKER:-docker}
NAME=tmedge-fake-hku-test
PORT=${HPC_STACK_PORT:-14443}
WORK="$(mktemp -d)"
for t in openconnect ocproxy ssh tar; do command -v "$t" >/dev/null || PATH=/usr/sbin:$PATH command -v "$t" >/dev/null || { echo "need $t" >&2; exit 2; }; done

cleanup() { [ "${KEEP:-0}" = 1 ] && { echo "kept $NAME (KEEP=1): $DOCKER logs $NAME" >&2; return; }; $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true; $DOCKER run --rm -v "$WORK:/w" --entrypoint rm tmedge-fake-hku -rf /w/certs >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
$DOCKER build -q -t tmedge-fake-hku "$HERE" >/dev/null
mkdir -p "$WORK/certs"
# Seeds are RFC 6238's test seed and two made-up ones.
$DOCKER run -d --name "$NAME" --cap-add NET_ADMIN --device /dev/net/tun -p "127.0.0.1:$PORT:4443" \
  -e FAKE_USERS="tmchan:PIN_CANARY_7f3a:3132333435363738393031323334353637383930 kwlee:kwlee-portal-pin-2:3837363534333231303938373635343332313039 lockme:lockme-pin-3:3131313131313131313131313131313131313131" \
  -e FAKE_PENDING_SECONDS=1 -e FAKE_DEBUG="${FAKE_DEBUG:-0}" -v "$WORK/certs:/certs" tmedge-fake-hku >/dev/null
for _ in $(seq 1 60); do [ -s "$WORK/certs/hpc_host_ed25519.pub" ] && break; sleep 0.5; done
[ -s "$WORK/certs/hpc_host_ed25519.pub" ] || { $DOCKER logs "$NAME" >&2; echo "fake HKU did not start" >&2; exit 1; }
for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.25; done

export HPC_STACK=1 HPC_STACK_VPN="127.0.0.1:$PORT"
HPC_STACK_CERT="$(node -e "const {X509Certificate,createHash}=require('crypto');const x=new X509Certificate(require('fs').readFileSync(process.argv[1]));console.log('pin-sha256:'+createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('base64'))" "$WORK/certs/server-cert.pem")"
export HPC_STACK_CERT
echo "hpc.fakehku.test $(cut -d' ' -f1,2 "$WORK/certs/hpc_host_ed25519.pub")" > "$WORK/known_hosts"
export HPC_STACK_KNOWN_HOSTS="$WORK/known_hosts"
cd "$REPO"
node --test --test-concurrency=1 ${HPC_STACK_ONLY:+--test-name-pattern="$HPC_STACK_ONLY"} dist/test/hpcstack.test.js
