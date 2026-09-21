/**
 * Everything the app knows about the world: who is signed in, and the live
 * occupancy the edges publish.
 *
 * The snapshot arrives over a WebSocket and is re-fetched if that drops.
 * Unknown is never turned into free anywhere in here -- a table with no
 * working sensor stays null all the way to the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allocate, floorIsDark, knownFree, largestTableFree, walkOrder, type Allocation } from '../../src/shared/allocate.js';
import { spaceInfo, VENUES, type Venue } from '../../src/shared/venues.js';
import type { CampusFloor, CampusView, TableState } from '../../src/shared/types.js';

export type { CampusFloor, CampusView, TableState, Allocation, Venue };
export { allocate, knownFree, largestTableFree, spaceInfo, walkOrder, VENUES };

export interface Me {
  email: string;
  name?: string;
}

/** Signed-in student, or null while we do not know yet. */
export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch('/api/me')
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((v) => alive && setMe(v))
      .catch(() => alive && setMe(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);
  return { me, loading };
}

export type Connection = 'connecting' | 'live' | 'offline';

export interface Live {
  view: CampusView | null;
  connection: Connection;
  updatedAt: number;
}

/** The live occupancy feed: a WebSocket, with a fetch to prime it. */
export function useLive(): Live {
  const [view, setView] = useState<CampusView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [updatedAt, setUpdatedAt] = useState(0);
  const retry = useRef(1000);

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    let timer: number | undefined;

    const accept = (next: CampusView) => {
      if (!alive) return;
      setView(next);
      setUpdatedAt(Date.now());
    };

    fetch('/api/occupancy')
      .then((r) => (r.ok ? (r.json() as Promise<CampusView>) : null))
      .then((v) => v && accept(v))
      .catch(() => undefined);

    const open = () => {
      if (!alive) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        retry.current = 1000;
        setConnection('live');
      };
      ws.onmessage = (e) => accept(JSON.parse(String(e.data)) as CampusView);
      ws.onclose = () => {
        if (!alive) return;
        setConnection('offline');
        // A closed socket can mean the session expired; the server answers 401
        // and the app sends the student to sign in again.
        fetch('/api/me').then((r) => {
          if (r.status === 401) location.href = `/login/?next=${encodeURIComponent(location.pathname)}`;
        }).catch(() => undefined);
        timer = window.setTimeout(open, retry.current);
        retry.current = Math.min(retry.current * 2, 30_000);
      };
    };
    open();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { view, connection, updatedAt };
}

export interface VenueSpaces {
  venue: Venue;
  floors: CampusFloor[];
  open: boolean;
}

/** Venues with the floors their edges are actually publishing. */
export function useVenues(view: CampusView | null): VenueSpaces[] {
  return useMemo(() => {
    const floors = view?.floors ?? [];
    const claimed = new Set(VENUES.flatMap((v) => v.floorIds));
    const out: VenueSpaces[] = VENUES.map((venue) => {
      const mine = floors.filter((f) => venue.floorIds.includes(f.id));
      return { venue, floors: mine, open: venue.open && mine.length > 0 };
    });
    const extra = floors.filter((f) => !claimed.has(f.id));
    if (extra.length > 0) {
      out.unshift({
        venue: {
          id: 'other',
          name: extra[0]?.building ?? 'Other spaces',
          shortName: extra[0]?.building ?? 'Other spaces',
          kicker: 'Campus',
          photo: '',
          caption: '',
          floorIds: extra.map((f) => f.id),
          open: true,
          entrance: 'Follow the signs to the study area.',
        },
        floors: extra,
        open: true,
      });
    }
    return out;
  }, [view]);
}

/** A floor nobody can see right now: stale edge, or every table unknown. */
export function isDark(floor: CampusFloor): boolean {
  return floor.stale || floorIsDark(floor);
}

export function unknownTables(floor: CampusFloor): TableState[] {
  return floor.tables.filter((t) => t.status === 'unknown' || t.free === null);
}

export function capacityOf(floor: CampusFloor): number {
  return Math.max(0, ...floor.tables.map((t) => t.capacity));
}

/** Tables a group of `seats` could actually take, largest run first. */
export function freeTables(floor: CampusFloor, seats: number): TableState[] {
  if (isDark(floor)) return [];
  return walkOrder(floor.tables).filter((t) => t.status !== 'unknown' && (t.free ?? 0) >= Math.min(seats, t.capacity));
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Group size, kept in the URL so a link to a search is a link to a search. */
export function useSeats(): [number, (n: number) => void] {
  const read = useCallback(() => {
    const n = Number(new URLSearchParams(location.search).get('seats'));
    return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 1;
  }, []);
  const [seats, set] = useState(read);
  const update = useCallback((n: number) => {
    const next = Math.min(16, Math.max(1, Math.round(n || 1)));
    set(next);
    const url = new URL(location.href);
    url.searchParams.set('seats', String(next));
    history.replaceState(null, '', url);
  }, []);
  return [seats, update];
}
