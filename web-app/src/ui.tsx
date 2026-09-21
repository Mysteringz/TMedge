/**
 * Shared pieces: the signed-in chrome, and the skeletons that hold a screen's
 * shape while its data is still arriving. A layout that jumps once the numbers
 * land is a layout people misclick.
 */
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Connection } from './data.ts';

export function Chrome({ crumb, live, who, children }: {
  crumb: string;
  live: { connection: Connection; updatedAt: number };
  who: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const clock = new Date(live.updatedAt || Date.now());
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  const state = live.connection === 'offline' ? 'offline' : live.connection === 'connecting' ? 'connecting' : 'live';
  return (
    <div className="app">
      <header className="topbar">
        <div className="left">
          {/* The mark is the way home, as everywhere else on the web. */}
          <Link className="brand" to="/dashboard/" aria-label="HKUMySeat dashboard">
            <span className="mark" aria-hidden="true" />
            <span className="name">HKUMySeat</span>
          </Link>
          <span className="bar" aria-hidden="true" />
          <span className="crumb text-muted">{crumb}</span>
        </div>
        <div className="right">
          <span className="livetag" data-state={state} role="status">
            <span className="pulse" aria-hidden="true" />
            {live.connection === 'offline' ? 'Reconnecting…' : live.connection === 'connecting' ? 'Connecting…' : `Live · ${hhmm}`}
          </span>
          <span className="who text-muted">{who}</span>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              void fetch('/logout', { method: 'POST', headers: { 'x-requested-with': 'fetch' } })
                .then(() => navigate('/login/', { replace: true }));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function Skeleton({ w, h, className = '' }: { w?: string; h?: string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** The dashboard's shape before the first snapshot lands. */
export function DashboardSkeleton() {
  return (
    <div className="master-detail">
      <div className="master">
        <div className="section-label">Location</div>
        {[0, 1, 2].map((i) => (
          <div className="space-row" key={i}>
            <Skeleton w="42%" h="11px" />
            <Skeleton w="76%" h="17px" />
            <Skeleton w="55%" h="12px" />
          </div>
        ))}
      </div>
      <div className="detail">
        <Skeleton className="photo" h="clamp(200px, 32vw, 320px)" />
        <Skeleton w="60%" h="13px" />
      </div>
    </div>
  );
}

export function SpacesSkeleton() {
  return (
    <div className="spaces">
      {[0, 1].map((i) => (
        <div className="space" key={i}>
          <div className="space-head">
            <Skeleton w="120px" h="19px" />
            <Skeleton w="64px" h="22px" />
          </div>
          <div className="space-body">
            <Skeleton w="100%" h="14px" />
            <Skeleton w="70%" h="14px" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ViewerSkeleton() {
  return (
    <div className="panel">
      <Skeleton className="viewport" h="clamp(280px, 48vw, 460px)" />
      <div className="plan">
        {Array.from({ length: 10 }, (_, i) => <Skeleton className="cell" h="96px" key={i} />)}
      </div>
    </div>
  );
}

export function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}
