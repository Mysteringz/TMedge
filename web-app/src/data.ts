/**
 * Everything the app knows about the world: who is signed in, and the live
 * occupancy the edges publish.
 *
 * The snapshot arrives over a WebSocket and is re-fetched if that drops.
 * Unknown is never turned into free anywhere in here -- a table with no
 * working sensor stays null all the way to the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { disconnectedView } from './live.ts';
import { allocate, floorIsDark, knownFree, largestTableFree, walkOrder, type Allocation } from '../../src/shared/allocate.js';
import { spaceInfo, VENUES, type SpaceInfo, type Venue } from '../../src/shared/venues.js';
import { resolveCampusFloor } from '../../src/shared/location-identity.js';
import { parseCampusView } from '../../src/shared/campus-view.js';
import { SIMPLE_ROOM_SOURCE } from '../../src/shared/simple-room-geometry.js';
import type { CampusFloor, CampusView, PublishedFloorModel, TableState } from '../../src/shared/types.js';

export type { CampusFloor, CampusView, TableState, Allocation, Venue };
export { allocate, knownFree, largestTableFree, resolveCampusFloor, spaceInfo, walkOrder, VENUES };

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
  feedState: 'loading' | 'ready' | 'error';
  retryFeed(): void;
}

/** The live occupancy feed: a WebSocket, with a fetch to prime it. */
export function useLive(): Live {
  const [view, setView] = useState<CampusView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [feedState, setFeedState] = useState<Live['feedState']>('loading');
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const retry = useRef(1000);
  const retryFeed = useCallback(() => {
    setView(null);
    setFeedState('loading');
    setConnection('connecting');
    setRefreshGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let lastMessage = Date.now();
    let latestGeneration = 0;
    let feedDisconnected = false;
    const disconnect = () => {
      feedDisconnected = true;
      setConnection('offline');
      setView((current) => current ? disconnectedView(current) : null);
      if (!latestGeneration) setFeedState('error');
    };

    const failClosed = () => {
      if (!alive) return;
      latestGeneration = 0;
      setView(null);
      setFeedState('error');
      setConnection('offline');
    };

    const accept = (value: unknown): boolean => {
      const next = parseCampusView(value);
      if (!next) { failClosed(); return false; }
      if (!alive || next.generatedAt < latestGeneration) return true;
      latestGeneration = next.generatedAt;
      setFeedState('ready');
      setView(next);
      setUpdatedAt(Date.now());
      return true;
    };

    void fetch('/api/occupancy')
      .then(async (response) => {
        if (!response.ok) throw new Error('snapshot request failed');
        const value: unknown = await response.json();
        const parsed = parseCampusView(value);
        if (!parsed) { if (!latestGeneration) failClosed(); return; }
        if (!feedDisconnected) accept(parsed);
      })
      .catch(() => { if (!latestGeneration) failClosed(); });

    const open = () => {
      if (!alive) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        retry.current = 1000;
        lastMessage = Date.now();
      };
      ws.onmessage = (e) => {
        if (!alive || socket !== ws) return;
        try {
          const next: unknown = JSON.parse(String(e.data));
          lastMessage = Date.now();
          feedDisconnected = false;
          if (!accept(next)) { ws.close(); return; }
          setConnection('live');
        } catch { failClosed(); ws.close(); }
      };
      ws.onclose = () => {
        if (!alive || socket !== ws) return;
        disconnect();
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
    // A lost network can leave a WebSocket looking open. The server sends a
    // view every 10 seconds; missing three means the counts are unknown.
    const watchdog = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 30_000) { disconnect(); socket.close(); }
    }, 5000);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(watchdog);
      socket?.close();
    };
  }, [refreshGeneration]);

  return { view, connection, updatedAt, feedState, retryFeed };
}

export interface VenueSpaces {
  venue: Venue;
  floors: CampusFloor[];
  open: boolean;
}

export type FloorSpaceSource = 'generated' | 'custom' | '2d' | 'legacy' | 'none';
export type FloorSpacePresentation = Omit<SpaceInfo, 'model'> & {
  model: SpaceInfo['model'];
  source: FloorSpaceSource;
  uploadedModel?: PublishedFloorModel;
};

