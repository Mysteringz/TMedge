/** Explicit student interactions; telemetry never includes identity or credentials. */
export type StudentUsageAction = 'seat-search' | 'space-view' | 'table-select' | 'directions-view';

export type StudentUsageInput =
  | { action: 'seat-search'; seats: number; venueId?: string; floorId?: string }
  | { action: 'space-view'; seats: number; floorId: string }
  | { action: 'table-select'; seats: number; floorId: string; tableId: string }
  | { action: 'directions-view'; seats: number; floorId: string; tableId?: string };

/** Bounded server-derived context. These are campus/map IDs, not physical presence. */
export interface StudentActivityDetails {
  seats?: number;
  floorId?: string;
  venueId?: string;
  tableId?: string;
  resultCount?: number;
  liveData?: boolean;
}
