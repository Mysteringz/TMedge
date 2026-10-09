import { useEffect, useRef } from 'react';
import { useNotifications } from '../../entities/operation-notification/index.tsx';
import { KINDS, type NotificationItem } from '../../entities/operation-notification/model.ts';
import './notifications.css';

const CATEGORIES = { sensor: { label: 'Sensors', href: '/console' }, training: { label: 'My training', href: '/train' }, firmware: { label: 'Firmware', href: '/updates' }, parameter: { label: 'Parameter reversions', href: '/flow' } };
export function NotificationToggle() {
  const feed = useNotifications(); if (!feed) return null;
  return <button id="notification-toggle" className="cx-notification-toggle" aria-label={feed.unread === null ? 'Notifications, unread count unavailable' : `Notifications, ${feed.unread} unread`} aria-expanded={feed.open} aria-controls="notification-center" onClick={feed.toggle}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>
    {feed.unread !== null && feed.unread > 0 && <span className="cx-notification-badge" aria-hidden="true">{feed.unread}</span>}
  </button>;
}
export function NotificationCenter() {
  const feed = useNotifications(), heading = useRef<HTMLHeadingElement>(null), panel = useRef<HTMLElement>(null);
  const close = useRef(feed?.close); close.current = feed?.close;
  useEffect(() => {
    if (!feed?.open) return;
    heading.current?.focus();
    const outside = (event: PointerEvent) => { const target = event.target; if (target instanceof Node && !panel.current?.contains(target) && !document.getElementById('notification-toggle')?.contains(target)) close.current?.(); };
    const iframe = () => { setTimeout(() => { if (document.activeElement instanceof HTMLIFrameElement) close.current?.(); }, 0); };
    document.addEventListener('pointerdown', outside); window.addEventListener('blur', iframe);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', iframe); };
  }, [feed?.open]);
  if (!feed?.open) return null;
  const returnFocus = () => { feed.close(); document.getElementById('notification-toggle')?.focus(); };
  const concerns = feed.items.filter((item) => item.classification === 'active'), outcomes = feed.items.filter((item) => item.classification !== 'active');
  const renderItem = (item: NotificationItem) => <li key={item.id}>
    <span className="tag tag-neutral">{feed.isRead(item.id) ? 'Read' : 'Unread'}</span> <span>{CATEGORIES[item.kind].label}</span><h3>{item.label}</h3><p>{item.outcome}</p>
    {(feed.error || feed.sources[item.kind] === 'unavailable') && <p className="cx-muted">Last known - source unavailable</p>}
    {item.detail && <p>{item.detail}</p>}
    {item.occurredAt === null ? <p>Time unavailable</p> : <time dateTime={new Date(item.occurredAt).toISOString()}>{new Date(item.occurredAt).toLocaleString()}</time>}
    {item.deadlineAt != null && <p>Reversion deadline {new Date(item.deadlineAt).toLocaleString()}</p>}
    <div className="cx-notification-actions"><a href={item.href}>View {CATEGORIES[item.kind].label.toLowerCase()}</a><button className="btn btn-secondary" disabled={feed.isRead(item.id)} onClick={() => feed.markRead([item.id])}>Mark as read</button></div>
  </li>;
  const clear = !feed.loading && !feed.error && !feed.unavailable;
  return <section ref={panel} id="notification-center" className="cx-notifications" aria-labelledby="notification-heading" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); returnFocus(); } }}>
    <div className="cx-notification-actions"><h2 id="notification-heading" ref={heading} tabIndex={-1}>Notifications</h2><button className="btn btn-secondary" onClick={returnFocus}>Close notifications</button></div>
    {feed.loading && <p role="status">Loading notifications...</p>}
    {(feed.error || feed.unavailable) && <p role="alert">{feed.error || 'Some sources are unavailable.'} <button className="btn btn-secondary" onClick={feed.retry}>Retry notifications</button></p>}
    <dl className="cx-source-summaries">{KINDS.filter((kind) => feed.sources[kind] !== 'forbidden').map((kind) => { const state = feed.sources[kind], summary = feed.summaries?.[kind]; return <div key={kind}><dt><a href={CATEGORIES[kind].href}>{CATEGORIES[kind].label}</a></dt><dd>{feed.error || state === 'unavailable' ? 'Status unavailable' : state === 'disabled' ? 'Source disabled' : summary?.status ?? (state === 'available' ? 'Status available' : 'Loading...')}{summary?.stale && <span> - Stale</span>}{summary?.observedAt != null && <small>Observed {new Date(summary.observedAt).toLocaleString()}</small>}</dd></div>; })}</dl>
    {feed.updatedAt !== null && <p>Last updated {new Date(feed.updatedAt).toLocaleString()}</p>}
    {clear && !feed.items.length && Object.values(feed.sources).every((state) => state === 'available' || state === 'forbidden') && <p>No alerts.</p>}
    {!!feed.items.length && <button className="btn btn-secondary" onClick={() => feed.markRead(feed.items.map((item) => item.id))}>Mark all as read</button>}
    <div className="cx-notification-list"><h3>Current concerns</h3>{concerns.length ? <ul>{concerns.map(renderItem)}</ul> : clear && <p>No current concerns.</p>}<h3>Recent outcomes</h3>{outcomes.length ? <ul>{outcomes.map(renderItem)}</ul> : clear && <p>No recent outcomes.</p>}</div>
    {!!feed.omittedCount && <p>{feed.omittedCount} additional items omitted.</p>}
    <p>Recent outcomes cover 7 days. Current concerns remain while active. Firmware history may be limited.</p><p>{feed.storageFailed ? 'Read status cannot be saved in this browser.' : 'Read status is saved in this browser.'}</p>
  </section>;
}
