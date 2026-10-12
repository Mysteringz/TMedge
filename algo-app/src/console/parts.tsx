/** Pieces every console screen shares: the brand, the top bar, the toast. */

import { useAdminSession } from '../entities/admin-session/index.tsx';

import { useCallback, useEffect, useRef, useState, useId, type ReactNode } from 'react';

import { navigate, screenOf, usePath } from './router.ts';

import { Gear, Menu, SignOut, UserCircle, XMark } from './icons.tsx';

import { usePresence } from './motion.tsx';



// `group`: modules that belong together share one dropdown in the header,
// under that name. Each keeps its own number, page and card on the landing
// page; only the header is shorter for it.
export const MODULES = [

  { n: '01', title: 'Algorithm flow', path: '/flow', desc: 'Compose and pipe algorithms into the seat-allocation pipeline.' },

  { n: '02', title: 'ML job', path: '/train', group: 'ML', desc: 'Write a training script, run it on collected data, batch-test and export the model.' },
  { n: '02', title: 'ML data', path: '/ml-data', group: 'ML', desc: 'Query the training database, explore its SchemaSpy documentation and download selected tables as a ZIP.' },
  { n: '03', title: 'Debug console', path: '/console', desc: 'Live thermal frames, floor fusion, node health and commands.' },
  { n: '04', title: 'Updates', path: '/updates', group: 'Devices', desc: 'Upload firmware source, build an image, and roll it out to nodes one pilot at a time.' },
  { n: '05', title: 'Analytics', path: '/analytics', desc: 'How HKUMySeat is used, and how the server behind it is doing: students, seats, processor, memory and storage.' },
  { n: '06', title: 'Adoption', path: '/adoption', group: 'Devices', desc: 'Commission physical sensors, approve matching requests and verify authenticated reports.' },
  { n: '07', title: 'TMflash', path: '/flash', group: 'Devices', desc: 'Flash a sensor from this browser over USB, set it up and admit it — no app to install.' },
] as const;

type ConsoleModule = typeof MODULES[number];
const groupOf = (module: ConsoleModule): string | null => 'group' in module ? module.group : null;



/** A square of the accent with the letter in it: the console's only logo. */

export function BrandMark({ size = 24 }: { size?: number }) {

  return <span className="cx-mark" style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">a</span>;

}



export function Wordmark() {

  return <span className="cx-word"><b>algo</b>.hkumyseat</span>;

}



/** Carbon's UI shell header: the name, the modules, the person. */

export function Nav({ user, onSignOut, notificationToggle, notificationPanel }: { user: string; onSignOut(): void; notificationToggle?: ReactNode; notificationPanel?: ReactNode }) {

  const session = useAdminSession();

  const path = usePath();

  const screen = screenOf(path);

  const here = MODULES.find((m) => screenOf(m.path) === screen);
  const canManageAccounts = Boolean(session?.namedAccount && session.capabilities.includes('accounts.manage'));

  return (

    <header className="cx-header" aria-label="algo.hkumyseat">

      <button className="cx-home" onClick={() => navigate('/')} aria-label="Home">

        <BrandMark size={20} />

        <Wordmark />

      </button>

      <MobileNavigation path={path} canManageAccounts={canManageAccounts} />

      <nav className="cx-header-nav" aria-label="Modules">

        {MODULES.map((m, index) => {
          const group = groupOf(m);
          // A group's dropdown stands where its first module would.
          if (group) return MODULES.findIndex((other) => groupOf(other) === group) === index ? <GroupMenu key={group} label={group} screen={screen} /> : null;
          return <a key={m.path} className="cx-header-item" href={m.path} aria-current={here === m ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); navigate(m.path); }}>{m.title}</a>;
        })}

        {canManageAccounts && <a className="cx-header-item" href="/accounts" aria-current={screen === 'accounts' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); navigate('/accounts'); }}>Accounts</a>}
      </nav>

      {(here || screen === 'accounts' || screen === 'account') && <span className="cx-crumb">{here?.title ?? (screen === 'account' ? 'Account settings' : 'Accounts')}</span>}

      <div className="cx-identity-actions">
        {notificationToggle}
        <AccountMenu user={user} path={path} onSignOut={onSignOut} />
        {notificationPanel}
      </div>

    </header>

  );

}

