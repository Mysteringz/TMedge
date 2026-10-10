import type { CampusFloor, CampusView } from '../../../shared/types.js';
import type { StudentActivityDetails, StudentUsageAction, StudentUsageInput } from '../../../shared/student-activity.js';
import { searchSeats } from '../../../shared/seats.js';
import { VENUES } from '../../../shared/venues.js';
import { ApplicationError } from '../../shared/application/contracts.js';
import type { StudentActivityLog } from './student-activity-log.js';
import { isActivityIdentifier } from '../domain/student-activity-details.js';
import type { UsageEventSink } from '../../analytics/application/usage-meter.js';

/** Resolves campus context on the server; browser telemetry cannot choose its actor or result count. */
export class StudentUsageActivity {
  constructor(
    private readonly campus: () => CampusView, private readonly activity?: StudentActivityLog,
    /** Counts only (module 05 of the algo console); it is never given who did it. */
    private readonly usage?: UsageEventSink,
  ) {}

  record(userId: string | undefined, raw: unknown, requestId: string): void {
    const input = parseUsageInput(raw);
    const floors = this.campus().floors;
    let selected = floors;
    const details: StudentActivityDetails = { seats: input.seats };
    if (input.action === 'seat-search' && input.venueId) {
      const venue = VENUES.find((entry) => entry.id === input.venueId);
      if (!venue && input.venueId !== 'other') throw invalid();
      selected = venue ? floors.filter((floor) => venue.floorIds.includes(floor.id))
        : floors.filter((floor) => !VENUES.some((entry) => entry.floorIds.includes(floor.id)));
      details.venueId = input.venueId;
    } else if (input.floorId) {
      const floor = floors.find((entry) => entry.id === input.floorId);
      if (!floor) throw invalid();
      selected = [floor];
      details.floorId = floor.id;
    }
    if ('tableId' in input && input.tableId) {
      if (!selected[0]?.tables.some((table) => table.id === input.tableId)) throw invalid();
      details.tableId = input.tableId;
    }
    details.liveData = hasLiveData(selected);
    if (input.action === 'seat-search') details.resultCount = searchSeats(selected, input.seats).slice(0, 20).length;
    this.usage?.event(input.action, 'succeeded', details);
    if (userId) this.activity?.record(input.action, 'succeeded', userId, requestId, details);
  }

  /** Keep the legacy GET search response, logging only recognized identifiers. */
  recordApiSearch(userId: string | undefined, seats: number, floorId: string | undefined, resultCount: number, requestId: string): void {
    const floors = this.campus().floors.filter((floor) => floorId === undefined || floor.id === floorId);
    const recognized = floors.find((floor) => floor.id === floorId && isActivityIdentifier(floor.id));
    const details = { seats, resultCount, liveData: hasLiveData(floors), ...(recognized ? { floorId: recognized.id } : {}) };
    this.usage?.event('seat-search', 'succeeded', details);
    if (userId) this.activity?.record('seat-search', 'succeeded', userId, requestId, details);
  }
}

function hasLiveData(floors: readonly CampusFloor[]): boolean {
  return floors.some((floor) => !floor.stale && floor.tables.some((table) => table.status !== 'unknown' && table.free !== null));
}

function invalid(): ApplicationError { return new ApplicationError('validation', 'Invalid student activity.'); }

/** Exact action-specific schemas reject client identity and arbitrary payload properties. */
export function parseUsageInput(raw: unknown): StudentUsageInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const input = raw as Record<string, unknown>;
  const actions: readonly StudentUsageAction[] = ['seat-search', 'space-view', 'table-select', 'directions-view'];
  if (!actions.includes(input.action as StudentUsageAction) || !Number.isInteger(input.seats)
    || (input.seats as number) < 1 || (input.seats as number) > 30) throw invalid();
  const action = input.action as StudentUsageAction;
  const allowed = action === 'seat-search' ? ['action', 'seats', 'floorId', 'venueId']
    : action === 'space-view' ? ['action', 'seats', 'floorId'] : ['action', 'seats', 'floorId', 'tableId'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid();
  for (const key of ['floorId', 'venueId', 'tableId']) {
    if (key in input && !isActivityIdentifier(input[key])) throw invalid();
  }
  if (action === 'seat-search') {
    if (input.floorId && input.venueId) throw invalid();
  } else if (!input.floorId || (action === 'table-select' && !input.tableId)) throw invalid();
  // The discriminant, required keys and all scalar types have been checked above.
  return { ...input } as StudentUsageInput;
}
