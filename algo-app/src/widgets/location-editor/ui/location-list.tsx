import { useEffect, useState } from 'react';
import { createLocationDraft, listLocations, LocationApiError, startLocationEdit } from '../../../entities/location-config/api/index.ts';
import type { DraftSummary, LocationList } from '../../../entities/location-config/model/types.ts';
import { navigate } from '../../../console/router.ts';
import './location-editor.css';

/** Render the manager's published locations and creator-private drafts; use inside the capability-guarded LocationWizard route. */
export function LocationListPage() {
  const [data, setData] = useState<LocationList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [name, setName] = useState('');
  const [building, setBuilding] = useState('');
  const [width, setWidth] = useState('10');
  const [height, setHeight] = useState('8');
  const [revisionError, setRevisionError] = useState('');

  const refresh = async () => {
    setLoading(true); setError('');
    try { setData(await listLocations()); }
    catch (cause) { setError(cause instanceof LocationApiError && cause.status === 403 ? 'You no longer have permission to manage locations.' : 'Locations could not be loaded. Try again.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setRevisionError(''); setBusyId('create');
    const widthM = Number(width), heightM = Number(height);
    if (!name.trim() || !building.trim() || !Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM < 1 || heightM < 1 || widthM > 1000 || heightM > 1000) {
      setRevisionError('Enter a location name, building, and dimensions from 1 to 1000 metres.'); setBusyId(''); return;
    }
    try {
      const draft = await createLocationDraft({ name: name.trim(), building: building.trim(), widthCm: Math.round(widthM * 100), heightCm: Math.round(heightM * 100) });
      navigate(`/locations/${encodeURIComponent(draft.draftId)}/details`);
    } catch (cause) { setRevisionError(cause instanceof LocationApiError && cause.status === 409 ? 'This location changed. Reload the list and try again.' : 'The private draft could not be created. Your entries are still here.'); }
    finally { setBusyId(''); }
  };

  const edit = async (locationId: string, expectedPublishedRevision: number) => {
    setRevisionError(''); setBusyId(locationId);
    try {
      const draft = await startLocationEdit(locationId, expectedPublishedRevision);
      navigate(`/locations/${encodeURIComponent(draft.draftId)}/details`);
    } catch (cause) {
      setRevisionError(cause instanceof LocationApiError && cause.status === 409 ? 'The published location changed. Reload the list before editing.' : 'An edit draft could not be started.');
    } finally { setBusyId(''); }
  };

  const continueDraft = (draft: DraftSummary) => navigate(`/locations/${encodeURIComponent(draft.draftId)}/details`);
  return <main className="cx-train loc-page">
    <header className="cx-train-head">
      <div><p className="cx-kicker">Floor plans · private drafts</p><h1 className="cx-h2">Locations</h1><p className="cx-muted">Create or edit one location at a time. Changes stay private until you publish.</p></div>
      <button type="button" className="btn btn-primary" data-testid="location-create-toggle" onClick={() => { setCreating((value) => !value); setRevisionError(''); }}>{creating ? 'Cancel' : 'Add location'}</button>
    </header>

    {revisionError && <p className="loc-alert" role="alert">{revisionError}</p>}
    {creating && <form className="card loc-create-form" onSubmit={create} aria-label="Create a location draft">
      <h2>New private draft</h2>
      <Field label="Location name" testId="location-create-name" value={name} onChange={setName} />
      <Field label="Building" testId="location-create-building" value={building} onChange={setBuilding} />
      <div className="loc-form-grid">
        <Field label="Floor width (m)" testId="location-create-width" type="number" min={1} max={1000} step={0.01} value={width} onChange={setWidth} />
        <Field label="Floor height (m)" testId="location-create-height" type="number" min={1} max={1000} step={0.01} value={height} onChange={setHeight} />
      </div>
      <p className="cx-muted">New locations start public by server default. Visibility cannot be changed here.</p>
      <button type="submit" className="btn btn-primary" data-testid="location-create-submit" disabled={busyId === 'create'}>{busyId === 'create' ? 'Creating…' : 'Create draft'}</button>
    </form>}

    {loading ? <p className="loc-load" aria-busy="true" role="status">Loading locations…</p>
        : error ? <section className="card loc-empty" role="alert"><p>{error}</p><div className="loc-inline-actions"><button className="btn btn-secondary" type="button" data-testid="location-list-retry" onClick={() => void refresh()}>Retry</button>{error.includes('permission') && <button className="btn btn-ghost" type="button" data-testid="location-list-return" onClick={() => navigate('/')}>Return to workspace</button>}</div></section>
        : <>
          <section className="loc-list-section" aria-labelledby="loc-published-title">
            <div className="loc-section-heading"><h2 id="loc-published-title">Published locations</h2><span>{data?.published.length ?? 0}</span></div>
            {data?.published.length ? <ul className="loc-list" data-testid="location-published-list">
              {data.published.map((item) => <li className="card loc-list-card" key={item.locationId}>
                <div><h3>{item.name}</h3><p className="cx-muted">{item.building} · revision {item.activeRevision}</p></div>
                <div className="loc-list-actions"><span className="tag tag-neutral">{item.visibility === 'public' ? 'Student-visible · public' : 'Console-only · not shown to students'}</span>
                  <button className="btn btn-secondary" type="button" data-testid={`location-edit-${testToken(item.locationId)}`} disabled={busyId === item.locationId} onClick={() => void edit(item.locationId, item.activeRevision)}>{busyId === item.locationId ? 'Starting…' : 'Edit'}</button>
                </div>
              </li>)}
            </ul> : <div className="card loc-empty"><p>No locations yet.</p><button type="button" className="btn btn-secondary" data-testid="location-create-empty" onClick={() => setCreating(true)}>Add location</button></div>}
          </section>
          <section className="loc-list-section" aria-labelledby="loc-drafts-title">
            <div className="loc-section-heading"><h2 id="loc-drafts-title">Your drafts</h2><span>{data?.drafts.length ?? 0}</span></div>
            {data?.drafts.length ? <ul className="loc-list" data-testid="location-draft-list">
              {data.drafts.map((draft) => <li className="card loc-list-card" key={draft.draftId}>
                <div><h3>{draft.name}</h3><p className="cx-muted">{draft.building} · draft revision {draft.draftRevision} · {draft.basePublishedRevision === null ? 'new location' : `based on revision ${draft.basePublishedRevision}`}</p></div>
                <div className="loc-list-actions"><span className="tag tag-outline">Draft · private</span><span className="cx-muted">{draft.visibility === 'public' ? 'Public · student-visible' : 'Console-only · not shown to students'}</span>
                  <button className="btn btn-secondary" type="button" data-testid={`location-continue-${testToken(draft.draftId)}`} onClick={() => continueDraft(draft)}>Continue draft</button>
                </div>
              </li>)}
            </ul> : <div className="card loc-empty"><p>You have no private drafts.</p></div>}
          </section>
        </>}
  </main>;
}

/** Controlled create-draft field used by LocationListPage; metre conversion occurs in the page's submit handler. */
function Field({ label, value, onChange, testId, type = 'text', min, max, step }: {
  label: string; value: string; onChange(value: string): void; testId: string; type?: string; min?: number; max?: number; step?: number;
}) {
  const deferredNumber = type === 'number';
  return <label className="loc-field"><span>{label}</span><input className="input" data-testid={testId} value={value} type={deferredNumber ? 'text' : type}
    inputMode={deferredNumber ? 'decimal' : undefined} min={deferredNumber ? undefined : min} max={deferredNumber ? undefined : max} step={deferredNumber ? undefined : step}
    onChange={(event) => onChange(event.target.value)} /></label>;
}

function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
