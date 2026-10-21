import { useEffect, useId, useRef } from 'react';
import type { Table } from '../../../entities/location-config/model/types.ts';

/** Confirm a private layout change, starting focus on Cancel; no save or publication happens here. */
export function TableRemovalDialog({ table, onCancel, onConfirm }: {
  table: Pick<Table, 'id' | 'name' | 'seats'> | null; onCancel(): void; onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (table && !element.open) { element.showModal(); cancel.current?.focus(); }
    else if (!table && element.open) element.close();
  }, [table?.id]);
  return <dialog ref={dialog} className="loc-remove-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id={titleId}>Remove table?</h2>
    <div id={descriptionId}>
      <p>Remove <strong>{table?.name}</strong> and its {table?.seats.length ?? 0} seats from this draft?</p>
      <p>Sensor ownership for this table will also be cleared. Sensors and other tables will remain.</p>
      <p className="cx-muted">Save the draft to keep this change. The published location is unchanged until you publish.</p>
    </div>
    <div className="loc-remove-dialog-actions">
      <button ref={cancel} type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={onConfirm}>Remove table</button>
    </div>
  </dialog>;
}
