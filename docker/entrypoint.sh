#!/bin/sh
# TMedge container entrypoint: `tmedge <edge|web|sim> [args]` or `tmedge health`.
set -e
role="${1:-web}"
[ $# -gt 0 ] && shift
case "$role" in
  edge) exec node dist/src/edge/main.js "$@" ;;
  web)  exec node dist/src/web/main.js "$@" ;;
  sim)  exec node dist/src/tools/simulator.js "$@" ;;
  user) exec node dist/src/tools/user.js "$@" ;;
  health)
    # The web tier answers /healthz; the edge's console answers (401 = up, password required).
    exec node -e '
      const tryGet = (u) => fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => r.status).catch(() => 0);
      Promise.all([tryGet("http://127.0.0.1:" + (process.env.WEB_PORT || 8080) + "/healthz"),
                   tryGet("http://127.0.0.1:" + (process.env.CONSOLE_PORT || 8090) + "/")])
        .then(([w, c]) => process.exit(w === 200 || c === 200 || c === 401 ? 0 : 1));' ;;
  *) echo "usage: tmedge <edge|web|sim|user|health> [args]" >&2; exit 64 ;;
esac
