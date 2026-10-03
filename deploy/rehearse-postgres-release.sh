#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/docker-compose.postgres-test.yml"
RUN_ID="$(date -u +%Y%m%d%H%M%S)_$$"
UID_TAIL="$(printf '%06x' "$(( $(date +%s) ^ $$ ))")"
NODE_UID="02:00:00:${UID_TAIL:0:2}:${UID_TAIL:2:2}:${UID_TAIL:4:2}"
RECONCILED_UID="03:00:00:${UID_TAIL:0:2}:${UID_TAIL:2:2}:${UID_TAIL:4:2}"
RESTORE_DB="release_restore_${RUN_ID}"
CONTAINER="$(docker compose -f "$COMPOSE" ps -q postgres-test)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tmedge-db-rehearsal.XXXXXX")}"
DUMP="$ARTIFACT_DIR/source.dump"
LOG="$ARTIFACT_DIR/rehearsal.log"
RESTORE_CREATED=0
PREVIOUS_RELEASE_DIR=""
PREVIOUS_RELEASE_PID=""
PREVIOUS_RELEASE_REVISION="${PREVIOUS_DB_AWARE_REVISION:-32d64b0}"

mkdir -p "$ARTIFACT_DIR"
exec > >(tee -a "$LOG") 2>&1

cleanup() {
  local exit_code=$?
  if [[ -n "$PREVIOUS_RELEASE_PID" ]]; then
    kill -TERM "$PREVIOUS_RELEASE_PID" 2>/dev/null || true
    wait "$PREVIOUS_RELEASE_PID" 2>/dev/null || true
  fi
  if [[ -n "$PREVIOUS_RELEASE_DIR" ]]; then
    rm -rf "$PREVIOUS_RELEASE_DIR"
  fi
  if [[ -n "$CONTAINER" ]]; then
    docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -v ON_ERROR_STOP=1 -c \
      "DELETE FROM public.occupancy_history WHERE edge_id IN ('release-${RUN_ID}', 'load-${RUN_ID}');
       DELETE FROM public.command_outcomes WHERE command_id = 'release-${RUN_ID}';
       DELETE FROM public.firmware_rollout_node_events WHERE rollout_id = 'roll-${RUN_ID}';
       DELETE FROM public.firmware_rollout_nodes WHERE rollout_id = 'roll-${RUN_ID}';
       DELETE FROM public.firmware_rollouts WHERE id = 'roll-${RUN_ID}';
       DELETE FROM public.firmware_build_jobs WHERE id = 'job-${RUN_ID}';
       DELETE FROM public.provisioning_audit_events WHERE subject_id = 'release-${RUN_ID}';
       DELETE FROM public.registered_nodes WHERE uid IN ('${NODE_UID}', '${RECONCILED_UID}');" || true
    if [[ "$RESTORE_CREATED" == 1 ]]; then
      docker exec "$CONTAINER" dropdb -U tmedge_admin --if-exists "$RESTORE_DB" || true
    fi
  fi
  if [[ "$exit_code" == 0 ]]; then
    echo "PASS: rehearsal logs and source backup: $ARTIFACT_DIR"
  else
    echo "FAIL: rehearsal stopped with exit $exit_code; inspect $LOG"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

[[ -n "$CONTAINER" ]] || { echo 'postgres-test is not running; start docker-compose.postgres-test.yml first'; exit 2; }
docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" | grep -qx healthy || { echo 'postgres-test is not healthy'; exit 2; }

export PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=tmedge_test
export PG_MIGRATION_USER="${PG_MIGRATION_USER:-tmedge_migrator}"
export PG_MIGRATION_PASSWORD="${PG_MIGRATION_PASSWORD:-local-test-migrator-only}"
export PG_RUNTIME_USER="${PG_RUNTIME_USER:-tmedge_runtime}"
export PG_RUNTIME_PASSWORD="${PG_RUNTIME_PASSWORD:-local-test-runtime-only}"
echo 'Applying reviewed expand migrations to the disposable local database.'
(cd "$ROOT" && npm run db:migrate -- up)

SQL="
INSERT INTO public.registered_nodes (uid, label) VALUES ('${NODE_UID}', 'release rehearsal node');
INSERT INTO public.provisioning_audit_events (actor_id, actor_kind, action, subject_id, occurred_at)
VALUES ('rehearsal', 'console', 'release-rehearsal', 'release-${RUN_ID}', now());
INSERT INTO public.firmware_build_jobs (id, upload_id, actor_id, actor_kind, lifecycle, started_at, finished_at, log, error)
VALUES ('job-${RUN_ID}', 'upload-${RUN_ID}', 'rehearsal', 'system', 'failed', now(), now(), '[]', 'rehearsal row');
INSERT INTO public.firmware_rollouts (id, build_id, version, target, started_by, started_at, finished_at, stage, note)
VALUES ('roll-${RUN_ID}', 'artifact-${RUN_ID}', 'rehearsal', '{\"kind\":\"all\"}', 'rehearsal', now(), now(), 'done', 'rehearsal row');
INSERT INTO public.firmware_rollout_nodes (rollout_id, uid, label, floor_id, transport, state, percent, started_at, updated_at)
VALUES ('roll-${RUN_ID}', '${NODE_UID}', 'rehearsal node', 'f1', 'direct', 'confirmed', 100, now(), now());
INSERT INTO public.command_outcomes (command_id, node_id, command, actor_id, actor_kind, outcome, occurred_at)
VALUES ('release-${RUN_ID}', '${NODE_UID}', '1:0:0', 'rehearsal', 'system', 'requested', now());
WITH t AS (SELECT date_trunc('minute', now()) AS minute_at)
INSERT INTO public.occupancy_history (minute_at, sampled_at, edge_id, floor_id, table_id, capacity, occupied, free, coverage)
SELECT t.minute_at, t.minute_at + interval '30 seconds', 'release-${RUN_ID}', 'f1', 't1', 10, 2, 8, 'ok' FROM t;
"
docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -v ON_ERROR_STOP=1 -c "$SQL"

export PERSISTENCE_MODE=postgres SITE_CONFIG="$ROOT/config/site.json"
export PG_RUNTIME_USER PG_RUNTIME_PASSWORD
export NODES_EXPORT_PATH="$ARTIFACT_DIR/registrations.json"
echo 'Exporting the PostgreSQL registry and running a non-mutating import preview.'
(cd "$ROOT" && npm run db:registry:export)
(cd "$ROOT" && npm run db:registry:import -- "$NODES_EXPORT_PATH")

echo 'Simulating a registration acknowledged by the file-backed release after its recovery export.'
cp "$NODES_EXPORT_PATH" "$ARTIFACT_DIR/pre-cutover-registrations.json"
python3 - "$NODES_EXPORT_PATH" "$RECONCILED_UID" <<'PY'
import json, sys
path, uid = sys.argv[1:]
with open(path, encoding='utf-8') as source:
    registry = json.load(source)
registry['nodes'].append({
    'uid': uid, 'label': 'acknowledged-after-export', 'owns': [], 'simulated': False, 'rgb': False,
})
with open(path, 'w', encoding='utf-8') as output:
    json.dump(registry, output, indent=2)
    output.write('\n')
PY
PREVIEW="$ARTIFACT_DIR/reconciliation-preview.json"
(cd "$ROOT" && npm run db:registry:import -- "$NODES_EXPORT_PATH") | tee "$PREVIEW"
grep -q '"insertable": 1' "$PREVIEW"
test "$(docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM public.registered_nodes WHERE uid = '${RECONCILED_UID}'")" = 0
echo 'Applying the reviewed recovery export to reconcile that acknowledged write, then exporting the reconciled DB state.'
(cd "$ROOT" && npm run db:registry:import -- "$NODES_EXPORT_PATH" --apply) | tee "$ARTIFACT_DIR/reconciliation-apply.json"
grep -q '"inserted": 1' "$ARTIFACT_DIR/reconciliation-apply.json"
test "$(docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM public.registered_nodes WHERE uid = '${RECONCILED_UID}'")" = 1
export NODES_EXPORT_PATH="$ARTIFACT_DIR/registrations.json"
(cd "$ROOT" && npm run db:registry:export)

