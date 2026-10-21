/**
 * Find a seat: where, and for how many.
 *
 * Master-detail, so nothing moves when you choose a venue: the list stays on
 * the left and the photograph on the right changes. Before anything is
 * selected the panel shows the first venue's photograph, so the shape of the
 * screen is the same from the first frame.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recordStudentActivity } from '../activity.ts';
import { isDark, knownFree, plural, useLive, useMe, useSeats, useVenues, type VenueSpaces } from '../data.ts';
import { Chrome, DashboardSkeleton, FeedUnavailable, NoStudySpaces } from '../ui.tsx';

export default function Dashboard() {
  const navigate = useNavigate();
  const { me } = useMe();
  const live = useLive();
  const venues = useVenues(live.view);
  const [seats, setSeats] = useSeats();
  const [pickedId, setPicked] = useState<string | null>(null);

  const open = venues.filter((v) => v.open);
  // Nothing is selected to begin with, but the panel still has something to
  // show: the first venue that is actually publishing floors.
  const shown = venues.find((v) => v.venue.id === pickedId) ?? open[0] ?? venues[0] ?? null;
  const picked = venues.find((v) => v.venue.id === pickedId) ?? null;

  /**
   * Choosing a venue, or clearing the one already chosen: the box is a toggle,
   * so the same click that selects it takes the selection away. Clearing puts
   * the screen back to where it starts -- nothing pressed, the first open
   * venue's photograph still in the panel, Search waiting for a choice.
   */
  const pickVenue = (id: string) => setPicked((current) => (current === id ? null : id));

  useEffect(() => {
    document.title = 'Find a seat · HKUMySeat';
  }, []);

  const free = useMemo(
    () => (shown ? shown.floors.reduce((sum, f) => sum + (isDark(f) ? 0 : knownFree(f)), 0) : 0),
    [shown],
  );
  const allDark = !!shown && shown.floors.length > 0 && shown.floors.every(isDark);

  const search = () => {
    if (!picked) return;
    const first = picked.floors[0];
    if (first) {
      recordStudentActivity({ action: 'seat-search', seats, siteId: first.siteId, floorId: first.id });
      navigate(`/dashboard/spaces/${encodeURIComponent(first.siteId)}/${encodeURIComponent(first.id)}?seats=${seats}`);
    } else {
      recordStudentActivity({ action: 'seat-search', seats, venueId: picked.venue.id });
      navigate(`/dashboard/spaces/?seats=${seats}`);
    }
  };

  return (
    <Chrome crumb="Find a seat" live={live} who={me?.name ?? me?.email ?? ''}>
      <div className="screen">
        <div className="screen-head">
          <h1>Find a seat</h1>
        </div>
        <hr className="hr" />

        {live.view === null && live.feedState === 'loading' ? <DashboardSkeleton /> : live.view === null ? <FeedUnavailable retry={live.retryFeed} /> : live.view.floors.length === 0 ? <NoStudySpaces /> : (
          <div className="master-detail">
            <div className="master">
              <div className="section-label">Location</div>
              <div className="venues">
                {venues.map((v) => (
                  <VenueRow
                    key={v.venue.id}
                    entry={v}
                    selected={v.venue.id === pickedId}
                    onPick={() => pickVenue(v.venue.id)}
                  />
                ))}
              </div>

              <div className="section-label">Seats needed</div>
              <div className="seats-row">
                <div className="stepper">
                  <button type="button" data-testid="student-seat-count-decrement" aria-label="One fewer seat" onClick={() => setSeats(seats - 1)}>−</button>
                  <SeatsField seats={seats} onSeats={setSeats} />
                  <button type="button" data-testid="student-seat-count-increment" aria-label="One more seat" onClick={() => setSeats(seats + 1)}>+</button>
                </div>
                <button type="button" data-testid="student-location-search" className="btn btn-primary btn-cta" onClick={search} disabled={!picked}>
                  Search
                </button>
              </div>
            </div>

            <figure className="detail">
              {shown?.venue.photo
                ? <img src={shown.venue.photo} alt={shown.venue.name} />
                : <div className="detail-empty text-muted">No photograph for this venue yet.</div>}
              <figcaption className="text-muted">
                <span>{shown?.venue.caption ?? ''}</span>
                <span>{!shown ? '' : allDark ? 'Live data unavailable' : `${plural(free, 'seat')} free now`}</span>
              </figcaption>
            </figure>
          </div>
        )}
      </div>
    </Chrome>
  );
}

/**
 * The number is typed, not only stepped. It keeps its own draft so clearing
 * the field to type "12" does not snap back to 1 between the two keystrokes;
 * the search only ever sees a number in range.
 */
function SeatsField({ seats, onSeats }: { seats: number; onSeats: (n: number) => void }) {
  const [draft, setDraft] = useState(String(seats));
  useEffect(() => setDraft(String(seats)), [seats]);
  return (
    <input
      className="seats-input"
      type="number"
      min={1}
      max={16}
      inputMode="numeric"
      value={draft}
      data-testid="student-seat-count-input"
      aria-label="Seats needed"
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isInteger(n)) onSeats(n);
      }}
      onBlur={() => setDraft(String(seats))}
    />
  );
}

function VenueRow({ entry, selected, onPick }: { entry: VenueSpaces; selected: boolean; onPick: () => void }) {
  const { venue, floors, open } = entry;
  const tables = floors.reduce((n, f) => n + f.tables.length, 0);
  const meta = !open
    ? (venue.open ? 'Sensors offline' : 'Sensors coming soon')
    : `${plural(floors.length, 'public space')} · ${plural(tables, 'table')}`;
  return (
    <button
      type="button"
      data-testid={`student-location-card-${encodeURIComponent(entry.venue.id)}`}
      className="venue"
      aria-pressed={selected}
      disabled={!open}
      onClick={onPick}
    >
      {/* One face carries the whole box. The button itself is left to the
          browser, so a press and a focus ring behave the way they should. */}
      <span className="venue-face">
        <span className="kicker">{venue.kicker}</span>
        <span className="vname">{venue.name}</span>
        <span className="meta">{selected ? `Selected · ${meta}` : meta}</span>
      </span>
    </button>
  );
}
