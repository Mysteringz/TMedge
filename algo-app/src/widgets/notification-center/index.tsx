import { useEffect, useRef } from 'react';
import { useNotifications } from '../../entities/operation-notification/index.tsx';
import './notifications.css';

export function NotificationToggle() {
  const feed = useNotifications(); if (!feed) return null;
  return <button id="notification-toggle" className="cx-notification-toggle" aria-expanded={feed.open} aria-controls="notification-center" onClick={feed.toggle}>Notifications <span aria-label={feed.unread === null ? 'Unread count unavailable' : `${feed.unread} unread`}>{feed.unread ?? '…'}</span></button>;
}
export function NotificationCenter() {
  const feed = useNotifications(), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (feed?.open) heading.current?.focus(); }, [feed?.open]);
  if (!feed?.open) return null;
  return <section id="notification-center" className="cx-notifications" aria-labelledby="notification-heading" onKeyDown={(event) => event.stopPropagation()}>
    <div className="cx-notification-actions"><h2 id="notification-heading" ref={heading} tabIndex={-1}>Notifications</h2><button className="btn btn-secondary" onClick={() => { feed.close(); document.getElementById('notification-toggle')?.focus(); }}>Close notifications</button></div>
    <p>Recent outcomes from the last 7 days. Firmware history may be limited to retained rollouts.</p>
    {feed.loading && <p role="status">Loading notifications…</p>}
    {feed.error && <p role="alert">{feed.error} <button className="btn btn-secondary" onClick={feed.retry}>Retry notifications</button></p>}
    {feed.unavailable && <p role="status">Some outcome sources are unavailable. Retained items may be out of date.</p>}
    {feed.updatedAt !== null && <p>Last updated {new Date(feed.updatedAt).toLocaleString()}</p>}
    {!feed.loading && !feed.error && !feed.unavailable && !feed.items.length && <p>No recent notifications.</p>}
    {!!feed.items.length && <><button className="btn btn-secondary" onClick={() => feed.markRead(feed.items.map((item) => item.id))}>Mark all as read</button><ul>{feed.items.map((item) => <li key={item.id}>
      <span className="tag tag-neutral">{feed.isRead(item.id) ? 'Read' : 'Unread'}</span> <span>{item.kind === 'training' ? 'Training' : 'Firmware'}</span><h3>{item.label}</h3><p>{item.outcome}</p>
      {item.occurredAt === null ? <p>Event time unavailable</p> : <time dateTime={new Date(item.occurredAt).toISOString()}>{new Date(item.occurredAt).toLocaleString()}</time>}
      <div className="cx-notification-actions"><a href={item.href}>View {item.kind === 'training' ? 'training job' : 'firmware updates'}</a><button className="btn btn-secondary" disabled={feed.isRead(item.id)} onClick={() => feed.markRead([item.id])}>Mark as read</button></div>
    </li>)}</ul></>}
    <p>{feed.storageFailed ? 'Read status cannot be saved in this browser.' : 'Read status is saved in this browser.'}</p>
  </section>;
}
