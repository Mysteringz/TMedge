export function HealthTime({ at, now, prefix = '' }: { at: number | null; now: number; prefix?: string }) {
  if (at === null || !Number.isFinite(at) || at < 0 || at > 8_640_000_000_000_000) return <span>{prefix}never observed</span>;
  const age = Math.max(0, Math.floor((now - at) / 1000));
  const relative = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{prefix}{relative}</time>;
}
