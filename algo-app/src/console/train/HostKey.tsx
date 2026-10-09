/**
 * "Trust this host key?" -- asked once, on the very first connection to the
 * cluster, the way ssh asks; nothing is pinned and nobody logs in until the
 * person answers. A key that differs from a pinned one is never asked about:
 * it is refused.
 */
import { useEffect, useRef } from 'react';
import { XMark } from '../icons.tsx';

export interface HostKeyProps {
  host: string;
  keys: { type: string; fingerprint: string }[];
  onAnswer(accept: boolean): void;
}

export function HostKeyPrompt({ host, keys, onAnswer }: HostKeyProps) {
  const no = useRef<HTMLButtonElement>(null);
  const answer = useRef(onAnswer);
  answer.current = onAnswer;
  useEffect(() => {
    no.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') answer.current(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="cx-modal-back" role="presentation">
      <div className="card cx-modal" role="alertdialog" aria-modal="true" aria-labelledby="hk-title">
        <div className="cx-card-head">
          <span id="hk-title" className="cx-kicker" style={{ margin: 0 }}>First connection</span>
          <button type="button" className="btn btn-ghost cx-icon" onClick={() => onAnswer(false)} aria-label="Do not trust"><XMark /></button>
        </div>
        <p className="cx-modal-lede">Your tunnel is up. <b>{host}</b> has never been connected to from here, and presents:</p>
        <table className="table cx-fp">
          <tbody>
            {keys.map((k) => <tr key={k.fingerprint}><td className="cx-dim2">{k.type}</td><td className="cx-mono">{k.fingerprint}</td></tr>)}
          </tbody>
        </table>
        <p className="cx-hint cx-modal-note">
          Check one against a machine that already logs in there: <code>ssh-keygen -lF {host}</code> shows the fingerprint it trusts.
          If they match, trust it: it is pinned, and any other key is refused from then on. If they do not, someone may be in
          between -- do not trust it. Nothing logs in until you answer.
        </p>
        <div className="cx-modal-actions">
          <button ref={no} type="button" className="btn btn-secondary cx-btn-px" onClick={() => onAnswer(false)}>Do not trust</button>
          <button type="button" className="btn btn-primary cx-btn-px" onClick={() => onAnswer(true)}>Trust and continue</button>
        </div>
      </div>
    </div>
  );
}
