import { useEffect, useId, useRef } from 'react';
import type { PublishedSummary } from '../../../entities/location-config/model/types.ts';

/** Confirm the named live location; Cancel receives initial focus and Escape never removes. */
export function LocationRemovalDialog({ location, busy, error, onCancel, onConfirm, onReload }: {
  location: PublishedSummary | null; busy: boolean; error: string;
  onCancel(): void; onConfirm(): void; onReload(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (location && !element.open) { element.showModal(); cancel.current?.focus(); }
    else if (!location && element.open) element.close();
  }, [location?.locationId]);
  return <dialog ref={dialog} className="loc-remove-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} onClose={() => { if (location && !busy) onCancel(); }}>
    <h2 id={titleId}>Remove location?</h2>
    <div id={descriptionId}>
      <p>Remove <strong>{location?.name}</strong> from published locations and the user web?</p>
      <p>Its sensors will be unassigned and available for other locations.</p>
      <p>History and private drafts will remain. Retained drafts cannot republish this location. There is no restore action.</p>
    </div>
    {error && <p className="loc-alert" role="alert">{error}</p>}
    <div className="loc-remove-dialog-actions">
      <button ref={cancel} type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      {error && <button type="button" className="btn btn-secondary" disabled={busy} onClick={onReload}>Reload list</button>}
      <button type="button" className="btn btn-primary" disabled={busy || !!error} onClick={onConfirm}>{busy ? 'Removing…' : 'Remove location'}</button>
    </div>
  </dialog>;
}
