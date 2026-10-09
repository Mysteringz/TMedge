import type { ReactNode } from 'react';
import type { HealthSource } from '../../../entities/operational-health/index.ts';

export function HealthSection<T>({ title, source, href, link, refresh, children }: {
  title: string; source: HealthSource<T> | undefined; href: string; link: string; refresh(): void; children(data: T): ReactNode;
}) {
  return <section className="cx-health-card" aria-label={title}>
    <h3>{title}</h3>
    {!source ? <p>Loading {title.toLowerCase()}…</p> : source.state !== 'available' || source.data === null
      ? <p>{title} source {source.state}. {source.state === 'unavailable' && <button className="btn btn-ghost" onClick={refresh}>Retry {title.toLowerCase()}</button>}</p>
      : children(source.data)}
    <a href={href}>{link}</a>
  </section>;
}
