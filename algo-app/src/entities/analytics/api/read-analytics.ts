import type { AnalyticsSnapshot, RangeId } from '../model/types.ts';

export class AnalyticsAccessError extends Error { constructor(readonly status: number) { super('Analytics access changed.'); } }

/** Same-origin cookie request. Losing access is told to the shell, which signs out or re-reads the role. */
export async function readAnalytics(range: RangeId, signal: AbortSignal): Promise<AnalyticsSnapshot> {
  const response = await fetch(`/api/analytics?range=${range}`, { signal, credentials: 'same-origin' });
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('admin-access-change', { detail: response.status }));
    throw new AnalyticsAccessError(response.status);
  }
  if (!response.ok) throw new Error('Analytics could not be loaded.');
  const body: { data: AnalyticsSnapshot | null; error: unknown } = await response.json();
  if (!body.data || body.error) throw new Error('Analytics are unavailable.');
  return body.data;
}
