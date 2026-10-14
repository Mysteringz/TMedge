/**
 * Available spaces, with a composite campus-location identity in every route.
 * Old floor-only links work only while the ID is unambiguous.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { recordStudentActivity, useSpaceViewActivity } from '../activity.ts';
import {
  allocate, capacityOf, floorSpaceInfo, isDark, knownFree, plural, resolveCampusFloor,
  unknownTables, useLive, useMe, useSeats, useVenues, walkOrder, type CampusFloor,
} from '../data.ts';
import { Chrome, FeedUnavailable, NoStudySpaces, Notice, SpacesSkeleton, ViewerSkeleton } from '../ui.tsx';
import FloorViewer from '../FloorViewer.tsx';
import FloorMap from '../FloorMap.tsx';

type RoomViewMode = '2d' | '3d';

const ROOM_VIEW_MODE_KEY = 'hkumyseat.student.room-view-mode.v1';

function readRoomViewMode(): RoomViewMode | null {
  try {
    const value = window.localStorage.getItem(ROOM_VIEW_MODE_KEY);
    return value === '2d' || value === '3d' ? value : null;
  } catch {
    return null;
  }
}

function persistRoomViewMode(mode: RoomViewMode): void {
  try {
    window.localStorage.setItem(ROOM_VIEW_MODE_KEY, mode);
  } catch {
    // Keep the page's in-memory selection when browser persistence is unavailable.
  }
}

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
  const [preferredView, setPreferredView] = useState<RoomViewMode>(() => readRoomViewMode() ?? '3d');
  const [failedViewerKey, setFailedViewerKey] = useState<string | null>(null);
  const [viewerRetryRequest, setViewerRetryRequest] = useState(0);

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
  const clearRemovedSelection = useCallback(() => {
    setTable(null);
    setDirections(false);
  }, []);

  useEffect(() => { document.title = `${entry?.venue.shortName ?? 'Spaces'} - HKUMySeat`; }, [entry]);
  useEffect(() => { setTable(null); setDirections(false); setFailedViewerKey(null); }, [floor?.key]);

  const chooseView = (mode: RoomViewMode) => {
    setPreferredView(mode);
    persistRoomViewMode(mode);
    const retryFailedViewer = mode === '3d' && failedViewerKey !== null;
    setFailedViewerKey(null);
    if (retryFailedViewer) setViewerRetryRequest((value) => value + 1);
  };

  const retryViewer = () => {
    setFailedViewerKey(null);
    setViewerRetryRequest((value) => value + 1);
  };

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
              directions={directions} onDirections={toggleDirections} onSelectionRemoved={clearRemovedSelection}
              preferredView={preferredView} failedViewerKey={failedViewerKey} retryRequest={viewerRetryRequest}
              onChooseView={chooseView} onViewerFailure={setFailedViewerKey}
              onViewerRecovered={(key) => setFailedViewerKey((current) => current === key ? null : current)}
              onRetryViewer={retryViewer} />
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

function LiveView({ floor, allFloors, seats, table, onTable, directions, onDirections, onSelectionRemoved,
  preferredView, failedViewerKey, retryRequest, onChooseView, onViewerFailure, onViewerRecovered, onRetryViewer,
}: {
  floor: CampusFloor;
  allFloors: readonly CampusFloor[];
  seats: number;
  table: string | null;
  onTable: (id: string | null) => void;
  directions: boolean;
  onDirections: () => void;
  onSelectionRemoved: () => void;
  preferredView: RoomViewMode;
  failedViewerKey: string | null;
  retryRequest: number;
  onChooseView: (mode: RoomViewMode) => void;
  onViewerFailure: (key: string) => void;
  onViewerRecovered: (key: string) => void;
  onRetryViewer: () => void;
}) {
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncement = useRef('');
  const lastFloorKey = useRef(floor.key);
  const removedSelection = useRef<string | null>(null);
  const info = floorSpaceInfo(floor, allFloors);
  const supports3d = info.source === 'generated' || info.source === 'custom' || (info.source === 'legacy' && Boolean(info.model));
  const viewerKey = JSON.stringify([floor.key, info.source, info.model?.src ?? null]);
  const viewMode: RoomViewMode = supports3d && preferredView === '3d' && failedViewerKey !== viewerKey ? '3d' : '2d';
  const isFallback = supports3d && preferredView === '3d' && failedViewerKey === viewerKey;
  const [mountedViewerKey, setMountedViewerKey] = useState<string | null>(() => viewMode === '3d' ? viewerKey : null);
  useEffect(() => {
    if (viewMode === '3d') setMountedViewerKey(viewerKey);
    else if (mountedViewerKey !== null && mountedViewerKey !== viewerKey) setMountedViewerKey(null);
  }, [mountedViewerKey, viewMode, viewerKey]);
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
    if (lastFloorKey.current !== floor.key) {
      lastFloorKey.current = floor.key;
      removedSelection.current = null;
      lastAnnouncement.current = '';
      setAnnouncement('');
      return;
    }
    if (table && !selectedTable) {
      const removalKey = `${floor.key}\u0000${table}`;
      if (removedSelection.current !== removalKey) {
        removedSelection.current = removalKey;
        lastAnnouncement.current = removalKey;
        setAnnouncement('The selected table was removed from this location.');
        onSelectionRemoved();
      }
      return;
    }
    if (selectedStatus && selectedStatus !== lastAnnouncement.current) {
      removedSelection.current = null;
      lastAnnouncement.current = selectedStatus;
      setAnnouncement(selectedStatus);
    } else if (!selectedStatus && !removedSelection.current) {
      lastAnnouncement.current = '';
      setAnnouncement('');
    }
  }, [floor.key, table, selectedTable, selectedStatus, onSelectionRemoved]);
  const list = (pick: (t: (typeof ordered)[number]) => boolean) =>
    ordered.map((t, i) => (pick(t) ? i + 1 : 0)).filter(Boolean).join(',');
  const sceneFloor = info.source === 'generated' || info.source === 'custom' ? floor : undefined;
  const shouldMountViewer = supports3d && (viewMode === '3d' || mountedViewerKey === viewerKey);
  const unavailableHintId = 'student-view-3d-unavailable';

  return (
    <>
      {dark && <Notice tone="warn">Nobody is counting {floor.name} at the moment. The room is drawn below, but no table is shown as free.</Notice>}
      {!dark && unknown.length > 0 && <Notice>{plural(unknown.length, 'table')} here have no working sensor. They are never counted as free.</Notice>}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <section className="panel panel-3d student-view-panel" aria-label="Room view and table availability">
        <fieldset className="student-view-choice" data-testid="student-view-choice">
          <legend>Room view</legend>
          <div className="student-view-options">
            <label>
              <input type="radio" name="student-room-view" value="3d" data-testid="student-view-choice-3d"
                checked={viewMode === '3d'} disabled={!supports3d}
                aria-describedby={!supports3d ? unavailableHintId : undefined}
                onChange={() => onChooseView('3d')}
                onClick={() => { if (viewMode === '3d') persistRoomViewMode('3d'); }} />
              <span>3D view</span>
            </label>
            <label>
              <input type="radio" name="student-room-view" value="2d" data-testid="student-view-choice-2d"
                checked={viewMode === '2d'}
                onChange={() => onChooseView('2d')}
                onClick={() => { if (viewMode === '2d' && preferredView !== '2d') onChooseView('2d'); }} />
              <span>2D map</span>
            </label>
          </div>
          {!supports3d && <p id={unavailableHintId} className="student-view-unavailable">3D view is not available for this location.</p>}
        </fieldset>

        {viewMode === '3d' ? <>
          <div className="panel-head student-view-heading">
            <div className="panel-title">{info.source === 'generated' ? 'Built-in 3D room' : '3D map'}</div>
            <div className="panel-tools">
              <button type="button" data-testid="student-directions-toggle" className={`btn ${directions ? 'btn-primary' : 'btn-secondary'}`} onClick={onDirections}>
                {directions ? 'Hide directions' : 'Get directions'}
              </button>
              <button type="button" data-testid="student-model-zoom-to-table" className="btn btn-secondary" onClick={() => viewer()?.zoomToSeat?.()}>Zoom to table</button>
              <button type="button" data-testid="student-model-reset-view" className="btn btn-secondary" onClick={() => viewer()?.resetView?.()}>Reset view</button>
            </div>
          </div>
          <p className="caption text-muted student-view-caption">Drag to rotate, scroll or pinch to zoom. Green tables have room for {plural(seats, 'seat')}; grey are full and faint ones have no sensor data.</p>
        </> : <div className="panel-head student-view-heading">
          <div className="panel-title">Floor plan - top-down</div>
          <div className="legend">
            <span><i className="free" />Room for you</span><span><i className="picked" />Picked</span>
            <span><i className="full" />Full</span><span><i className="nodata" />No data</span>
          </div>
        </div>}

        <div className="viewport student-view-viewport" data-testid="student-room-view-viewport" role="region"
          aria-label={viewMode === '3d' ? '3D room view' : '2D floor map'}>
          {shouldMountViewer && <div className="student-3d-stage" data-testid="student-3d-renderer"
            hidden={viewMode !== '3d'} aria-hidden={viewMode !== '3d'} inert={viewMode !== '3d'}>
            <FloorViewer key={viewerKey}
              src={info.model?.src ?? null} source={info.source} room={info.model?.room ?? floor.name}
              columns={info.model?.columns ?? Math.max(1, floor.tables.length)} rows={info.model?.rows ?? 1}
              labels={ordered.map((item) => item.name)} free={list(fits)}
              occupied={list((item) => item.status !== 'unknown' && (item.free ?? 0) === 0)}
              dark={list((item) => item.status === 'unknown' || item.free === null)} selected={table ? index(table) : 0}
              directions={directions} onPick={(n) => { const picked = ordered[n - 1]; if (picked && fits(picked)) onTable(picked.id); }}
              floor={sceneFloor} selectedTableId={table} locationTransform={info.uploadedModel?.transform}
              retryRequest={retryRequest}
              onFailure={() => onViewerFailure(viewerKey)} onRecovered={() => onViewerRecovered(viewerKey)}
              onPickTable={(id) => { const picked = floor.tables.find((item) => item.id === id); if (picked && fits(picked)) onTable(id); }}
            />
          </div>}
          {viewMode === '2d' && <div className="student-2d-stage" data-testid="student-2d-renderer">
            <FloorMap floor={floor} selected={table} canSelect={fits} onTable={(id) => onTable(table === id ? null : id)} />
          </div>}
          {isFallback && <div className="student-view-fallback" role="status" aria-live="polite" data-testid="student-3d-fallback">
            <span>3D view unavailable. The floor map is shown instead.</span>
            <button type="button" data-testid="student-view-retry-3d" className="btn btn-secondary" onClick={onRetryViewer}>Retry 3D view</button>
          </div>}
        </div>

        <section className="plan-list" aria-labelledby="table-availability-heading">
          <h3 id="table-availability-heading" className="section-label">Tables by live availability</h3>
          {floor.tables.length === 0 && <p className="text-muted">No tables are mapped for this location yet.</p>}
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
      </section>
    </>
  );
}

function viewer(): (HTMLElement & { resetView?: () => void; zoomToSeat?: () => void }) | null {
  return document.querySelector('floor-viewer');
}
