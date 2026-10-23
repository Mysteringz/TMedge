/**
 * What the landing page's terminal searches: everything on the site that has
 * a name, as one flat list, matched in the browser.
 *
 * The site is searched first. What reads as a question, or matches nothing
 * here, goes to Ask AI instead (entities/assistant).
 */
import type { WorkspaceSnapshot } from '../model/types.ts';
import { REQUEST_STATUS_LABEL, TASK_STATUS_LABEL, teamRoleText } from '../model/types.ts';

export type SearchKind = 'module' | 'page' | 'action' | 'person' | 'request' | 'task' | 'message' | 'sensor';

/** What choosing an entry does. Navigation leaves the page; the rest open something in the workspace. */
export type SearchTarget =
  | { type: 'navigate'; path: string }
  | { type: 'compose'; to: string[] }
  | { type: 'mailbox' }
  | { type: 'message'; id: string }
  | { type: 'request'; id: string }
  | { type: 'task'; id: string }
  | { type: 'new-request' }
  | { type: 'new-task' };

export interface SearchEntry {
  id: string;
  kind: SearchKind;
  title: string;
  /** One line under the title. */
  detail: string;
  /** Shown at the right: a path or an id. Also searched. */
  hint: string;
  /** Other words this should be found by; never shown. */
  keywords: string;
  target: SearchTarget;
}

export const KIND_LABEL: Record<SearchKind, string> = {
  module: 'Module', page: 'Page', action: 'Action', person: 'Person', request: 'Request', task: 'Task', message: 'Message', sensor: 'Sensor',
};
/** Places before things, and things you act on before things you read. */
const KIND_ORDER: SearchKind[] = ['module', 'page', 'action', 'person', 'request', 'task', 'message', 'sensor'];

export interface SiteModule { title: string; path: string; desc: string }
export interface SensorSource { uid: string; label: string; floorId: string | null; online: boolean; simulated: boolean }

/** Screens inside a module that have an address of their own. */
const PAGES: { title: string; path: string; detail: string; keywords: string }[] = [
  { title: 'HKUMySeat usage', path: '/analytics/usage', detail: 'Analytics: students, searches, sign-ins and traffic of the student site.', keywords: 'analytics students accounts traffic latency occupancy' },
  { title: 'Server and back end', path: '/analytics/server', detail: 'Analytics: processor, memory, storage, network, services and sensor ingest.', keywords: 'analytics cpu memory disk storage network systemd units ingest host' },
];

