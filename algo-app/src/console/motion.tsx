/**
 * The motion a stylesheet cannot do alone; motion.css has the rest.
 *
 * Two things need script. Something that closes has to stay on the page for
 * as long as it takes to leave, and React removes it at once. And the mark on
 * a chosen option (the fill of a content switcher, the line of a tab) can
 * only travel to the next option if something tells it where that option is.
 */
import { Children, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';

/** The longest exit in motion.css. Nothing may take longer to leave than this, or it is cut short. */
const EXIT_MS = 150;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export type PresenceState = 'open' | 'leaving' | null;

/**
 * Whether to render something that opens and closes: 'open', then 'leaving'
 * for one exit, then null. Whatever is rendered while leaving must be inert:
 * it is on its way out and must not take a click, a key or the focus.
 *
 * Someone who asked for less motion gets no exit at all: closed is gone.
 */
export function usePresence(open: boolean): PresenceState {
  const [lingering, setLingering] = useState(open);
  useEffect(() => {
    if (open) { setLingering(true); return; }
    const timer = setTimeout(() => setLingering(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);
  if (open) return 'open';
  return lingering && !still() ? 'leaving' : null;
}

/**
 * Keeps its children on the page for one exit after their parent stopped
 * rendering them. What leaves is the last thing that was shown: its props are
 * gone with the state that closed it, so it is not rendered again, only kept.
 * It adds no box of its own.
 *
 * Not for module 02's sign-in or host-key dialogs: one holds a credential that
 * must be gone the moment it is used, the other answers Escape from the
 * window, and neither may outlive its own closing, even by an exit.
 */
export function Presence({ children }: { children: ReactNode }) {
  const shown = Children.toArray(children).length > 0;
  const last = useRef<ReactNode>(null);
  // Counted so something reopened while the last one is still leaving starts fresh, with none of its state.
  const opened = useRef(0), was = useRef(false);
  if (shown && !was.current) opened.current++;
  was.current = shown;
  if (shown) last.current = children;
  const state = usePresence(shown);
  if (!state) return null;
  return <div key={opened.current} className="cx-presence" data-state={state} inert={state === 'leaving'}>{shown ? children : last.current}</div>;
}

/**
 * Measures the chosen option of a row (matched by `chosen`) into
 * --glide-x/y/w/h on the row, where motion.css draws one mark that moves
 * between options instead of a mark on each. A row that was never measured
 * keeps the static mark it always had.
 */
export function useGlide<T extends HTMLElement>(chosen: string): RefObject<T | null> {
  const row = useRef<T>(null);
  const placed = useRef('');
  const place = useRef(() => {
    const el = row.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>(chosen);
    // Nothing chosen, or not laid out (a pane that is hidden): there is nowhere to put it.
    if (!on || el.offsetParent === null) { delete el.dataset.glide; placed.current = ''; return; }
    const box = [on.offsetLeft, on.offsetTop, on.offsetWidth, on.offsetHeight];
    // Most renders move nothing (module 01 renders with every frame): leave the styles alone then.
    if (box.join() === placed.current) return;
    placed.current = box.join();
    (['x', 'y', 'w', 'h'] as const).forEach((name, index) => el.style.setProperty(`--glide-${name}`, `${box[index]}px`));
    if (el.dataset.glide) return;
    // Put in place first and animated only from the next frame: otherwise it
    // would fly in from the corner every time the row appears.
    el.dataset.glide = 'placed';
    requestAnimationFrame(() => { if (el.dataset.glide) el.dataset.glide = 'live'; });
  });
  // After every render: which option is chosen, and how wide its label is, are the parent's to change.
  useLayoutEffect(() => { place.current(); });
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const watch = new ResizeObserver(() => place.current());
    watch.observe(el);
    // The web font arrives after the first measure and changes every width.
    void document.fonts?.ready.then(() => place.current());
    return () => watch.disconnect();
  }, []);
  return row;
}

/** Bluegrid's content switcher (.seg), whose fill travels to the option that was chosen. */
export function Switcher({ className, ...rest }: ComponentProps<'div'>) {
  const row = useGlide<HTMLDivElement>('.seg-opt:has(input:checked)');
  return <div {...rest} ref={row} className={className ? `seg ${className}` : 'seg'} />;
}

/** A row of tabs, whose line travels to the tab that was chosen. */
export function TabList(props: ComponentProps<'div'>) {
  const row = useGlide<HTMLDivElement>('[aria-selected="true"]');
  return <div role="tablist" {...props} ref={row} />;
}
