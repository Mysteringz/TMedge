import type { FurnitureAssignment, FurnitureLibraryItem, FurnitureType, LocationDocument } from '../../../entities/location-config/index.ts';
import { effectiveFurniture } from '../model/assignments.ts';

export function FurnitureReviewSummary({ document, items, source }: {
  document: LocationDocument; items: ReadonlyMap<string, FurnitureLibraryItem>; source: 'generated' | 'custom' | 'other';
}) {
  const overrideEntries = document.tables.flatMap((table) => (['table', 'chair'] as const)
    .flatMap((slot) => table.furnitureOverrides?.[slot] ? [{ table, slot, assignment: table.furnitureOverrides[slot]! }] : []));
  const hasAssignments = !!(document.furnitureDefaults?.table || document.furnitureDefaults?.chair || overrideEntries.length);
  const customOverlay = source === 'custom' && document.tables.some((table) => !!effectiveFurniture(document.furnitureDefaults, table.furnitureOverrides, 'table')
    || !!effectiveFurniture(document.furnitureDefaults, table.furnitureOverrides, 'chair') && table.seats.length > 0);
  return <section className="card loc-furniture-review" aria-labelledby="loc-furniture-review-title" data-testid="location-furniture-review">
    <h3 id="loc-furniture-review-title">Furniture assignments</h3>
    <ul>
      <li>Room table default: {document.furnitureDefaults?.table ? assignmentSummary(document.furnitureDefaults.table, 'table', items) : 'none'}</li>
      <li>Room chair default: {document.furnitureDefaults?.chair ? assignmentSummary(document.furnitureDefaults.chair, 'chair', items) : 'none'}</li>
    </ul>
    <p>{overrideEntries.length} table override{overrideEntries.length === 1 ? '' : 's'} replace complete room defaults.</p>
    {overrideEntries.length > 0 && <ul>{overrideEntries.map(({ table, slot, assignment }) => <li key={`${table.id}:${slot}`}>
      {table.name} · {slot === 'table' ? 'table model' : 'chair model for all seats'} · {assignmentSummary(assignment, slot, items)}
    </li>)}</ul>}
    {customOverlay && <p className="loc-furniture-warning" role="note">Custom room GLBs should omit table and chair geometry when furniture overlays are assigned. Check the scene for duplicates; this is informational and does not block publishing.</p>}
    {!hasAssignments && <p>{source === 'generated' ? 'No shared furniture models are assigned. Built-in rooms use their normal primitive fallbacks.'
      : source === 'custom' ? 'No shared furniture models are assigned. The custom room remains as authored.'
        : 'No shared furniture models are assigned.'}</p>}
  </section>;
}

function assignmentSummary(value: FurnitureAssignment, slot: FurnitureType, items: ReadonlyMap<string, FurnitureLibraryItem>): string {
  const typeName = slot === 'table' ? 'Table model' : 'Chair model';
  const name = items.get(value.assetId)?.displayName;
  return `${name ? `${name} · ${typeName}` : `Assigned shared ${slot} model`} · scale ${value.scale}× · yaw ${value.yawDeg}° · elevation ${value.elevationM} m`;
}
