/** Axis arithmetic and number formatting shared by every chart. */
import { useEffect, useState, type RefObject } from 'react';

/**
 * A value axis from zero: a round step, the first multiple of it at or above
 * `max`, and the ticks between. Three to five intervals, so labels never
 * crowd. Counts get whole-number steps only -- nobody searched 12.5 times.
 */
export function axis(max: number, integer = false): { top: number; ticks: number[] } {
  const peak = max > 0 && Number.isFinite(max) ? max : 1;
  const raw = peak / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const lead = raw / power;
  const ladder = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = (ladder.find((s) => lead <= s + 1e-9) ?? 10) * power;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.max(step, Math.ceil(peak / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { top, ticks };
}

/** A fixed axis (a percentage): quarters of the top. */
export function fixedAxis(top: number): { top: number; ticks: number[] } {
  return { top, ticks: [0, 0.25, 0.5, 0.75, 1].map((share) => top * share) };
}

/** Axis ticks: short, and never more digits than the step needs. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  return trim(value);
}

function trim(value: number): string {
  const abs = Math.abs(value);
  return String(Number(value.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)));
}

/** A value with its unit: "42%" and "6.0/s" closed up, "120 ms" and "3 MB" spaced. */
export function withUnit(text: string, unit: string): string {
  return !unit ? text : /^[%/]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** The rendered width of an element, kept current. Charts draw in real pixels so text is never stretched. */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 600): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (w: number) => { if (w > 0) setWidth((current) => (Math.abs(current - w) > 1 ? Math.round(w) : current)); };
    apply(element.clientWidth);
    if (!('ResizeObserver' in window)) return;
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSeconds = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dateClock = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdayDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** A tick under the axis: a clock time within a day, a date beyond it. */
export function tickLabel(at: number, spanMs: number): string {
  return spanMs > 36 * 3_600_000 ? date.format(at) : clock.format(at);
}

/** The moment a tooltip or table row is about, as precisely as its step. */
export function pointLabel(at: number, stepMs: number, spanMs: number): string {
  if (stepMs >= 86_400_000) return weekdayDate.format(at);
  if (spanMs > 20 * 3_600_000) return dateClock.format(at);
  return stepMs < 60_000 ? clockSeconds.format(at) : clock.format(at);
}

/** Runs of consecutive indices that hold a value: a line is drawn through each and broken between them. */
export function runs(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) { if (current.length) out.push(current); current = []; } else current.push(index);
  });
  if (current.length) out.push(current);
  return out;
}
