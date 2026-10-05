import type { CampusView } from '../../src/shared/types.js';

/** A disconnected browser has no evidence that a formerly free seat is free. */
export function disconnectedView(view: CampusView): CampusView {
  return {
    ...view,
    floors: view.floors.map((floor) => ({
      ...floor,
      stale: true,
      tables: floor.tables.map((table) => ({
        ...table, occupied: null, free: null, status: 'unknown',
        seats: table.seats.map((seat) => ({ ...seat, occupied: null })),
      })),
      zones: floor.zones.map((zone) => ({ ...zone, people: null })),
      totals: { seats: floor.totals.seats, free: 0, occupied: 0, unknownSeats: floor.totals.seats, tablesFullyFree: 0 },
    })),
  };
}
