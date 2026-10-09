import type { HealthSnapshot } from '../model/types.ts';
export class HealthAccessError extends Error { constructor(readonly status: number) { super('System status access changed.'); } }
/** Same-origin cookie request; authentication failures clear the shell session. */
export async function readHealth(signal: AbortSignal): Promise<HealthSnapshot> {
  const response = await fetch('/api/admin/health', { signal, credentials: 'same-origin' });
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('admin-access-change', { detail: response.status }));
    throw new HealthAccessError(response.status);
  }
  if (!response.ok) throw new Error('System status could not be refreshed.');
  const body: { data: HealthSnapshot | null; error: unknown } = await response.json();
  if (!body.data || body.error) throw new Error('System status is unavailable.');
  return body.data;
}
