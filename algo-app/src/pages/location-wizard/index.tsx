import { useCapability } from '../../entities/admin-session/index.tsx';
import { navigate, usePath } from '../../console/router.ts';
import { LocationListPage, LocationEditor } from '../../widgets/location-editor/index.ts';

/** Route-level composition for `/locations` and `/locations/:draftId/:step`; mount it from the algo-app router. */
export function LocationWizard() {
  const canManage = useCapability('locations.manage');
  const path = usePath();
  if (!canManage) return <main className="cx-train" role="alert"><h1>Location access unavailable</h1><button type="button" className="btn btn-secondary" data-testid="location-wizard-return-workspace" onClick={() => navigate('/')}>Return to workspace</button></main>;
  if (path === '/locations' || path === '/locations/') return <LocationListPage />;
  const parts = path.split('/').filter(Boolean);
  let draftId = '';
  try { draftId = decodeURIComponent(parts[1] ?? ''); } catch { draftId = ''; }
  if (parts[0] !== 'locations' || !draftId) return <LocationListPage />;
  const step = ['details', 'sensors', 'model', 'review'].includes(parts[2] ?? '') ? parts[2] as 'details' | 'sensors' | 'model' | 'review' : 'details';
  return <LocationEditor key={draftId} draftId={draftId} step={step} onStep={(next) => navigate(`/locations/${encodeURIComponent(draftId)}/${next}`)} />;
}