export function buildIndex(input: { modules: readonly SiteModule[]; accounts: boolean; snapshot: WorkspaceSnapshot | null; sensors: SensorSource[] }): SearchEntry[] {
  const { snapshot } = input;
  const entries: SearchEntry[] = input.modules.map((m) => ({
    id: `module:${m.path}`, kind: 'module', title: m.title, detail: m.desc, hint: m.path, keywords: 'module', target: { type: 'navigate', path: m.path },
  }));
  if (input.accounts) entries.push({ id: 'module:/accounts', kind: 'module', title: 'Accounts', detail: 'Create accounts, change roles, reset passwords and revoke sessions.', hint: '/accounts', keywords: 'users roles admin password members team', target: { type: 'navigate', path: '/accounts' } });
  for (const page of PAGES) entries.push({ id: `page:${page.path}`, kind: 'page', title: page.title, detail: page.detail, hint: page.path, keywords: page.keywords, target: { type: 'navigate', path: page.path } });
  if (!snapshot) return entries;

  const others = snapshot.members.filter((name) => name !== snapshot.me.name);
  entries.push(
    { id: 'action:mailbox', kind: 'action', title: 'Open mailbox', detail: snapshot.mail.unread ? `${snapshot.mail.unread} unread` : 'No unread messages', hint: 'mail', keywords: 'inbox sent messages mail', target: { type: 'mailbox' } },
    { id: 'action:request', kind: 'action', title: 'New feature request', detail: 'Ask for something the system should do.', hint: 'request', keywords: 'file add create idea suggestion feature', target: { type: 'new-request' } },
  );
  if (others.length) entries.push({ id: 'action:compose', kind: 'action', title: 'Compose message', detail: 'Write to one or more members of the team.', hint: 'compose', keywords: 'write send new mail email message', target: { type: 'compose', to: [] } });
  if (snapshot.me.canTriage) entries.push({ id: 'action:task', kind: 'action', title: 'New task', detail: 'Hand a piece of work to someone.', hint: 'task', keywords: 'add create assign todo work', target: { type: 'new-task' } });

  for (const name of others) {
    // Found by what they work on as well as by name: "ml" is a way to ask who to write to.
    const roles = teamRoleText(snapshot.teamRoles[name]);
    entries.push({ id: `person:${name}`, kind: 'person', title: name, detail: roles ? `${roles} · Write a message` : 'Write a message', hint: `${name}@team`, keywords: `member team message mail write ${roles} ${(snapshot.teamRoles[name] ?? []).join(' ')}`, target: { type: 'compose', to: [name] } });
  }
  for (const r of snapshot.board.requests) entries.push({ id: `request:${r.id}`, kind: 'request', title: r.title, detail: `${REQUEST_STATUS_LABEL[r.status]} · ${r.votes} ${r.votes === 1 ? 'vote' : 'votes'} · by ${r.author}`, hint: r.id, keywords: `${r.detail} ${r.status} feature`, target: { type: 'request', id: r.id } });
  for (const t of snapshot.board.tasks) entries.push({ id: `task:${t.id}`, kind: 'task', title: t.title, detail: `${TASK_STATUS_LABEL[t.status]} · ${t.assignee ? `assigned to ${t.assignee}` : 'unassigned'}`, hint: t.id, keywords: `${t.detail} ${t.status} ${t.requestId ?? ''}`, target: { type: 'task', id: t.id } });
  for (const m of [...snapshot.mail.inbox, ...snapshot.mail.sent]) entries.push({ id: `message:${m.id}`, kind: 'message', title: m.subject, detail: m.box === 'inbox' ? `From ${m.from} · ${m.preview}` : `To ${m.to.join(', ')} · ${m.preview}`, hint: m.box === 'inbox' ? 'inbox' : 'sent', keywords: `${m.from} ${m.to.join(' ')} mail`, target: { type: 'message', id: m.id } });
  // A sensor has no page of its own; Sensors is where it is looked at.
  for (const s of input.sensors) entries.push({ id: `sensor:${s.uid}`, kind: 'sensor', title: s.label, detail: `${s.online ? 'Online' : 'Offline'} · ${s.floorId ?? 'not placed on a floor'}${s.simulated ? ' · simulated' : ''}`, hint: s.uid, keywords: 'node device sensor thermal', target: { type: 'navigate', path: '/console' } });
  return entries;
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How well one query word is answered by one field: the start of a word beats the middle of one. */
function fieldScore(token: string, field: string): number {
  const lower = field.toLowerCase();
  if (!lower.includes(token)) return 0;
  if (lower === token) return 4;
  return words(lower).some((word) => word.startsWith(token)) ? 2 : 1;
}

/**
 * Entries that answer every word of the query, best first. A word may be
 * found in any field, but one found nowhere rules the entry out: adding a
 * word must only ever narrow the list.
 *
 * An entry is ranked by its worst-answered word before its total. "analytics
 * server" should lead with the page named by both words, not with the module
 * that is called one of them and merely mentions the other.
 */
export function search(entries: readonly SearchEntry[], query: string, limit = 8): SearchEntry[] {
  // Split on white space only, so an id like "R-12" or a path stays one word.
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];
  const scored: { entry: SearchEntry; weakest: number; total: number }[] = [];
  for (const entry of entries) {
    let total = 0, weakest = Infinity;
    for (const token of tokens) {
      const best = Math.max(fieldScore(token, entry.title) * 3, fieldScore(token, entry.hint) * 3, fieldScore(token, entry.keywords) * 2, fieldScore(token, entry.detail));
      weakest = Math.min(weakest, best);
      if (best === 0) break;
      total += best;
    }
    if (weakest > 0) scored.push({ entry, weakest, total });
  }
  return scored
    .sort((a, b) => b.weakest - a.weakest || b.total - a.total || KIND_ORDER.indexOf(a.entry.kind) - KIND_ORDER.indexOf(b.entry.kind) || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit).map((row) => row.entry);
}
