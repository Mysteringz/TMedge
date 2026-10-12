# Workspace (the algo console's landing page)

`algo.hkumyseat.com/` is one page that answers what a team otherwise keeps in
four other tools: **finding something on the site or asking how it works,
writing to each other, deciding what to build next, and seeing at a glance
whether the system is well.** Top to bottom:

| part | what it is |
|---|---|
| Welcome | The greeting, with the person's name in bold. It types itself in several languages; that is decoration, and the heading's name for a screen reader is always the English line. Reduced motion gets the English line, still. |
| The box | One rounded field. It searches the site first (modules, pages, members, your own mail, requests, tasks, sensors) and offers anything that reads as a question, or matches nothing, to Ask AI. `/` or Ctrl/Cmd+K reaches it. See [ASSISTANT.md](ASSISTANT.md). |
| Suggested for you | The modules this person opens most, most used first. There is no module list on this page any more; the header still lists every module on a wide screen, and on a narrow one, where it does not, all of them are shown here. |
| System now | Six figures from the last hour of Analytics: sensors reporting, seats taken, students online, processor, memory, storage. |
| Mailbox | Messages between the people who hold accounts: inbox, sent, compose, reply. Its own panel. |
| Requests and tasks | A second panel: feature requests anyone may file and vote on, counted by status, and tasks handed to a member. |

It is not a module and has no path or number of its own. Nothing in it
touches a sensor, a parameter or the student site, and nothing a student can
reach reads it: the routes are on the algo console only (`/api/workspace`,
`/api/assistant`).

## Search

The box searches one flat list of entries built in the browser
(`algo-app/src/entities/workspace/lib/search.ts`): the modules, the pages
inside them that have an address, the people (by name and by what they work
on), what is in the reader's own mailbox, the board, and the sensor registry
(fetched from `/api/sources` the first time the box is focused). Every word
typed must be answered by an entry, so a second word only ever narrows the
list; an entry is ranked by its worst-answered word first, so the page named
by both words comes before a module that is called one of them and mentions
the other. Each entry carries what choosing it *does* (`SearchTarget`).

## Suggestions from personal use

Which modules somebody opens is counted in their own browser
(`algo-app/src/entities/usage`, `localStorage`, keyed by username) and never
sent anywhere. A visit is worth half as much for every week since the module
was last opened, so the list follows what a person does now. With no history
the modules are offered in their usual order under "Jump to". It is a
convenience: per browser, and the page works the same where storage is blocked.

## Team roles

Each account can carry team roles: ML, front-end, back-end, firmware,
hardware (`TEAM_ROLES` in `src/modules/algo-admin/domain/permissions.ts`).
An admin sets them on the Accounts page. They say what somebody works on and
are shown where people are chosen: when writing a message, assigning a task,
and in search ("ml" finds the people who do ML). **They grant nothing.**
Access is the access role (viewer, operator, engineer, admin) and only that;
changing a team role signs nobody out.

## Who may do what

There are no new roles and no new capabilities; the board reads the ones the
console already has (`src/modules/algo-admin/domain/permissions.ts`).

| | viewer | operator, engineer | admin |
|---|---|---|---|
| read the board; file a request; vote | yes | yes | yes |
| send and receive mail | yes | yes | yes |
| edit or withdraw **their own** request while it is open | yes | yes | yes |
| decide a request's status; reword any request | – | yes | yes |
| create, edit, assign and delete tasks | – | yes | yes |
| move the status of a task **assigned to them** | yes | yes | yes |
| delete any request | – | – | yes |
| read somebody else's mail | – | – | **–** |

The page offers a control only when the server said this person may use it
(`can` on every request and task), so a role shows as fewer buttons, not as
buttons that refuse.

## Rules this module keeps

- **Mail belongs to its sender and the people it was sent to, and to nobody
  else.** There is no role that reads other people's mail and no listing that
  is not filtered by who is asking. An id that is not yours answers exactly as
  one that does not exist. The sender is not told who has opened a message.
- **A reused username does not inherit a mailbox.** Usernames can be created
  again after an account is deleted. Mail older than the account asking is
  never shown to it, so whoever is given the name next does not open it to
  find the last person's correspondence.
  The board is different, and deliberately so: requests and tasks are the
  team's and are held by name, so a reused name does take on the old one's
  open request and assigned tasks. The Accounts page already says as much
  about a username's retained history when one is deleted.
