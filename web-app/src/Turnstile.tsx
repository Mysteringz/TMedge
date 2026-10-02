/**
 * Cloudflare Turnstile, the "are you a person" check on sign-in and sign-up.
 *
 * The server decides whether it is on, by putting the public site key in the
 * shell's <meta name="turnstile">; empty means off (the LAN, the tests), and
 * then this draws nothing and the forms behave as before. The token it yields
 * is single-use, so a form that was refused calls reset() for a fresh one
 * rather than resending a token Cloudflare has already spent.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

export const turnstileSiteKey: string =
  document.querySelector<HTMLMetaElement>('meta[name="turnstile"]')?.content.trim() ?? '';

// {{turnstile}} left in place means the page came from the Vite dev server,
// not from the web tier: treat it as off.
export const turnstileOn = turnstileSiteKey !== '' && !turnstileSiteKey.startsWith('{{');

let loading: Promise<TurnstileApi> | null = null;
function loadApi(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => {
      loading = null;   // let a remount try again
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface TurnstileHandle { reset(): void }

interface Props {
  /** Must match the server's check for this form ('login' or 'signup'). */
  action: string;
  /** The token, or null when it expired, failed or was reset. */
  onToken(token: string | null): void;
}

export const Turnstile = forwardRef<TurnstileHandle, Props>(function Turnstile({ action, onToken }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  // The latest callback without re-rendering the widget whenever it changes.
  const cb = useRef(onToken);
  cb.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      cb.current(null);
      if (id.current && window.turnstile) window.turnstile.reset(id.current);
    },
  }), []);

  useEffect(() => {
    if (!turnstileOn) return;
    let gone = false;
    loadApi().then((api) => {
      if (gone || !box.current) return;
      id.current = api.render(box.current, {
        sitekey: turnstileSiteKey,
        action,
        theme: 'light',
        size: 'flexible',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      });
    }).catch(() => cb.current(null));
    return () => {
      gone = true;
      if (id.current && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [action]);

  if (!turnstileOn) return null;
  return <div className="turnstile" ref={box} />;
});
