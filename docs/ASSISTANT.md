# Ask AI (the assistant on the algo console's landing page)

The box on the landing page searches the site. When what was typed is a
question, or the site has nothing by that name, it is offered to **Ask AI**: a
language model that has been told how this system works and answers in a
panel under the box.

It answers; it does not act. It has no tools, no credentials, and no way to
reach a sensor, a parameter, an account or a student.

```
browser ── POST /api/assistant/ask ──> edge (algo console, signed in)
                                         │  system prompt  = rules + config/ai-knowledge.md
                                         │  "right now"    = a few live figures
                                         │  the question, and the last few turns
                                         └── POST /api/chat ──> Ollama, on the team's Proxmox cluster
        <── text/event-stream, piece by piece ──┘
```

## Where the model runs

On the team's own Proxmox cluster, not on a public service: an Ollama
container with a GPU, serving `qwen2.5:7b-instruct-q4_K_M`. The edge only
carries text to it and back. Measured through this code path: about 20 s to
the first words when the model has to be loaded, under a second after that,
and a few seconds for a whole answer.

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
| `AI_CONTEXT_TOKENS` | Optional, default 8192. The context window asked for. |
| `AI_TIMEOUT_MS` | Optional, default 120000. The longest one answer may take. |
| `AI_KNOWLEDGE_FILE` | Optional. Defaults to `config/ai-knowledge.md` in the release. |

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

Every request carries three things and nothing else:

1. **Rules and the knowledge base** (`config/ai-knowledge.md`), word for word.
   This part never changes between requests and goes first, so the model
   server reads it once and keeps it.
2. **"Right now"**: who is asking (name, access role, team roles), how many
   sensors are reporting, seats taken per public floor, and the feature
   requests and tasks still in play. All of it is what any signed-in member
   already sees on the landing page.
3. **The question** and the last three exchanges of the same conversation.

It is never shown anybody's mail, a thermal frame or camera image, anything
about a student, an address of a machine, or a secret. Request and task
titles are people's words, so that block is labelled as data and the rules
tell the model it is never an instruction.

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

## Tests

`test/assistant.test.ts` (what the model is sent, in what order, and that
mail never is; who may ask; a dead or failing model server; one answer at a
time; stopping; configuration; the knowledge base naming every module), and
the landing-page step in `test/algo-mobile.test.mjs` (site first, questions
to the assistant, follow-ups, and the page with no model set up).