echo "Testing prior DB-aware application revision $PREVIOUS_RELEASE_REVISION against the expanded schema."
git -C "$ROOT" cat-file -e "${PREVIOUS_RELEASE_REVISION}^{commit}"
PREVIOUS_RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmedge-prior-db-release.XXXXXX")"
git -C "$ROOT" archive "$PREVIOUS_RELEASE_REVISION" | tar -x -C "$PREVIOUS_RELEASE_DIR"
ln -s "$ROOT/node_modules" "$PREVIOUS_RELEASE_DIR/node_modules"
cat > "$PREVIOUS_RELEASE_DIR/tsconfig.release.json" <<'JSON'
{
  "extends": "./tsconfig.json",
  "include": ["src/shared", "src/edge", "src/algo", "src/web", "src/tools", "src/modules", "src/infrastructure"]
}
JSON
(cd "$PREVIOUS_RELEASE_DIR" && ./node_modules/.bin/tsc -p tsconfig.release.json)
rollback_state() {
  docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -At -v ON_ERROR_STOP=1 -c \
    "SELECT 'registrations=' || count(*) FROM public.registered_nodes WHERE uid IN ('${NODE_UID}', '${RECONCILED_UID}');
     SELECT 'jobs=' || count(*) FROM public.firmware_build_jobs WHERE id = 'job-${RUN_ID}';
     SELECT 'audit=' || count(*) FROM public.provisioning_audit_events WHERE subject_id = 'release-${RUN_ID}';
     SELECT 'history=' || count(*) FROM public.occupancy_history WHERE edge_id = 'release-${RUN_ID}';
     SELECT 'history-load=' || count(*) FROM public.occupancy_history WHERE edge_id = 'load-${RUN_ID}';
     SELECT 'rollouts=' || count(*) FROM public.firmware_rollouts WHERE id = 'roll-${RUN_ID}';
     SELECT 'commands=' || count(*) FROM public.command_outcomes WHERE command_id = 'release-${RUN_ID}';"
}
rollback_state > "$ARTIFACT_DIR/pre-rollback-counts.txt"
read -r ROLLBACK_CONSOLE_PORT ROLLBACK_UDP_PORT < <(python3 - <<'PY'
import socket
sockets = []
try:
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        sock = socket.socket(socket.AF_INET, kind)
        sock.bind(('127.0.0.1', 0))
        sockets.append(sock)
    print(sockets[0].getsockname()[1], sockets[1].getsockname()[1])
finally:
    for sock in sockets:
        sock.close()
PY
)
ROLLBACK_LOG="$ARTIFACT_DIR/previous-release.log"
env PERSISTENCE_MODE=postgres SITE_CONFIG="$ROOT/config/site.json" NODES_CONFIG="$ROOT/config/nodes.json" \
  UDP_HOST=127.0.0.1 UDP_PORT="$ROLLBACK_UDP_PORT" CONSOLE_HOST=127.0.0.1 CONSOLE_PORT="$ROLLBACK_CONSOLE_PORT" \
  ALGO_PORT=0 GATEWAY_PORT=0 NODE_PORT=0 WEB_PUSH_URLS= PUBLISH_MS=60000 ALLOW_UNSIGNED=1 \
  EDGE_ID="rollback-${RUN_ID}" DATA_DIR="$ARTIFACT_DIR/previous-release-data" \
  node "$PREVIOUS_RELEASE_DIR/dist/src/edge/main.js" > "$ROLLBACK_LOG" 2>&1 &