/** Who is signed in, their settings and the way out, behind one icon. */
function AccountMenu({ user, path, onSignOut }: { user: string; path: string; onSignOut(): void }) {
  const session = useAdminSession();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    // The debug console is a document of its own: a click in it never reaches this one.
    const blur = () => { if (document.activeElement instanceof HTMLIFrameElement) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); };
  }, [open]);
  const role = session?.namedAccount ? session.role.charAt(0).toUpperCase() + session.role.slice(1) : 'Local operator';
  const panel = usePresence(open);
  return <div className="cx-account" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); toggle.current?.focus(); } }}>
    <button ref={toggle} className="cx-header-action cx-account-toggle" aria-label="Account" title={`${user}@team`}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <UserCircle /><span className="cx-online" aria-hidden="true" />
    </button>
    {panel && <div id={id} className="cx-account-panel" role="group" aria-label="Account" data-state={panel} inert={panel === 'leaving'}>
      <p className="cx-account-who"><b>{user}@team</b><span className="tag tag-neutral">{role}</span></p>
      <a href="/account" aria-current={screenOf(path) === 'account' ? 'page' : undefined}
        onClick={event => { event.preventDefault(); setOpen(false); navigate('/account'); }}><Gear />Account settings</a>
      <button onClick={() => { setOpen(false); onSignOut(); }}><SignOut />Sign out</button>
    </div>}
  </div>;
}

function MobileNavigation({ path, canManageAccounts }: { path: string; canManageAccounts: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const screen = screenOf(path);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const desktop = window.matchMedia('(min-width: 1057px)');
    const resize = () => { if (desktop.matches) setOpen(false); };
    // Pointer events inside the debug console's own document do not bubble
    // here; its focus change still dismisses the overlaid navigation.
    const blur = () => { if (document.activeElement instanceof HTMLIFrameElement) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    desktop.addEventListener('change', resize);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); desktop.removeEventListener('change', resize); window.removeEventListener('blur', blur); };
  }, [open]);
  const links = [
    { title: 'Home', path: '/', n: '' },
    ...MODULES,
    ...(canManageAccounts ? [{ title: 'Accounts', path: '/accounts', n: '' }] : []),
  ];
  const menu = usePresence(open);
  return <div className="cx-mobile-nav" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); toggle.current?.focus(); } }}>
    <button ref={toggle} className="cx-header-action cx-nav-toggle" aria-label="Navigation menu" title="Navigation menu"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      {open ? <XMark /> : <Menu />}
    </button>
    {menu && <nav id={id} className="cx-mobile-dropdown" aria-label="Mobile navigation" data-state={menu} inert={menu === 'leaving'}>
      {links.map(link => <a key={link.path} href={link.path} aria-current={screenOf(link.path) === screen ? 'page' : undefined}
        onClick={event => { event.preventDefault(); setOpen(false); navigate(link.path); }}>
        <span className="cx-mobile-nav-number" aria-hidden="true">{link.n}</span>{link.title}
      </a>)}
    </nav>}
  </div>;
}



/** A short message bottom-left that clears itself. */

export function useToast(): [string, (msg: string) => void] {

  const [toast, setToast] = useState('');

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {

    if (timer.current) clearTimeout(timer.current);

    setToast(msg);

    timer.current = setTimeout(() => setToast(''), 2800);

  }, []);

  return [toast, flash];

}



export function Toast({ text }: { text: string }) {

  const state = usePresence(!!text);

  // What it said is gone by the time it leaves; it leaves saying it.
  const said = useRef(text);

  if (text) said.current = text;

  if (!state) return null;

  return <div className="cx-toast" role="status" data-state={state}><span className="cx-sq" />{said.current}</div>;

}

/** One header item for a group of modules. There are two: ML (job, data) and Devices (Updates, Adoption, TMflash). */
function GroupMenu({ label, screen }: { label: string; screen: string }) {
  const members = MODULES.filter((m) => groupOf(m) === label);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const active = members.some((m) => screenOf(m.path) === screen);
  const menu = usePresence(open);
  return <div className="cx-group-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } }}>
    <button ref={toggle} className="cx-header-item" aria-expanded={open} aria-controls={id} aria-current={active ? 'page' : undefined}
      onClick={() => setOpen(!open)}>{label} <span className="cx-chevron" aria-hidden="true">▾</span></button>
    {menu && <div id={id} className="cx-group-dropdown" data-state={menu} inert={menu === 'leaving'}>
      {members.map(m => <a key={m.path} href={m.path} aria-current={screenOf(m.path) === screen ? 'page' : undefined}
        onClick={event => { event.preventDefault(); setOpen(false); navigate(m.path); }}>{m.title}</a>)}
    </div>}
  </div>;
}
