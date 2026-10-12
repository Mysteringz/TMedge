/**
 * The student email, in one place.
 *
 * An HKU student writes `u1234567`; the address is that plus
 * `@connect.hku.hk`. Both the sign-up form (which shows the domain beside the
 * box rather than making the student type it) and the server (which must not
 * trust anything the browser assembled) build the address the same way, so
 * there is exactly one spelling of every account.
 *
 * The UID is exactly seven digits after the `u`: the university verifies that
 * form, and an account nobody can receive mail at is an account nobody can
 * recover. Digits are not otherwise restricted -- a real UID may start with 3
 * or with 0, and leading zeros are kept.
 */

export const STUDENT_EMAIL_DOMAIN = 'connect.hku.hk';

/** `u` then exactly seven digits. */
export const STUDENT_UID_PATTERN = /^u\d{7}$/;

/** A whole address in the form a student's account is stored under. */
export const STUDENT_EMAIL_PATTERN = /^u\d{7}@connect\.hku\.hk$/;

/** True for a UID a student typed, in any case, with space around it. */
export function isStudentUid(raw: string): boolean {
  return STUDENT_UID_PATTERN.test(raw.trim().toLowerCase());
}

/** The address for a UID, or null when what was typed is not one. */
export function studentEmailForUid(raw: string): string | null {
  const uid = raw.trim().toLowerCase();
  return STUDENT_UID_PATTERN.test(uid) ? `${uid}@${STUDENT_EMAIL_DOMAIN}` : null;
}

/**
 * The address out of what a form posted: a bare UID, or an address already
 * written in full (`u1234567@connect.hku.hk`). Anything else is handed back
 * untouched, so the caller's own validation produces the complaint.
 */
export function resolveStudentEmail(raw: string): string {
  const trimmed = raw.trim();
  return studentEmailForUid(trimmed) ?? trimmed;
}
