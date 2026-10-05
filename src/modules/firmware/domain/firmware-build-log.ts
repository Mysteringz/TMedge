const MAX_LOG_LINES = 400;
const MAX_LOG_LINE_CHARS = 4096;
const MAX_LOG_BYTES = 128 * 1024;

/** Retains the newest lines within the PostgreSQL JSONB text byte budget. */
export function boundedFirmwareBuildLog(lines: readonly string[]): string[] {
  const candidates = lines.slice(-MAX_LOG_LINES).map((line) => line.slice(0, MAX_LOG_LINE_CHARS));
  const retained: string[] = [];
  let bytes = 2;
  for (const line of candidates.reverse()) {
    // JSONB renders array separators as comma-space rather than compact commas.
    const nextBytes = Buffer.byteLength(JSON.stringify(line)) + (retained.length ? 2 : 0);
    if (bytes + nextBytes > MAX_LOG_BYTES) break;
    retained.push(line);
    bytes += nextBytes;
  }
  return retained.reverse();
}
