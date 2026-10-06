/** A canonical same-site destination; browsers treat backslashes as slashes. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(raw)) return '/dashboard/';
  try {
    const url = new URL(raw, 'https://navigation.invalid');
    if (url.origin !== 'https://navigation.invalid' || url.pathname.startsWith('//') || /^\/(?:login|signup|auth)(?:\/|$)/.test(url.pathname)) return '/dashboard/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/dashboard/';
  }
}