PREVIOUS_RELEASE_PID=$!
rollback_ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${ROLLBACK_CONSOLE_PORT}/api/layout" > "$ARTIFACT_DIR/previous-release-layout.json" \
    && grep -q "$RECONCILED_UID" "$ARTIFACT_DIR/previous-release-layout.json"; then
    rollback_ready=1
    break
  fi
  if ! kill -0 "$PREVIOUS_RELEASE_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
cat "$ROLLBACK_LOG"
test "$rollback_ready" = 1
kill -TERM "$PREVIOUS_RELEASE_PID"
wait "$PREVIOUS_RELEASE_PID" || true
PREVIOUS_RELEASE_PID=""
rollback_state > "$ARTIFACT_DIR/post-rollback-counts.txt"
diff -u "$ARTIFACT_DIR/pre-rollback-counts.txt" "$ARTIFACT_DIR/post-rollback-counts.txt"
printf 'previous_revision=%s\nexpanded_schema_startup=PASS\nregistry_read=PASS\ncommitted_rows_preserved=PASS\n' \
  "$(git -C "$ROOT" rev-parse --short "$PREVIOUS_RELEASE_REVISION")" | tee "$ARTIFACT_DIR/rollback-compatibility.txt"

echo 'Taking a custom-format backup from the disposable source database.'
echo 'Generating 10,000 synthetic minute-history rows to sample local DB write and storage pressure.'
LOAD_SQL="WITH bucket AS (SELECT date_trunc('minute', now()) AS minute_at)
INSERT INTO public.occupancy_history (minute_at, sampled_at, edge_id, floor_id, table_id, capacity, occupied, free, coverage)
SELECT bucket.minute_at, bucket.minute_at + interval '30 seconds', 'load-${RUN_ID}', 'load-f1', 'table-' || series,
       100, 37, 63, 'ok'
