import { useEffect, useState } from 'react';
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
/** Socket transport and observation age remain separate truths. */
export function useConnectionState(): {
  transport: TransportState; setTransport(value: TransportState): void; observedAt: number | null; received(): void; fresh: boolean; now: number;
} {
  const [transport, setTransport] = useState<TransportState>('connecting');
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return { transport, setTransport, observedAt, received: () => setObservedAt(Date.now()), now,
    fresh: observedAt !== null && now - observedAt < 15000 };
}
