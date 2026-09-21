/**
 * Available spaces, with the live view of whichever one is selected.
 *
 * No seat is assigned to anyone: every table with room is marked, and the
 * student picks when they get there. Choosing a table here only moves the
 * marker on the map, so you can look before you walk.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  allocate, capacityOf, isDark, knownFree, plural, spaceInfo, unknownTables,
  useLive, useMe, useSeats, useVenues, walkOrder, type CampusFloor,
} from '../data.ts';
import { Chrome, Notice, SpacesSkeleton, ViewerSkeleton } from '../ui.tsx';
import FloorViewer from '../FloorViewer.tsx';

export default function Spaces() {
  const { floorId } = useParams();
  const navigate = useNavigate();
  const { me } = useMe();
  const live = useLive();
  const venues = useVenues(live.view);
  const [seats] = useSeats();
  const [table, setTable] = useState<string | null>(null);
  const [directions, setDirections] = useState(false);

  const entry = useMemo(
    () => venues.find((v) => v.floors.some((f) => f.id === floorId)) ?? venues.find((v) => v.open) ?? null,
    [venues, floorId],
  );
  const floor = entry?.floors.find((f) => f.id === floorId) ?? entry?.floors[0] ?? null;

  useEffect(() => {
    document.title = `${entry?.venue.shortName ?? 'Spaces'} · HKUMySeat`;
  }, [entry]);
  // A different space means a different room: forget the table that was picked.
  useEffect(() => {
    setTable(null);
    setDirections(false);
  }, [floor?.id]);

  return (
    <Chrome crumb="Available spaces" live={live} who={me?.name ?? me?.email ?? ''}>
      <div className="screen">
        <Link className="btn btn-ghost" to={`/dashboard/?seats=${seats}`}>← Change search</Link>
        <div className="screen-head">
          <h1>{entry?.venue.name ?? 'Spaces'}</h1>
          <span className="note text-muted">{plural(seats, 'seat')} · {entry?.venue.name ?? ''}</span>
        </div>
        <hr className="hr" />

        {live.view === null ? <><SpacesSkeleton /><ViewerSkeleton /></> : !entry || entry.floors.length === 0 ? (
          <Notice>No sensed space in this venue is online right now.</Notice>
        ) : (
          <>
            <div className="section-label">Available</div>
            <div className="spaces">
              {entry.floors.map((f) => (
                <SpaceBlock
                  key={f.id}
                  floor={f}
                  seats={seats}
                  selected={f.id === floor?.id}
                  onOpen={() => navigate(`/dashboard/spaces/${encodeURIComponent(f.id)}?seats=${seats}`)}
                />
              ))}
            </div>

            {floor && (
              <LiveView
                floor={floor}
                seats={seats}
                table={table}
                onTable={setTable}
                directions={directions}
                onDirections={() => setDirections((d) => !d)}
              />
            )}
          </>
        )}
      </div>
    </Chrome>
  );
}

function SpaceBlock({ floor, seats, selected, onOpen }: {
  floor: CampusFloor; seats: number; selected: boolean; onOpen: () => void;
}) {
  const info = spaceInfo(floor.id);
  const dark = isDark(floor);
  const fit = dark ? null : allocate(floor, seats);
  const free = knownFree(floor);
  return (
    <button type="button" className="space" aria-pressed={selected} onClick={onOpen}>
      <span className="space-head">
        <span className="space-name">
          <span className="floor">{info.floorLabel || floor.building}</span>
          <span className="sname">{floor.name}</span>
        </span>
        <span className="count">
          <span className="n">{dark ? '—' : fit ? `${plural(seats, 'seat')} together` : 'No seats together'}</span>
          <span className="k">{dark ? 'no live data' : `${plural(free, 'free seat')}`}</span>
        </span>
      </span>
    </button>
  );
}

function LiveView({ floor, seats, table, onTable, directions, onDirections }: {
  floor: CampusFloor;
  seats: number;
  table: string | null;
  onTable: (id: string | null) => void;
  directions: boolean;
  onDirections: () => void;
}) {
  const info = spaceInfo(floor.id);
  const ordered = walkOrder(floor.tables);
  const dark = isDark(floor);
  const cap = capacityOf(floor);
  const free = knownFree(floor);
  const unknown = unknownTables(floor);
  const fits = (t: { free: number | null; status: string; capacity: number }) =>
    t.status !== 'unknown' && (t.free ?? 0) >= Math.min(seats, t.capacity);
  const index = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const list = (pick: (t: (typeof ordered)[number]) => boolean) =>
    ordered.map((t, i) => (pick(t) ? i + 1 : 0)).filter(Boolean).join(',');

  return (
    <>
      {dark && (
        <Notice tone="warn">
          Nobody is counting {floor.name} at the moment. The room is drawn below, but no table is shown as free.
        </Notice>
      )}
      {!dark && unknown.length > 0 && (
        <Notice>
          {plural(unknown.length, 'table')} here have no working sensor. They are never counted as free.
        </Notice>
      )}

      <div className="panel panel-3d">
        <div className="panel-title">3D map — drag to rotate, scroll or pinch to zoom</div>
        <div className="panel-tools">
          <button type="button" className={`btn ${directions ? 'btn-primary' : 'btn-secondary'}`} onClick={onDirections}>
            {directions ? 'Hide directions' : 'Get directions'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => viewer()?.zoomToSeat?.()}>Zoom to table</button>
          <button type="button" className="btn btn-secondary" onClick={() => viewer()?.resetView?.()}>Reset view</button>
        </div>
        <div className="viewport">
          {info.model ? (
            <FloorViewer
              src={info.model.src}
              room={info.model.room}
              columns={info.model.columns}
              rows={info.model.rows}
              labels={ordered.map((t) => t.name)}
              free={list(fits)}
              occupied={list((t) => t.status !== 'unknown' && (t.free ?? 0) === 0)}
              dark={list((t) => t.status === 'unknown' || t.free === null)}
              selected={table ? index(table) : 0}
              directions={directions}
              onPick={(n) => {
                const picked = ordered[n - 1];
                if (picked && fits(picked)) onTable(picked.id);
              }}
            />
          ) : (
            <div className="detail-empty text-muted">No 3D model for this space yet.</div>
          )}
        </div>
        <div className="caption text-muted">
          Green tables have room for {plural(seats, 'seat')}; grey are full and faint ones have no sensor data.
          Pick a table here or below to mark it on the map.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Floor plan — top-down</div>
          <div className="legend">
            <span><i className="free" />Room for you</span>
            <span><i className="picked" />Picked</span>
            <span><i className="full" />Full</span>
            <span><i className="nodata" />No data</span>
          </div>
        </div>
        <div className="plan" style={{ ['--plan-columns' as string]: String(info.model?.columns ?? 5) }}>
          {ordered.map((t) => {
            const unknownTable = t.status === 'unknown' || t.free === null;
            const roomy = fits(t);
            const cls = t.id === table ? 'cell cell-picked'
              : unknownTable ? 'cell cell-dark'
                : roomy ? 'cell cell-free' : 'cell cell-full';
            const meta = unknownTable ? 'No data'
              : t.free === 0 ? 'Full'
                : `${t.free} of ${t.capacity} free`;
            return (
              <button
                type="button"
                key={t.id}
                className={cls}
                aria-pressed={t.id === table}
                disabled={!roomy}
                onClick={() => onTable(t.id === table ? null : t.id)}
              >
                <span className="t">{t.name}</span>
                <span className="m">{meta}</span>
              </button>
            );
          })}
        </div>
        <div className="plan-foot">
          <span className="text-muted">↑ {info.entranceNote}</span>
          <span className="text-muted">
            {dark ? 'No live counts for this space' : `${free} of ${floor.totals.seats} seats free · ${cap} seats per table`}
          </span>
        </div>
      </div>
    </>
  );
}

function viewer(): (HTMLElement & { resetView?: () => void; zoomToSeat?: () => void }) | null {
  return document.querySelector('floor-viewer');
}
