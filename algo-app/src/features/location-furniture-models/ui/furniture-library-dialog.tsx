import { useEffect, useRef, useState, type FormEvent } from 'react';
import { listFurnitureLibrary, uploadFurnitureLibraryItem } from '../../../entities/location-config/api/index.ts';
import type { FurnitureLibraryItem, FurnitureType } from '../../../entities/location-config/model/types.ts';

type LibraryFilter = 'all' | FurnitureType;

export function FurnitureLibraryDialog({ open, expectedType, busy, catalogItems, catalogLoaded, onClose, onSelect, onItemsChange }: {
  open: boolean; expectedType: FurnitureType; busy: boolean; catalogItems: FurnitureLibraryItem[]; catalogLoaded: boolean; onClose(): void;
  onSelect(item: FurnitureLibraryItem): Promise<void>; onItemsChange(items: FurnitureLibraryItem[]): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<FurnitureLibraryItem[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>(expectedType);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [uploadType, setUploadType] = useState<FurnitureType>(expectedType);
  const [displayName, setDisplayName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [status, setStatus] = useState('');
  const [selectError, setSelectError] = useState('');
  const catalogSnapshot = catalogLoaded ? catalogItems : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter(expectedType); setUploadType(expectedType); setQuery('');
    setListError(''); setUploadError(''); setSelectError(''); setStatus('');
  }, [open, expectedType]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 128) { setListError('Search text must be 128 characters or fewer.'); return () => { active = false; }; }
    if (catalogSnapshot) {
      const normalized = normalizedQuery.toLocaleLowerCase('en-US');
      setLoading(false); setListError('');
      setItems(catalogSnapshot.filter((item) => (filter === 'all' || item.type === filter)
        && (!normalized || item.displayName.toLocaleLowerCase('en-US').includes(normalized))));
      return () => { active = false; };
    }
    setLoading(true); setListError('');
    void listFurnitureLibrary({ ...(filter === 'all' ? {} : { type: filter }), ...(normalizedQuery ? { q: normalizedQuery } : {}) })
      .then((response) => {
        if (!active) return;
        setItems(response.items); onItemsChange(response.items);
      })
      .catch(() => { if (active) setListError('The shared furniture library could not be loaded. Retry to check again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, filter, query, refresh, catalogSnapshot, onItemsChange]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = displayName.trim();
    if (!name) { setUploadError('Enter a display name.'); return; }
    if (!file) { setUploadError('Choose a GLB file.'); return; }
    if (!file.name.toLowerCase().endsWith('.glb')) { setUploadError('Choose a file with the .glb extension.'); return; }
    if (!file.size || file.size > 128 * 1024 * 1024) { setUploadError('Choose a non-empty GLB no larger than 128 MiB.'); return; }
    setUploading(true); setUploadError(''); setStatus('Uploading model to the shared furniture library…');
    try {
      const filename = name.toLowerCase().endsWith('.glb') ? name : `${name}.glb`;
      const namedFile = new File([file], filename, { type: file.type || 'model/gltf-binary', lastModified: file.lastModified });
      const item = await uploadFurnitureLibraryItem(uploadType, namedFile);
      const next = [item, ...items.filter((candidate) => candidate.assetId !== item.assetId)];
      setItems(next); onItemsChange(next); setFilter('all'); setQuery('');
      setStatus(`${item.displayName} uploaded to the shared library. It has not been assigned.`);
      setFile(null); setDisplayName('');
      const input = form.querySelector<HTMLInputElement>('input[type="file"]');
      if (input) input.value = '';
    } catch {
      setUploadError('The model could not be uploaded. The file and form values are retained; check the name and GLB, then retry.');
      setStatus('');
    } finally { setUploading(false); }
  };

  const close = () => { if (!busy && !uploading) onClose(); };
  return <dialog ref={dialog} className="loc-furniture-dialog" aria-labelledby="loc-furniture-dialog-title" data-testid="location-furniture-library-dialog"
    onCancel={(event) => { event.preventDefault(); close(); }} onClose={onClose}>
    <div className="loc-furniture-dialog-content">
      <header className="loc-furniture-dialog-heading"><div><p className="cx-kicker">Shared private library</p><h2 id="loc-furniture-dialog-title">Furniture models</h2>
        <p>Choose a compatible model for this {expectedType} slot, or upload a model for later use.</p></div>
        <button type="button" className="btn btn-ghost" aria-label="Close furniture library" disabled={busy || uploading} onClick={close}>Close</button>
      </header>

      <section className="loc-furniture-library" aria-labelledby="loc-furniture-library-title">
        <h3 id="loc-furniture-library-title">Browse library</h3>
        <div className="loc-furniture-library-filters">
          <label className="loc-field"><span>Filter by type</span><select className="input" aria-label="Filter furniture by type" value={filter} onChange={(event) => setFilter(event.target.value as LibraryFilter)}>
            <option value="all">All furniture</option><option value="table">Table</option><option value="chair">Chair</option>
          </select></label>
          <label className="loc-field"><span>Search models</span><input className="input" type="search" maxLength={128} aria-label="Search furniture library" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Retry library</button>
        </div>
        {listError && <p role="alert" className="loc-alert">{listError}</p>}
        {loading && <p role="status" aria-live="polite">Loading shared furniture models…</p>}
        {!loading && !listError && !items.length && <p className="cx-muted">No models match this filter yet. Upload a GLB below to add one to the shared library.</p>}
        <div className="loc-furniture-results" role="region" aria-label="Shared furniture model results" tabIndex={0} data-testid="location-furniture-results">
          <ul>{items.map((item) => <li key={item.assetId}>
            <div><b>{item.displayName}</b><small>{item.type === 'table' ? 'Table model' : 'Chair model'}</small></div>
            <button type="button" className="btn btn-secondary" disabled={busy || uploading || item.type !== expectedType}
              aria-label={`${item.type === expectedType ? 'Use' : 'Wrong type for this slot'} ${item.displayName}`}
              onClick={() => { setSelectError(''); void onSelect(item).catch(() => setSelectError('This model could not be checked for preview. The current assignment is unchanged; retry or choose another model.')); }}>
              {item.type === expectedType ? 'Use model' : 'Wrong type'}
            </button>
          </li>)}</ul>
        </div>
        {selectError && <p role="alert" className="loc-alert">{selectError}</p>}
      </section>

      <form className="loc-furniture-upload" onSubmit={(event) => void upload(event)} aria-labelledby="loc-furniture-upload-title">
        <h3 id="loc-furniture-upload-title">Upload a shared model</h3>
        <label className="loc-field"><span>Display name</span><input className="input" aria-label="Furniture display name" value={displayName} maxLength={128} disabled={uploading} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="loc-field"><span>Furniture type</span><select className="input" aria-label="Furniture upload type" value={uploadType} disabled={uploading} onChange={(event) => setUploadType(event.target.value as FurnitureType)}>
          <option value="table">Table</option><option value="chair">Chair</option>
        </select></label>
        <label className="loc-upload"><span>Self-contained GLB (up to 128 MiB)</span><input type="file" accept=".glb,model/gltf-binary" aria-label="Upload shared furniture GLB" disabled={uploading}
          onChange={(event) => { const selected = event.currentTarget.files?.[0] ?? null; setFile(selected); setUploadError(''); if (selected && !displayName.trim()) setDisplayName(selected.name.replace(/\.glb$/i, '')); }} /></label>
        <div className="loc-inline-actions"><button type="submit" className="btn btn-primary" disabled={uploading || busy}>{uploading ? 'Uploading…' : 'Upload model'}</button></div>
        {uploadError && <p role="alert" className="loc-alert">{uploadError}</p>}
        {status && <p role="status" aria-live="polite">{status}</p>}
      </form>
    </div>
  </dialog>;
}
