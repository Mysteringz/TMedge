/**
 * Module 05: how HKUMySeat is being used and how the machine behind it is
 * doing. Reads only. Laid out as Bluegrid's console: a title, one filter row
 * that scopes everything under it, then summary before trend before detail.
 */
import { useEffect, useState } from 'react';
import { RANGES, useAnalytics, type RangeId } from '../../entities/analytics/index.ts';
import { navigate, usePath } from '../../console/router.ts';
import { Icons } from '../../widgets/charts/index.ts';
import { ago, dateTime, RANGE_LABEL } from './lib/format.ts';
import { Notice } from './ui/parts.tsx';
import { Overview } from './ui/overview.tsx';
import { Server } from './ui/server.tsx';
import { Usage } from './ui/usage.tsx';
import './analytics.css';

const VIEWS = [
  { id: 'overview', label: 'Overview', path: '/analytics' },
  { id: 'usage', label: 'HKUMySeat usage', path: '/analytics/usage' },
  { id: 'server', label: 'Server and back end', path: '/analytics/server' },
] as const;
type ViewId = typeof VIEWS[number]['id'];

const isRange = (value: unknown): value is RangeId => RANGES.some((id) => id === value);

function rememberedRange(): RangeId {
  const fromUrl = new URLSearchParams(location.search).get('range');
  if (isRange(fromUrl)) return fromUrl;
  // A convenience only: the page works the same where storage is blocked.
  try { const stored = localStorage.getItem('analytics.range'); if (isRange(stored)) return stored; } catch { /* private window */ }
  return '24h';
}

export function Analytics() {
  const path = usePath();
  const view: ViewId = path.startsWith('/analytics/usage') ? 'usage' : path.startsWith('/analytics/server') ? 'server' : 'overview';
  const [range, setRange] = useState<RangeId>(rememberedRange);
  const { snapshot, loading, error, pending, now, refresh } = useAnalytics(range);

  // The range lives in the address so a link opens the same picture.
  useEffect(() => {
    const url = `${location.pathname}?range=${range}`;
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
    try { localStorage.setItem('analytics.range', range); } catch { /* private window */ }
  }, [range, path]);

  const go = (target: typeof VIEWS[number]) => navigate(`${target.path}?range=${range}`);
  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % VIEWS.length : event.key === 'ArrowLeft' ? (index + VIEWS.length - 1) % VIEWS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : -1;
    const target = VIEWS[next];
    if (!target) return;
    event.preventDefault();
    go(target);
    document.getElementById(`an-tab-${target.id}`)?.focus();
  };
  // History that begins inside the range: say so once, above the charts it explains.
  const short = snapshot && snapshot.collectingSince !== null && snapshot.collectingSince > snapshot.range.from + 60_000;

  return (
    <main className="cx-train an">
      <header className="cx-train-head">
        <div>
          <div className="cx-kicker">Module 05 · Usage and infrastructure</div>
          <h1 className="cx-h2">Analytics</h1>
        </div>
        <div className="an-head-tools">
          <span role="status" aria-live="polite">{snapshot ? `Updated ${ago(snapshot.generatedAt, now)}` : loading ? 'Loading…' : 'No data yet'}</span>
          <button type="button" className="btn btn-ghost cx-btn-px" onClick={refresh} disabled={loading}><span>Refresh</span><Icons.Renew /></button>
        </div>
      </header>

      <div className="an-filters">
        <div className="an-tabs" role="tablist" aria-label="Analytics views">
          {VIEWS.map((item, index) => (
            <button key={item.id} id={`an-tab-${item.id}`} type="button" role="tab" className="an-tab" aria-selected={view === item.id} aria-controls="an-view"
              tabIndex={view === item.id ? 0 : -1} onClick={() => go(item)} onKeyDown={(event) => onTabKey(event, index)}>{item.label}</button>
          ))}
        </div>
        <div className="seg an-range" role="radiogroup" aria-label="Time range">
          {RANGES.map((id) => (
            <label key={id} className="seg-opt">
              <input type="radio" name="analytics-range" value={id} checked={range === id} onChange={() => setRange(id)} />{RANGE_LABEL[id]}
            </label>
          ))}
        </div>
      </div>

      {error && <Notice kind="warning" title="Not up to date">{error}</Notice>}
      {short && (
        <Notice title="History starts part-way through this range">
          This edge began keeping history on {dateTime(snapshot.collectingSince ?? 0)}. Before that the charts are empty because nothing was being recorded, not because nothing happened.
        </Notice>
      )}

      <div id="an-view" role="tabpanel" aria-labelledby={`an-tab-${view}`} className="an-view">
        {!snapshot ? <p className="cx-hint" aria-busy={loading}>{loading ? 'Loading analytics…' : 'Analytics could not be loaded.'}</p>
          : view === 'usage' ? <Usage snapshot={snapshot} range={snapshot.range.id} loading={pending} now={now} />
            : view === 'server' ? <Server snapshot={snapshot} range={snapshot.range.id} loading={pending} now={now} />
              : <Overview snapshot={snapshot} range={snapshot.range.id} loading={pending} now={now} />}
      </div>
    </main>
  );
}
