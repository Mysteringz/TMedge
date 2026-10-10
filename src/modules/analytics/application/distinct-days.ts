/**
 * How many different students used the site on each day, without keeping a
 * list of who.
 *
 * "Active students this week" needs to know that Monday's visitor and
 * Thursday's are the same person, so something stable per student has to be
 * remembered for a month. What is remembered is a keyed hash, cut to 64 bits:
 * it cannot be turned back into an account without the web tier's own secret,
 * and no email or account ID is ever written by this class.
 */
import { createHmac } from 'node:crypto';
import { dayKey } from '../../../shared/analytics.js';
import type { BucketLog } from '../../../infrastructure/analytics/bucket-log.js';

const RETAINED_DAYS = 35;
/** One site cannot have this many students in a day; a flood of made-up identities stops here. */
const MAX_PER_DAY = 200_000;

interface PersistedDay { day: string; ids: string[] }

export class DistinctDays {
  private readonly days = new Map<string, Set<string>>();
  private today = '';
  private dirty = false;
  private lastSave = 0;

  constructor(
    private readonly name: string, private readonly log: BucketLog,
    private readonly timeZone: string, private readonly key: Buffer, now: number = Date.now(),
  ) {
    for (const line of log.load<PersistedDay>(`${name}-days`, now - (RETAINED_DAYS + 1) * 86_400_000)) this.restore(line.v);
    const open = log.takeState<PersistedDay>(`${name}-days`);
    this.today = dayKey(now, timeZone);
    if (open && !this.days.has(open.day)) {
      this.restore(open);
      // Stopped before midnight, started after: that day is over and was
      // never written out as finished, so do it now.
      const carried = this.days.get(open.day);
      if (open.day < this.today && carried && carried.size > 0) {
        log.append(`${name}-days`, 'month', { t: now, v: { day: open.day, ids: [...carried] } satisfies PersistedDay });
      }
    }
    this.drop(now);
  }

  private restore(value: PersistedDay | undefined): void {
    if (!value || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Array.isArray(value.ids)) return;
    this.days.set(value.day, new Set(value.ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)).slice(0, MAX_PER_DAY)));
  }

  /** Record that this account was seen now. `identity` is hashed here and goes no further. */
  mark(at: number, identity: string): void {
    this.roll(at);
    let set = this.days.get(this.today);
    if (!set) { set = new Set(); this.days.set(this.today, set); }
    if (set.size >= MAX_PER_DAY) return;
    const id = createHmac('sha256', this.key).update(identity).digest('hex').slice(0, 16);
    if (!set.has(id)) { set.add(id); this.dirty = true; }
  }

  tick(now: number): void {
    this.roll(now);
    if (this.dirty && now - this.lastSave >= 60_000) this.save(now);
  }

  private roll(now: number): void {
    const day = dayKey(now, this.timeZone);
    if (day === this.today) return;
    const finished = this.days.get(this.today);
    if (finished && finished.size > 0) {
      this.log.append(`${this.name}-days`, 'month', { t: now - 1, v: { day: this.today, ids: [...finished] } satisfies PersistedDay });
    }
    this.today = day;
    this.drop(now);
    this.save(now);
    this.log.prune(`${this.name}-days`, 'month', now - (RETAINED_DAYS + 31) * 86_400_000);
  }

  private drop(now: number): void {
    const oldest = dayKey(now - RETAINED_DAYS * 86_400_000, this.timeZone);
    for (const day of this.days.keys()) if (day < oldest) this.days.delete(day);
  }

  private save(now: number): void {
    const set = this.days.get(this.today);
    this.log.writeState(`${this.name}-days`, { day: this.today, ids: set ? [...set] : [] } satisfies PersistedDay);
    this.dirty = false;
    this.lastSave = now;
  }

  count(day: string): number {
    return this.days.get(day)?.size ?? 0;
  }

  /** Different students across the last `days` site-local days, today included. */
  across(days: number, now: number): number {
    const seen = new Set<string>();
    for (let i = 0; i < days; i++) for (const id of this.days.get(dayKey(now - i * 86_400_000, this.timeZone)) ?? []) seen.add(id);
    return seen.size;
  }

  perDay(days: number, now: number): { day: string; students: number }[] {
    const out: { day: string; students: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayKey(now - i * 86_400_000, this.timeZone);
      out.push({ day, students: this.count(day) });
    }
    return out;
  }

  /** The first day anything is retained for. */
  get earliestDay(): string | null {
    let out: string | null = null;
    for (const [day, set] of this.days) if (set.size > 0 && (out === null || day < out)) out = day;
    return out;
  }

  close(now: number = Date.now()): Promise<void> {
    this.save(now);
    return this.log.flush();
  }
}
