import { useEffect, useRef } from 'react';
import type { StudentUsageInput } from '../../src/shared/student-activity.ts';

/** Records explicit interactions without delaying navigation or retrying failures. */
export function recordStudentActivity(input: StudentUsageInput): void {
  try {
    void fetch('/api/activity', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tm-student-activity': '1' },
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // A transport failure must leave the student's interaction usable.
  }
}

/** Counts entered floors while ignoring live updates and StrictMode effect replay. */
export function useSpaceViewActivity(siteId: string | undefined, floorId: string | undefined, seats: number): void {
  const viewedFloor = useRef<string | undefined>(undefined);
  const identity = floorId ? JSON.stringify([siteId ?? '', floorId]) : undefined;
  useEffect(() => {
    if (!floorId || !identity || viewedFloor.current === identity) return;
    viewedFloor.current = identity;
    recordStudentActivity({ action: 'space-view', ...(siteId ? { siteId } : {}), floorId, seats });
  }, [siteId, floorId, identity, seats]);
}