- **Removing is from your own mailbox.** The other side keeps their copy; a
  message leaves the file when everybody who had it has removed it.
- **A store that cannot be read is never replaced.** A half-written or
  hand-edited file closes the feature (503) and is left exactly as it was,
  because the thing a write would overwrite is somebody's mail. No file at all
  is an empty store.
- **A save against an older revision is refused**, not merged or overwritten.
  Votes are not edits and do not make anyone's save stale.
- **Writes need the console's header and this origin** (`x-tm-algo: 1`), like
  every other write here: the session cookie is `SameSite=Lax`, and a form on
  another site must not be able to post as whoever is signed in.
- **What a person wrote is shown as they wrote it and as nothing else.** Text
  is stored as text and rendered as text, line breaks kept; control characters
  are dropped on the way in. Nothing in a message is interpreted.
- **The system figures keep Analytics' rule: unknown is not zero.** A source
  that did not answer has a dash and a reason. They come from
  `GET /api/analytics?range=1h` and from nowhere else; in particular the
  landing page does not poll `/api/admin/health`, which stays the
  notification bell's.

## What is kept, and where

Two private JSON files in the data directory, beside the accounts they belong
to (never in the release, which is replaced on every deploy):

| file | holds | bounded by |
|---|---|---|
| `DATA_DIR/algo/workspace/mail.json` | messages, with who has read and who has removed each | 1,000 messages (the oldest make room), 4,000 characters a message, 32 recipients |
| `DATA_DIR/algo/workspace/board.json` | requests with their votes, tasks, and the next number of each | 500 requests, 1,000 tasks (a full board refuses and says so) |

Each is written whole, atomically (`writePrivateJson`: mode 600, fsync,
rename), on every change. Only the edge process writes them, so there is no
lock file: one left behind by a crash would stop people writing to each other
for no benefit. Request and task numbers (`R-12`, `T-7`) are never reused.

There is no migration and no setting. Nothing is written until the first
message or request. Nothing here backs these files up: if the mailbox becomes
somewhere decisions live, include `DATA_DIR/algo/workspace/` in whatever
backs up the data volume.

## Limits and cost

- Bodies to `/api/workspace` are limited to 16 kB. That is deliberate: 4,000
  characters of Chinese are 12 kB on the wire, and the limit that would
  otherwise apply (the sign-in router's 8 kB, which every later route
  inherits) would refuse a message of the stated length.
- 30 messages and 240 other changes per person per five minutes.
- The page reads one snapshot (`GET /api/workspace`: the reader's mailbox
  headers, the board, the member names) every 20 s while the tab is visible,
  and again after each change. Message bodies are fetched when opened. Member
  **names** and team roles are in the snapshot; access roles are not.
- The six figures re-read `GET /api/analytics?range=1h` every 30 s while the
  tab is visible (the Analytics page itself asks every 10 s on that range).
  It is the whole Analytics snapshot for six numbers, about 10 kB compressed;
  a narrower endpoint is the thing to add if landing pages left open all day
  ever show up in the box's data-out.
- The mailbox, board and tiles are a separate bundle loaded by the landing
  page, so the sign-in page does not carry them.

## Not here

- Anything the assistant *does*. It answers; see [ASSISTANT.md](ASSISTANT.md).
- Threads, attachments, drafts kept on the server, read receipts, and mail to
  anyone who is not a member. A reply records what it answers; that is all.
- Comments on a request. The mailbox is for discussion.
- Notifications. New mail shows as a count on the tab the next time the page
  reads; it does not ring the bell, which is for operations.
- With sign-in off (a localhost edge with no `ADMIN_PASSWORD`) there is one
  person, `local`: the board works and there is nobody to write to.

## Tests

`test/workspace.test.ts` (whose mail is whose, the reused username, roles on
the board, stale revisions, the unreadable store, limits, sign-in off, and the
routes inside the real algo server), and the workspace step in
`test/algo-mobile.test.mjs` (search, a message from an engineer arriving for a
viewer, a request becoming a task, what a viewer is and is not offered, the
welcome line, and suggestions from personal use, on a phone in Chromium and
WebKit; the landing page is also in its "all modules fit" matrix from 320 px
to 1440 px). `test/admin-accounts.test.ts` covers team roles.
