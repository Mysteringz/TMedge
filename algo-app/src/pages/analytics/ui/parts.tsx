/** The Bluegrid pieces the Analytics views are assembled from. */
import type { CSSProperties, ReactNode } from 'react';
import type { DayHealth, Health, ServiceRow, Source } from '../../../entities/analytics/index.ts';
import { formatDay, Icons, Sparkline } from '../../../widgets/charts/index.ts';
import { percent, type Delta } from '../lib/format.ts';

/**
 * MetricTile: the number first, then how it changed against a named period,
 * then a quiet trend. With nothing to compare against it says what the
 * figure is instead; with no figure at all it shows a dash and why.
 */
export function MetricTile({ label, value, unit, delta, note, spark }: {
  label: string; value: string | null; unit?: string; delta?: Delta | null; note?: string; spark?: (number | null)[];
}) {
  return (
    <div className="an-metric">
      <div className="an-metric__label">{label}</div>
      <div className="an-metric__value">
        {value ?? <span className="an-metric__unknown" title="Not known">–</span>}
        {value !== null && unit && <span className="an-metric__unit">{unit}</span>}
      </div>
      {delta ? (
        <div className={`an-metric__delta ${delta.good === true ? 'an-metric__delta--good' : delta.good === false ? 'an-metric__delta--bad' : ''}`}>
          {delta.direction === 'up' ? <Icons.ArrowUp /> : delta.direction === 'down' ? <Icons.ArrowDown /> : null}
          <span><strong>{delta.text}</strong> {delta.versus}</span>
        </div>
      ) : <div className="an-metric__delta"><span>{note ?? ' '}</span></div>}
      {spark && <Sparkline values={spark} />}
    </div>
  );
}

export function Metrics({ label, children }: { label: string; children: ReactNode }) {
  return <div className="an-metrics" role="group" aria-label={label}>{children}</div>;
}

