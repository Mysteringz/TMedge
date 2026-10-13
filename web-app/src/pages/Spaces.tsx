/**
 * Available spaces, with a composite campus-location identity in every route.
 * Old floor-only links work only while the ID is unambiguous.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { recordStudentActivity, useSpaceViewActivity } from '../activity.ts';
import {
  allocate, capacityOf, floorSpaceInfo, isDark, knownFree, plural, resolveCampusFloor,
  unknownTables, useLive, useMe, useSeats, useVenues, walkOrder, type CampusFloor,
} from '../data.ts';
import { Chrome, FeedUnavailable, NoStudySpaces, Notice, SpacesSkeleton, ViewerSkeleton } from '../ui.tsx';
import FloorViewer from '../FloorViewer.tsx';
import FloorMap from '../FloorMap.tsx';

export default function Spaces() {
  const { siteId, floorId } = useParams();
  const navigate = useNavigate();
  const { me } = useMe();
  const live = useLive();
  const floors = live.view?.floors ?? [];
  const venues = useVenues(live.view);
  const [seats] = useSeats();
  const [table, setTable] = useState<string | null>(null);
  const [directions, setDirections] = useState(false);

  const resolution = floorId ? resolveCampusFloor(floors, floorId, siteId) : null;
  const requestedFloor = resolution?.kind === 'found' ? resolution.floor : null;
  const entry = useMemo(() => requestedFloor
    ? venues.find((venue) => venue.floors.some((floor) => floor.key === requestedFloor.key)) ?? null
    : floorId ? null : venues.find((venue) => venue.open && venue.floors.length > 0) ?? null,
  [venues, floorId, requestedFloor?.key]);
  const floor = requestedFloor ?? (!floorId ? entry?.floors[0] ?? null : null);
  useSpaceViewActivity(floor?.siteId, floor?.id, seats);

  const pickTable = (tableId: string | null) => {
    if (floor && tableId) recordStudentActivity({ action: 'table-select', seats, siteId: floor.siteId, floorId: floor.id, tableId });
    setTable(tableId);
  };
  const toggleDirections = () => {
    if (floor && !directions) recordStudentActivity({
      action: 'directions-view', seats, siteId: floor.siteId, floorId: floor.id, ...(table ? { tableId: table } : {}),
    });
    setDirections(!directions);
  };

  useEffect(() => { document.title = `${entry?.venue.shortName ?? 'Spaces'} - HKUMySeat`; }, [entry]);
  useEffect(() => { setTable(null); setDirections(false); }, [floor?.key]);

  const collisions = floorId ? floors.filter((item) => item.id === floorId) : [];
  return (
    <Chrome crumb="Available spaces" live={live} who={me?.name ?? me?.email ?? ''}>
      <div className="screen">
        <Link data-testid="student-change-search" className="btn btn-ghost" to={`/dashboard/?seats=${seats}`}>Change search</Link>
        <div className="screen-head">
          <h1>{entry?.venue.name ?? 'Spaces'}</h1>
          <span className="note text-muted">{plural(seats, 'seat')} - {entry?.venue.name ?? ''}</span>
        </div>
        <hr className="hr" />

        {live.view === null && live.feedState === 'loading' ? <><SpacesSkeleton /><ViewerSkeleton /></> : live.view === null ? <FeedUnavailable retry={live.retryFeed} /> : live.view.floors.length === 0 ? <NoStudySpaces /> : resolution?.kind === 'ambiguous' ? (
          <>
            <Notice tone="warn">This old link names more than one campus location. Choose the correct location below.</Notice>
            <div className="spaces">
              {collisions.map((candidate) => (
                <SpaceBlock key={candidate.key} floor={candidate} allFloors={floors} seats={seats} selected={false}
                  testId={`student-ambiguity-choice-${locationTestKey(candidate)}`}
                  onOpen={() => navigate(spacePath(candidate, seats))} />
              ))}
            </div>
          </>
        ) : floorId && !requestedFloor ? (
          <Notice tone="warn">This space is no longer available in the current live view. Return to search and choose an active location.</Notice>
        ) : !entry || !floor ? (
          <Notice>No sensed space is online right now.</Notice>
        ) : (
          <>
            <div className="section-label">Available</div>
            <div className="spaces">
              {entry.floors.map((item) => (
                <SpaceBlock key={item.key} floor={item} allFloors={floors} seats={seats}
                  selected={item.key === floor.key} testId={`student-space-card-${locationTestKey(item)}`}
                  onOpen={() => navigate(spacePath(item, seats))} />
              ))}
            </div>
            <LiveView floor={floor} allFloors={floors} seats={seats} table={table} onTable={pickTable}
              directions={directions} onDirections={toggleDirections} />
          </>
        )}
      </div>
    </Chrome>
  );
}

function spacePath(floor: CampusFloor, seats: number): string {
  return `/dashboard/spaces/${encodeURIComponent(floor.siteId)}/${encodeURIComponent(floor.id)}?seats=${seats}`;
}

function locationTestKey(floor: CampusFloor): string {
  return `${encodeURIComponent(floor.siteId)}-${encodeURIComponent(floor.id)}`;
}

function SpaceBlock({ floor, allFloors, seats, selected, onOpen, testId }: {
  floor: CampusFloor; allFloors: readonly CampusFloor[]; seats: number; selected: boolean; onOpen: () => void; testId: string;
}) {
  const info = floorSpaceInfo(floor, allFloors);
  const dark = isDark(floor);
  const fit = dark ? null : allocate(floor, seats);
  const free = knownFree(floor);
  return (
    <button type="button" data-testid={testId} className="space" aria-pressed={selected} onClick={onOpen}>
      <span className="space-head">
        <span className="space-name">
          <span className="floor">{info.floorLabel || floor.building}</span>
          <span className="sname">{floor.name}</span>
        </span>
        <span className="count">
          <span className="n">{dark ? 'No live data' : fit ? `${plural(seats, 'seat')} together` : 'No seats together'}</span>
          <span className="k">{dark ? 'Sensors offline' : `${plural(free, 'free seat')}`}</span>
        </span>
      </span>
    </button>
  );
}

function LiveView({ floor, allFloors, seats, table, onTable, directions, onDirections }: {
  floor: CampusFloor;
  allFloors: readonly CampusFloor[];
  seats: number;
  table: string | null;
  onTable: (id: string | null) => void;
  directions: boolean;
  onDirections: () => void;
}) {
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncement = useRef('');
  const info = floorSpaceInfo(floor, allFloors);
  const ordered = walkOrder(floor.tables);
  const dark = isDark(floor);
  const cap = capacityOf(floor);
  const free = knownFree(floor);
  const unknown = unknownTables(floor);
  const fits = (t: { free: number | null; status: string; capacity: number }) =>
    t.status !== 'unknown' && (t.free ?? 0) >= Math.min(seats, t.capacity);
  const index = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const selectedTable = floor.tables.find((item) => item.id === table);
  const selectedStatus = !selectedTable ? '' : isDark(floor) || selectedTable.status === 'unknown' || selectedTable.free === null
    ? `${selectedTable.name}: live availability is unknown`
    : `${selectedTable.name}: ${selectedTable.free === 0 ? 'full' : `${selectedTable.free} of ${selectedTable.capacity} seats free`}`;
  useEffect(() => {
    if (selectedStatus && selectedStatus !== lastAnnouncement.current) {
      lastAnnouncement.current = selectedStatus;
      setAnnouncement(selectedStatus);
    } else if (!selectedStatus) {
      lastAnnouncement.current = '';
      setAnnouncement('');
    }
  }, [selectedStatus, lastAnnouncement]);
  const list = (pick: (t: (typeof ordered)[number]) => boolean) =>
    ordered.map((t, i) => (pick(t) ? i + 1 : 0)).filter(Boolean).join(',');
  const authoredLayout = info.uploadedModel ? {
    width: floor.width,
    height: floor.height,
    tables: floor.tables,
    selectedTableId: table,
  } : undefined;

  return (
    <>
      {dark && <Notice tone="warn">Nobody is counting {floor.name} at the moment. The room is drawn below, but no table is shown as free.</Notice>}
      {!dark && unknown.length > 0 && <Notice>{plural(unknown.length, 'table')} here have no working sensor. They are never counted as free.</Notice>}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      {info.model && <div className="panel panel-3d">
        <div className="panel-title">3D map - drag to rotate, scroll or pinch to zoom</div>
        <div className="panel-tools">
          <button type="button" data-testid="student-directions-toggle" className={`btn ${directions ? 'btn-primary' : 'btn-secondary'}`} onClick={onDirections}>
            {directions ? 'Hide directions' : 'Get directions'}
          </button>
          <button type="button" data-testid="student-model-zoom-to-table" className="btn btn-secondary" onClick={() => viewer()?.zoomToSeat?.()}>Zoom to table</button>
          <button type="button" data-testid="student-model-reset-view" className="btn btn-secondary" onClick={() => viewer()?.resetView?.()}>Reset view</button>
        </div>
        <div className="viewport">
          {(
            <FloorViewer
              src={info.model.src} room={info.model.room} columns={info.model.columns} rows={info.model.rows}
              labels={ordered.map((item) => item.name)} free={list(fits)}
              occupied={list((item) => item.status !== 'unknown' && (item.free ?? 0) === 0)}
              dark={list((item) => item.status === 'unknown' || item.free === null)} selected={table ? index(table) : 0}
              directions={directions} onPick={(n) => { const picked = ordered[n - 1]; if (picked && fits(picked)) onTable(picked.id); }}
              locationLayout={authoredLayout} locationTransform={info.uploadedModel?.transform}
              onPickTable={(id) => { const picked = floor.tables.find((item) => item.id === id); if (picked && fits(picked)) onTable(id); }}
            />
          )}
        </div>
        <div className="caption text-muted">Green tables have room for {plural(seats, 'seat')}; grey are full and faint ones have no sensor data. Pick a table here or below to mark it on the map.</div>
      </div>}

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Floor plan - top-down</div>
          <div className="legend">
            <span><i className="free" />Room for you</span><span><i className="picked" />Picked</span>
            <span><i className="full" />Full</span><span><i className="nodata" />No data</span>
          </div>
        </div>
        <FloorMap floor={floor} selected={table} canSelect={fits} onTable={(id) => onTable(table === id ? null : id)} />
        {floor.tables.length === 0 && <p className="text-muted">No tables are mapped for this location yet.</p>}
        <section className="plan-list" aria-labelledby="table-availability-heading">
          <h3 id="table-availability-heading" className="section-label">Tables by live availability</h3>
          <ul>
          {ordered.map((item) => {
            const unknownTable = item.status === 'unknown' || item.free === null;
            const roomy = fits(item);
            const meta = unknownTable ? 'No live data' : item.free === 0 ? 'Full' : `${item.free} of ${item.capacity} free`;
            return <li key={item.id}><button type="button" data-testid={`student-table-list-${encodeURIComponent(item.id)}`} aria-pressed={item.id === table} disabled={!roomy && item.id !== table}
              className={`plan-list-item${item.id === table ? ' plan-list-picked' : ''}`} onClick={() => onTable(item.id === table ? null : item.id)}>
              <span>{item.name}</span><span>{meta}</span>
            </button></li>;
          })}
          </ul>
        </section>
        <div className="plan-foot">
          <span className="text-muted">{info.entranceNote}</span>
          <span className="text-muted">{dark ? 'No live counts for this space' : `${free} of ${floor.totals.seats} seats free - ${cap} seats per table`}</span>
        </div>
      </div>
    </>
  );
}

function viewer(): (HTMLElement & { resetView?: () => void; zoomToSeat?: () => void }) | null {
  return document.querySelector('floor-viewer');
}
