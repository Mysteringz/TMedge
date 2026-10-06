const SAFE_FIELDS = new Set([
  'operationId', 'component', 'lifecycle', 'outcome', 'nodeId', 'actorId', 'durationMs', 'count', 'errorCode',
]);

/** Emits only explicitly approved metadata; raw frames, credentials and error text cannot enter logs. */
export function operationalLog(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...safe }));
}