/** Carbon's inline notification: a coloured edge, an icon and a bold title, so status never rests on colour. */
export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warning' | 'error'; title: string; children?: ReactNode }) {
  const Icon = kind === 'error' ? Icons.ErrorFilled : kind === 'warning' ? Icons.WarningFilled : Icons.InformationFilled;
  return (
    <div className={`an-notice an-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={20} className="an-notice__icon" />
      <div className="an-notice__text"><span className="an-notice__title">{title}</span>{children}</div>
    </div>
  );
}

/**
 * Draws `children` only when the source has data. Otherwise it says which of
 * the two other things is true -- it could not be reached, or it is not set
 * up -- because both are different from "the answer is zero".
 */
export function Gate<T>({ source, name, unavailable, disabled, children }: {
  source: Source<T>; name: string; unavailable: string; disabled: string; children(data: T): ReactNode;
}) {
  if (source.state === 'available' && source.data !== null) return <>{children(source.data)}</>;
  return source.state === 'disabled'
    ? <Notice title={`${name} is not set up`}>{disabled}</Notice>
    : <Notice kind="warning" title={`${name} is unavailable`}>{unavailable}</Notice>;
}

const STATUS_ICON: Record<Health, (p: { size?: number }) => ReactNode> = {
  ok: Icons.CheckmarkFilled, warn: Icons.WarningFilled, err: Icons.ErrorFilled, off: Icons.RadioButton,
};

export function Status({ status, children }: { status: Health; children: ReactNode }) {
  const Icon = STATUS_ICON[status];
  return <span className={`an-status an-status--${status}`}><Icon />{children}</span>;
}

const DAY_WORD: Record<DayHealth, string> = { ok: 'Operational', warn: 'Degraded', err: 'Outage', none: 'No record' };

function Uptime({ days }: { days: ServiceRow['days'] }) {
  const tally = { ok: 0, warn: 0, err: 0, none: 0 };
  for (const day of days) tally[day.health] += 1;
  return (
    <span className="an-uptime" role="img"
      aria-label={`${days.length} days: ${tally.ok} operational, ${tally.warn} degraded, ${tally.err} with an outage, ${tally.none} with no record`}>
      {days.map((day) => <span key={day.day} className={day.health === 'ok' ? '' : `is-${day.health}`} title={`${formatDay(day.day, true)}: ${DAY_WORD[day.health]}`} />)}
    </span>
  );
}

/** ServiceHealth: status as an icon and a word, thirty days of daily record, and the share of that time it was up. */
export function ServiceHealth({ rows }: { rows: ServiceRow[] }) {
  // Worst first: what needs attention should not be below the fold.
  const order: Record<Health, number> = { err: 0, warn: 1, ok: 2, off: 3 };
  const sorted = [...rows].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="an-health" role="table" aria-label="Service health">
      <div className="an-health__head" role="row">
        <span role="columnheader">Service</span><span role="columnheader">Status</span>
        <span role="columnheader">Last 30 days</span><span role="columnheader" className="an-num">Uptime</span>
      </div>
      {sorted.map((row) => (
        <div className="an-health__row" role="row" key={row.id}>
          <span className="an-health__name" role="cell">{row.name}<small>{row.detail}</small></span>
          <span role="cell"><Status status={row.status}>{row.statusText}</Status></span>
          <span role="cell"><Uptime days={row.days} /></span>
          <span role="cell" className="an-num">{row.uptimePercent === null ? '–' : `${percent(row.uptimePercent, row.uptimePercent >= 99.95 || row.uptimePercent < 10 ? 0 : 2)}%`}</span>
        </div>
      ))}
      <div className="an-health__legend">
        <span><i style={{ background: 'var(--support-success)' }} />Operational</span>
        <span><i style={{ background: 'var(--support-warning)' }} />Degraded</span>
        <span><i style={{ background: 'var(--support-error)' }} />Outage</span>
        <span><i style={{ background: 'var(--border-subtle-01)' }} />No record</span>
        <span>Hover a day for its date</span>
      </div>
    </div>
  );
}

export interface MeterPart { key: string; label: string; value: number; text: string }

/**
 * Meter: how a total divides, on one 8px bar in the categorical colours taken
 * in order. The legend always carries the values, so nothing depends on
 * telling the colours apart.
 */
export function Meter({ title, total, totalText, parts, readout }: { title: string; total: number; totalText: string; parts: MeterPart[]; readout?: string }) {
  // Four named parts at most; the rest are one grey "Other".
  const named = parts.slice(0, 4);
  const rest = parts.slice(4).reduce((sum, part) => sum + part.value, 0);
  const shown = [...named.map((part, i) => ({ ...part, color: `var(--categorical-0${i + 1})` })),
    ...(rest > 0 ? [{ key: 'other', label: 'Other', value: rest, text: '', color: 'var(--gray-50)' }] : [])];
  const share = (value: number) => (total > 0 ? Math.min(100, value / total * 100) : 0);
  return (
    <div className="an-meter">
      <div className="an-meter__header"><span className="an-meter__title">{title}</span><span className="an-meter__total">{totalText}</span></div>
      <div className="an-meter__bar" role="img" aria-label={`${title}: ${shown.map((part) => `${part.label} ${part.text || `${percent(share(part.value))}%`}`).join(', ')}`}>
        {shown.map((part) => <span key={part.key} className="an-meter__seg" title={`${part.label}: ${part.text} (${percent(share(part.value), 1)}%)`}
          style={{ '--c': part.color, width: `${share(part.value)}%` } as CSSProperties} />)}
      </div>
      <ul className="an-meter__legend">
        {shown.map((part) => <li key={part.key} className="an-meter__key"><span className="an-meter__swatch" style={{ '--c': part.color } as CSSProperties} />{part.label} {part.text && <strong>{part.text}</strong>}</li>)}
      </ul>
      {readout && <div className="an-meter__readout">{readout}</div>}
    </div>
  );
}

/** A plain two-column list of facts: label, then value. */
export function Facts({ rows }: { rows: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="an-facts">
      {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd className={row.mono ? 'cx-mono' : ''}>{row.value}</dd></div>)}
    </dl>
  );
}

export function Panel({ title, sub, children, className = '' }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`an-panel ${className}`}>
      <div className="an-panel__head"><h3 className="an-chart__title">{title}</h3>{sub && <p className="an-chart__sub">{sub}</p>}</div>
      {children}
    </section>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="an-section"><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}
