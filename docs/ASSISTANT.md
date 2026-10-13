# Ask AI (the assistant on the algo console's landing page)

The box on the landing page searches the site. When what was typed is a
question, or the site has nothing by that name, it is offered to **Ask AI**: a
language model that has been told how this system works, is shown the parts
of this repository's source that match the question, and answers in a panel
under the box.

It answers; it does not act. It has no tools, no credentials, and no way to
reach a sensor, a parameter, an account or a student.

```
browser ── POST /api/assistant/ask ──> edge (algo console, signed in)
                                         │  system prompt  = rules + config/ai-knowledge.md
                                         │  "right now"    = a few live figures
                                         │  "from the repository" = the pieces of source and
                                         │                    documents whose words match the question
                                         │  the question, and the last few turns
                                         └── POST /api/chat ──> Ollama, on the team's Proxmox cluster
        <── text/event-stream: which files it read, then the answer piece by piece ──┘
```

## Where the model runs

On the team's own Proxmox cluster, not on a public service: an Ollama
container with a GPU, serving `qwen2.5:7b-instruct-q4_K_M`. The edge only
carries text to it and back. Measured through this code path, on that GPU:

| | to the first word |
|---|---|
| the model has to be loaded | about 20 s more |
| the knowledge base has to be read (first question after a load, or after other work used the GPU) | about 10 s more |
| a question that is shown source | about 5 s |
| a question that is not | under 1 s |

The model reads about 400 tokens a second and writes about 20, so an answer
of a paragraph or two takes 10 to 20 s to finish.

**Getting it ready before anybody asks.** When the landing page is opened the
edge asks the model server to load the model and read the rules and the
knowledge base (one token of output), at most once in four minutes and never
while an answer is being written. The model server keeps what it has read, so
the question that follows starts from there. A model server that is down
makes no difference to the page loading.

The container is shared with other work and answers one request at a time, so
the edge sends it one question at a time too: a second person asking while an
answer is being written is told so, not queued.

### Connecting the edge to it

The edge needs to reach the container's port 11434. Two settings switch the
feature on; with neither set it is off and the page says "not set up".

| variable | meaning |
|---|---|
| `AI_OLLAMA_URL` | Base URL of the Ollama server as the edge reaches it, for example `http://<tailnet address of the Proxmox host>:11434`. Plain http(s), no credentials in it. |
| `AI_MODEL` | The model to ask, for example `qwen2.5:7b-instruct-q4_K_M`. It must already be pulled. |
| `AI_CONTEXT_TOKENS` | Optional, default 8192. The context window asked for. Everything sent is budgeted to fit it; a larger one fits more source and more of a conversation, if the GPU has the memory. |
| `AI_TIMEOUT_MS` | Optional, default 120000. The longest one answer may take. |
| `AI_KEEP_ALIVE` | Optional, default `30m`. How long the model server keeps the model in memory after a request: a duration (`45m`, `12h`), or `-1` to never unload it. `-1` ends the 20 s load for good and holds most of the GPU's memory for good. |
| `AI_KNOWLEDGE_FILE` | Optional. Defaults to `config/ai-knowledge.md` in the release. |
| `AI_CODE_INDEX_FILE` | Optional. Defaults to `dist/src/code-index.json` in the release (see "Reading the repository"). |

Set one of the first two without the other and the edge refuses to start,
like every other half-configured setting.

The container is on the cluster's own network, which the edge is not on. The
edge and the Proxmox host are both on the tailnet, so the smallest bridge is a
TCP forward on the Proxmox host, reachable only from the tailnet:

```sh
# on the Proxmox host that runs the Ollama container
tailscale serve --bg --tcp 11434 tcp://<container address>:11434
# to undo:  tailscale serve --tcp=11434 off
```

Ollama has no sign-in of its own, so whatever is used must not be reachable
from outside the tailnet. Then set the two variables in the edge's shared
environment and restart the edge through the usual pipeline.

## What the model is shown, and what it never is

Every request carries four things and nothing else:

1. **Rules and the knowledge base** (`config/ai-knowledge.md`), word for word.
   This part never changes between requests and goes first, so the model
   server reads it once and keeps it.
2. **"Right now"**: who is asking (name, access role, team roles), how many
   sensors are reporting, seats taken per public floor, and the feature
   requests and tasks still in play. All of it is what any signed-in member
   already sees on the landing page.
3. **"From the repository"**: a few pieces of this repository's own source
   and documents, when the question names something a file can be found by.
   See the next section.
4. **The question** and the last three exchanges of the same conversation.

It is never shown anybody's mail, a thermal frame or camera image, anything
about a student, an address of a machine, somebody's email address, or a
secret. Request and task titles are people's words, and source is text
somebody wrote, so those blocks are labelled as data and the rules tell the
model they are never an instruction.

Everything is budgeted to fit the model's context with room to answer
(`tokensIn` is the estimate; measured, English and code run about four
characters a token). What does not fit is dropped from the far end of the
conversation first, then the source; never the exchange just before a
follow-up.

## Reading the repository

The model reads about eight thousand tokens at a time, the knowledge base
takes nearly half of that, and the source is a few hundred times larger. So
nothing "reads the repo". A question is answered from the handful of pieces
whose words match it, and the page lists which files those were.

**The index.** `npm run build` runs `src/tools/code-index.ts`, which writes
`dist/src/code-index.json`: every tracked source file and document, cut into
pieces of half a screenful at the places the author left a blank line or a
heading. It is built in CI from the commit being released and ships inside
the release, so what the assistant explains is what is running. It is about
3.5 MB; the edge reads it the first time the landing page is opened after a
restart, a slice at a time, and holds about 10 MB for it from then on.

