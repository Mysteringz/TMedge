/** Explicit student interactions; telemetry never includes identity or credentials. */
export type StudentUsageAction = 'seat-search' | 'space-view' | 'table-select' | 'directions-view';

export type StudentUsageInput =
  | { action: 'seat-search'; seats: number; venueId?: string; siteId?: string; floorId?: string }
  | { action: 'space-view'; seats: number; siteId?: string; floorId: string }
  | { action: 'table-select'; seats: number; siteId?: string; floorId: string; tableId: string }
  | { action: 'directions-view'; seats: number; siteId?: string; floorId: string; tableId?: string };

/** Bounded server-derived context. These are campus/map IDs, not physical presence. */
export interface StudentActivityDetails {
  seats?: number;
  floorId?: string;
  siteId?: string;
  venueId?: string;
  tableId?: string;
  resultCount?: number;
  liveData?: boolean;
}