FROM bucket CROSS JOIN generate_series(1, 10000) AS series;"
time docker exec "$CONTAINER" psql -U tmedge_admin -d tmedge_test -v ON_ERROR_STOP=1 -c "$LOAD_SQL"

docker exec "$CONTAINER" pg_dump -U tmedge_admin -d tmedge_test --format=custom --no-owner --no-privileges > "$DUMP"
test -s "$DUMP"
docker exec -i "$CONTAINER" pg_restore --list < "$DUMP" > "$ARTIFACT_DIR/backup-toc.txt"
docker exec "$CONTAINER" createdb -U tmedge_admin "$RESTORE_DB"
RESTORE_CREATED=1
docker exec -i "$CONTAINER" pg_restore -U tmedge_admin -d "$RESTORE_DB" --no-owner --no-privileges < "$DUMP"
docker exec "$CONTAINER" psql -U tmedge_admin -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -c \
  'GRANT USAGE ON SCHEMA public TO tmedge_runtime;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tmedge_runtime;
   GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tmedge_runtime;'

echo 'Loading the restored registry through the application repository and comparing the recovery export.'
export PGDATABASE="$RESTORE_DB" NODES_EXPORT_PATH="$ARTIFACT_DIR/restored-registrations.json"
(cd "$ROOT" && npm run db:registry:export)
diff -u "$ARTIFACT_DIR/registrations.json" "$ARTIFACT_DIR/restored-registrations.json"
(cd "$ROOT" && npm run db:registry:import -- "$NODES_EXPORT_PATH")
export PGDATABASE=tmedge_test

counts() {
  docker exec "$CONTAINER" psql -U tmedge_admin -d "$1" -At -v ON_ERROR_STOP=1 -c \
    "SELECT 'registrations=' || count(*) FROM public.registered_nodes WHERE uid IN ('${NODE_UID}', '${RECONCILED_UID}');
     SELECT 'jobs=' || count(*) FROM public.firmware_build_jobs WHERE id = 'job-${RUN_ID}';
     SELECT 'audit=' || count(*) FROM public.provisioning_audit_events WHERE subject_id = 'release-${RUN_ID}';
     SELECT 'history=' || count(*) FROM public.occupancy_history WHERE edge_id = 'release-${RUN_ID}';
     SELECT 'history-load=' || count(*) FROM public.occupancy_history WHERE edge_id = 'load-${RUN_ID}';
     SELECT 'rollouts=' || count(*) FROM public.firmware_rollouts WHERE id = 'roll-${RUN_ID}';
     SELECT 'commands=' || count(*) FROM public.command_outcomes WHERE command_id = 'release-${RUN_ID}';"
}
counts tmedge_test | tee "$ARTIFACT_DIR/source-counts.txt"
counts "$RESTORE_DB" | tee "$ARTIFACT_DIR/restored-counts.txt"
diff -u "$ARTIFACT_DIR/source-counts.txt" "$ARTIFACT_DIR/restored-counts.txt"

echo 'Checking that code rollback cannot remove the expanded schema or committed rows.'
docker exec "$CONTAINER" psql -U tmedge_admin -d "$RESTORE_DB" -At -v ON_ERROR_STOP=1 -c \
  "SELECT uid FROM public.registered_nodes WHERE uid = '${NODE_UID}';
   SELECT id FROM public.firmware_build_jobs WHERE id = 'job-${RUN_ID}';" > "$ARTIFACT_DIR/previous-contract-query.txt"

echo 'Writing a synthetic local recording sample to measure file storage (no sensor data).'
python3 - "$ARTIFACT_DIR/recording-sample.jsonl" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as output:
    for index in range(10000):
        output.write(json.dumps({'at': index, 'kind': 'report', 'uid': 'synthetic-node', 'detections': [{'x': 1.0, 'y': 2.0, 'persons': 1}]}) + '\n')
PY
du -h "$DUMP" "$ARTIFACT_DIR/recording-sample.jsonl"
docker stats --no-stream --format 'container={{.Name}} cpu={{.CPUPerc}} memory={{.MemUsage}}' "$CONTAINER" | tee "$ARTIFACT_DIR/postgres-resource-sample.txt"
echo 'Worker configuration (limits, not observed usage): cpus=1.0 memory=768m swap=1536m; no production worker was started.'
echo 'Rehearsal source and restore identities were isolated; no live service or AWS endpoint was contacted.'
