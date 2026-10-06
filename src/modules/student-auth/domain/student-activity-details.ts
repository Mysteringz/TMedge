import type { StudentActivityDetails } from '../../../shared/student-activity.js';

export function isActivityIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
}

/** Copy only bounded context; extra properties and mutable caller objects never enter the queue. */
export function sanitizeStudentActivityDetails(details: StudentActivityDetails): StudentActivityDetails {
  const safe: StudentActivityDetails = {};
  if (typeof details.seats === 'number' && Number.isInteger(details.seats) && details.seats >= 1 && details.seats <= 30) safe.seats = details.seats;
  if (isActivityIdentifier(details.floorId)) safe.floorId = details.floorId;
  if (isActivityIdentifier(details.venueId)) safe.venueId = details.venueId;
  if (isActivityIdentifier(details.tableId)) safe.tableId = details.tableId;
  if (typeof details.resultCount === 'number' && Number.isInteger(details.resultCount) && details.resultCount >= 0 && details.resultCount <= 20) safe.resultCount = details.resultCount;
  if (typeof details.liveData === 'boolean') safe.liveData = details.liveData;
  return safe;
}
