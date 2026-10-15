import { useEffect, useId, useRef } from 'react';
import type { DraftSummary } from '../../../entities/location-config/model/types.ts';

/** Native modal traps focus, starts on Cancel and never removes a draft merely by opening. */
export function DraftRemovalDialog({ draft, busy, error, onCancel, onConfirm, onReload }: {
  draft: DraftSummary | null; busy: boolean; error: string;
  onCancel(): void; onConfirm(): void; onReload(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (draft && !element.open) { element.showModal(); cancel.current?.focus(); }
    else if (!draft && element.open) element.close();
  }, [draft?.draftId]);

  return <dialog ref={dialog} className="loc-remove-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    onClose={() => { if (draft && !busy) onCancel(); }}>
    <h2 id={titleId}>Remove draft?</h2>
    <p id={descriptionId}>Permanently remove <strong>{draft?.name}</strong>? This draft cannot be restored.</p>
    <p className="cx-muted">Published locations and history will remain.</p>
    {error && <p className="loc-alert" role="alert">{error}</p>}
    <div className="loc-remove-dialog-actions">
      <button ref={cancel} type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      {error && <button type="button" className="btn btn-secondary" disabled={busy} onClick={onReload}>Reload list</button>}
      <button type="button" className="btn btn-primary" disabled={busy || !!error} onClick={onConfirm}>{busy ? 'Removing…' : 'Remove draft'}</button>
    </div>
  </dialog>;
}
