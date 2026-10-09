export class InvalidHealthObservation extends Error {}

/** Epoch milliseconds must also be representable by JavaScript Date. */
export function healthTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new InvalidHealthObservation('Invalid operational timestamp');
  }
  return value;
}
export function nullableHealthTimestamp(value: unknown): number | null {
  return value == null ? null : healthTimestamp(value);
}
export function healthText(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidHealthObservation('Invalid operational identity');
  return value.slice(0, 160);
}