What goes in is an allow-list (`indexable` in
`src/modules/assistant/domain/code-index.ts`), because everything in it
leaves the edge inside a prompt:

- **In:** `src/`, `algo-app/src/`, `web-app/src/`, `docs/`, `deploy/`, `ci/`,
  `tools/`, `rigs/`, `docker/`, the workflows, and `CLAUDE.md`, `README.md`,
  `DOCKER.md`, `package.json`, `.env.example`, `Dockerfile`,
  `docker-compose.yml`.
- **Tests, as their titles only.** Tests here are named as sentences about
  behaviour, so the titles answer "is that tested, and what is promised?".
  Their bodies and fixtures are full of pretend keys and passwords a model
  would quote as real.
- **Never:** `config/` (the site's configuration; the knowledge base is sent
  whole already), `data/`, anything named `.env`, build output, anything over
  200 kB, anything that holds a private key.
- **Struck out wherever they are written:** IPv4 addresses other than
  loopback, the names of our cloud and tailnet hosts, and email addresses
  (`<address>`, `<host>`, `<email>`).

Only files git tracks are read, so a stray copy on a developer's machine
never reaches a prompt.

**Finding the pieces.** By words (BM25), not by meaning: it needs no second
model on a GPU that barely holds the first, it is the same on every machine,
and its misses can be read off a test. Identifiers are split where a
programmer reads them split (`replayWindow`, `replay_window`). A piece is
also findable by its file's name, the section it sits under, the names it
declares, the comment its file opens with, and its file's line in the map at
the top of `CLAUDE.md` — the team's own words for what each file is for
("HMAC, replay" where the code says tag and cursor). **Keeping that map
current is what keeps the assistant able to find things.**

- A question whose words say too little to pick a file ("what is on the
  board?", "how many sensors are reporting?") is shown no source and is
  answered from the knowledge base and the figures, as fast as before.
- A question in another language has no words to match: it gets the
  knowledge base only.
- A follow-up borrows the words of the question before it, but only when it
  points back at it ("and why?", "is that tested?").
- At most some 6,000 characters of source a question (about 1,500 of the
  model's tokens): four seconds of reading on this GPU. More would find more
  and feel broken.

**What it is like.** It finds the right file for most "how does X work"
questions and explains from it. It is a 7-billion-parameter model reading
excerpts: it can miss the piece that matters, read too much into the piece it
has, and attribute what one file does to another. The list under each answer
is what was put in front of it, not what it claims to have used, so that list
can be trusted where the prose cannot. Open the file before relying on it.

Nothing about a question or an answer is logged or stored on the edge.
Conversations live in the browser tab and are gone when it is closed.

## The knowledge base

`config/ai-knowledge.md` is the whole of what the assistant knows about the
system. It ships in the release next to the code it describes.

**It must be updated in the same change as anything that changes how the
system works or what the console offers** (see CLAUDE.md). A test fails when
the console has a module the file does not describe; nothing can test that a
description is still *true*, which is why it is a rule for people and for AI
coding agents alike.

It is limited to 16 kB, because it has to leave the model room to answer, and
it must hold no secret, no machine address and nothing about a named person:
it is sent off the edge on every question.

## Rules this module keeps

- **It cannot act.** No tools are given to the model and none of its output
  is executed, parsed for commands or followed. Its words are rendered as
  text (with `**bold**` and `` `code` `` shown as such, built as elements).
- **It explains code and does not write it out.** Shown real source, this
  model "quotes" code it has made up, complete with imports of files that do
  not exist. The model server is told to stop at a code fence, and an answer
  that stops there says so and points at the file.
- **A model that is down is said to be down.** An answer either arrives or
  the page says it did not; a stream that stops mid-sentence ends by saying it
  was cut short and is never presented as complete.
- **Marked as AI, always.** Answers carry the AI label and a line saying
  where they came from and that they can be wrong.
- **Writes need the console's header and this origin**, like every other
  write here, so another site cannot spend the GPU as whoever is signed in.
- 20 questions per person per five minutes; 1,000 characters a question; an
  answer is cut at 6,000.
- Closing the page, or pressing Stop, stops the model working on the answer.

## Search first, then ask

What is typed is looked up on the site first. It goes to the assistant first
instead when it ends in a question mark, opens with a word people ask with
(how, why, what, can, explain…), is a whole sentence, or matches nothing on
the site. Either way the other is one row away, and Enter takes the first
row. The "Ask AI" button asks whatever is in the box.

## Not here

- **Doing things on the site.** That needs tools, a permission model for
  them and an audit trail; none of it is built.
- An MCP server. The cluster is used as the model server and nothing more.
- Memory between visits, or a record of what was asked.
- The other repositories (TMsense, TMWAccess, TMflash). Only this one is
  indexed: it is the one whose release the index ships in.
- Search by meaning. That needs an embedding model beside the chat model,
  and the GPU has room for one of them.

## Tests

`test/assistant.test.ts` (what the model is sent, in what order, and that
mail never is; who may ask; a dead or failing model server; one answer at a
time; stopping; configuration; the knowledge base naming every module; which
pieces of source a question is sent and which files the page is told; that
everything fits the context; getting the model ready when the page opens;
what the index admits and strikes out; and that this repository's own index
finds the file that answers a question), and the landing-page step in
`test/algo-mobile.test.mjs` (site first, questions to the assistant,
follow-ups, the list of files read, and the page with no model set up).
