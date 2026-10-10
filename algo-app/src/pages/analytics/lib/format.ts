/** How the Analytics page words numbers, periods and ages. */
import type { RangeId, SeriesFrame } from '../../../entities/analytics/index.ts';

export const RANGE_LABEL: Record<RangeId, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
export const RANGE_PHRASE: Record<RangeId, string> = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
export const PREVIOUS_PHRASE: Record<RangeId, string> = { '1h': 'vs previous hour', '24h': 'vs previous 24 hours', '7d': 'vs previous 7 days', '30d': 'vs previous 30 days' };

const number = (value: number, digits: number) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function count(value: number): string {
  return value.toLocaleString();
}

/** Binary multiples under their everyday names, as `df -h` and every ops dashboard print them. */
export function bytes(value: number): { value: string; unit: string } {
  const abs = Math.abs(value);
  if (abs >= 1024 ** 4) return { value: number(value / 1024 ** 4, 2), unit: 'TB' };
  if (abs >= 1024 ** 3) return { value: number(value / 1024 ** 3, abs >= 100 * 1024 ** 3 ? 0 : 1), unit: 'GB' };
  if (abs >= 1024 ** 2) return { value: number(value / 1024 ** 2, abs >= 100 * 1024 ** 2 ? 0 : 1), unit: 'MB' };
  if (abs >= 1024) return { value: number(value / 1024, 0), unit: 'kB' };
  return { value: number(value, 0), unit: 'B' };
}
export function bytesText(value: number): string {
  const b = bytes(value);
  return `${b.value} ${b.unit}`;
}

export function percent(value: number, digits = 0): string {
  return number(value, digits);
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor(s % 86_400 / 3600)} h`;
}

export function ago(at: number | null, now: number): string {
  if (at === null) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5 ? 'just now' : `${duration(s)} ago`;
}

/** "Asia/Hong_Kong" as people say it: "Hong Kong time". */
export function zoneName(timeZone: string): string {
  return `${(timeZone.split('/').pop() ?? timeZone).replaceAll('_', ' ')} time`;
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export interface Delta { text: string; direction: 'up' | 'down' | 'flat'; good: boolean | null; versus: string }

/**
 * The signed change against the period before. Whether it is good depends on
 * the measure, not the arrow: fewer failed sign-ins is a fall and is good.
 * Null when there is no earlier period to compare with -- a tile then says
 * so, rather than showing "+100%" against nothing.
 */
export function delta(current: number, previous: number | null | undefined, versus: string, goodWhen: 'up' | 'down' | 'neither', unit: 'percent' | 'count' | 'points' = 'percent'): Delta | null {
  if (previous === null || previous === undefined) return null;
  const change = current - previous;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const magnitude = Math.abs(change);
  const text = direction === 'flat' ? 'No change'
    : unit === 'points' ? `${sign}${number(magnitude, 1)} pt`
      : unit === 'count' || previous === 0 ? `${sign}${count(magnitude)}`
        : `${sign}${number(magnitude / previous * 100, magnitude / previous < 0.1 ? 1 : 0)}%`;
  return { text, direction, versus, good: direction === 'flat' || goodWhen === 'neither' ? null : direction === goodWhen };
}

/** A frame's values in another unit (bytes as megabytes, say), gaps kept as gaps. */
export function scaled(frame: SeriesFrame, divisor: number): SeriesFrame {
  return { ...frame, series: frame.series.map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : v / divisor)) })) };
}

/** A series thinned to about `points` values for a sparkline; shape is all it has to keep. */
export function thin(values: (number | null)[] | undefined, points = 40): (number | null)[] {
  if (!values || values.length <= points) return values ?? [];
  const every = Math.ceil(values.length / points);
  const out: (number | null)[] = [];
  for (let i = values.length - 1; i >= 0; i -= every) out.unshift(values[i] ?? null);
  return out;
}

export function latest(values: (number | null)[] | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) { const v = values[i]; if (v !== null && v !== undefined) return v; }
  return null;
}

const GROUP_NAMES: Record<string, string> = {
  pages: 'Pages', 'sign-in': 'Sign-in and sign-up', occupancy: 'Occupancy reads', search: 'Seat search', activity: 'Usage reports', assets: 'Scripts, styles and images', other: 'Anything else',
};
export function routeGroupName(group: string): string {
  return GROUP_NAMES[group] ?? group;
}