/** Venues with the floors their edges are actually publishing. */
export function useVenues(view: CampusView | null): VenueSpaces[] {
  return useMemo(() => {
    const floors = view?.floors ?? [];
    const counts = new Map<string, number>();
    for (const floor of floors) counts.set(floor.id, (counts.get(floor.id) ?? 0) + 1);
    const claimed = new Set(VENUES.flatMap((v) => v.floorIds));
    const out: VenueSpaces[] = VENUES.map((venue) => {
      // A bare legacy catalog ID is usable only while it names one live
      // composite location. Duplicate IDs remain separate dynamic spaces.
      const mine = floors.filter((f) => counts.get(f.id) === 1 && venue.floorIds.includes(f.id));
      return { venue, floors: mine, open: venue.open && mine.length > 0 };
    });
    const extra = floors.filter((f) => counts.get(f.id) !== 1 || !claimed.has(f.id));
    const groups = new Map<string, CampusFloor[]>();
    for (const floor of extra) {
      const groupKey = JSON.stringify([floor.siteId, floor.building]);
      const group = groups.get(groupKey) ?? [];
      group.push(floor);
      groups.set(groupKey, group);
    }
    for (const [groupKey, group] of groups) {
      const building = group[0]?.building || 'Other spaces';
      out.unshift({
        venue: {
          id: `dynamic:${groupKey}`,
          name: building,
          shortName: building,
          kicker: 'Campus',
          photo: '',
          caption: '',
          floorIds: group.map((f) => f.id),
          open: true,
          entrance: 'Follow the signs to the study area.',
        },
        floors: group,
        open: true,
      });
    }
    return out;
  }, [view]);
}

/** Returns the unique legacy venue adapter or a safe composite-only default. */
export function floorSpaceInfo(floor: CampusFloor, allFloors: readonly CampusFloor[]): FloorSpacePresentation {
  const unique = allFloors.filter((item) => item.id === floor.id).length === 1
    && VENUES.some((venue) => venue.floorIds.includes(floor.id));
  const legacy = unique ? spaceInfo(floor.id) : spaceInfo('');
  // The exact v2 discriminator selects the room before the old venue catalog
  // can supply a static model for the same bare floor ID.
  if (floor.proceduralRoom === SIMPLE_ROOM_SOURCE) return { ...legacy, model: null, source: 'generated' };
  if (floor.model === null) return { ...legacy, model: null, source: '2d' };
  if (floor.model) return {
    ...legacy,
    model: { src: `/api/models/${encodeURIComponent(floor.model.assetId)}`, room: floor.name,
      columns: Math.max(1, floor.tables.length), rows: 1 },
    source: 'custom',
    uploadedModel: floor.model,
  };
  return {
    ...legacy,
    model: unique ? legacy.model : null,
    source: unique && legacy.model ? 'legacy' : 'none',
    uploadedModel: undefined,
  };
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

/**
 * Tables a group of `seats` could take at all, in walking order.
 *
 * No screen calls this yet — Spaces marks the same tables from the live
 * snapshot — but it is the table-level form of the question the seat search
 * asks, so the rule has one home when the next view needs it.
 */
export function freeTables(floor: CampusFloor, seats: number): TableState[] {
  if (isDark(floor)) return [];
  return walkOrder(floor.tables).filter((t) => t.status !== 'unknown' && (t.free ?? 0) >= Math.min(seats, t.capacity));
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Group size, kept in the URL so a link to a search is a link to a search. */
export function useSeats(): [number, (n: number) => void] {
  const { search } = useLocation();
  const navigate = useNavigate();
  const read = useCallback(() => {
    const n = Number(new URLSearchParams(location.search).get('seats'));
    return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 1;
  }, []);
  const [seats, set] = useState(read);
  useEffect(() => set(read()), [search, read]);
  const update = useCallback((n: number) => {
    const next = Math.min(16, Math.max(1, Math.round(n || 1)));
    set(next);
    const url = new URL(location.href);
    url.searchParams.set('seats', String(next));
    navigate(url.pathname + url.search + url.hash, { replace: true });
  }, [navigate]);
  return [seats, update];
}
