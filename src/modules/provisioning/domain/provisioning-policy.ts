/** A queued join request must be reviewed within thirty minutes. */
export const REQUEST_TTL_MS = 30 * 60_000;
/** Bound the pending queue so accidental or malicious requests stay manageable. */
export const MAX_PENDING = 32;
