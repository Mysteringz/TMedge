# CI and production delivery

`feature branch → pull request → required CI → merge → main CI artifact → production approval → deploy → health checks / automatic rollback`

## Development and review

Use Node 22, then install all three lockfiles:

```sh
npm ci
npm --prefix web-app ci
npm --prefix algo-app ci
npm run typecheck
npm test
npm run crosscheck
npm run build
npx playwright install --with-deps chromium webkit
npm run test:algo-mobile
python3 deploy/test-release.py
deploy/test-deploy.sh
```

TMsense and TMWAccess must be checked out beside TMedge. CI pins their commits
in `ci/tmsense.ref` and `ci/tmwaccess.ref` so an unrelated upstream push cannot
silently change a release. Update the pins through a PR after coordinated
protocol changes. Manual CI can override `tmsense_ref` to test an unmerged
firmware change; those runs cannot produce a production artifact.

The `changes` job verifies README automation and classifies the complete git
diff. When only the root `README.md` is modified, it skips runtime jobs. Any
other file, missing history, README deletion or mixed change runs the full
pipeline. `config/ai-knowledge.md` is runtime configuration and is never exempt.

The `build-test` job runs typechecks, unit/integration tests, both protocol
crosschecks, archive security tests, the complete build, mobile browser
regressions, and a local deployment rehearsal. The required `container` job
checks the documented Docker build for runtime changes and is skipped for
README-only changes. The required `check` job verifies that classification
succeeded and that both runtime jobs succeeded or both were intentionally
skipped. Workflow-level path filters are deliberately avoided, because they
leave required checks pending and block documentation PRs.
PR jobs have read-only tokens and no production secrets. Actions are pinned to
commit SHAs; Dependabot proposes dependency and action updates weekly.

`main` requires a PR, both checks, and an up-to-date branch. Force pushes and
deletion are blocked, including for admins. With one developer, review count
is zero because GitHub does not let authors approve their own PR. CODEOWNERS
names the repository owner; increase required reviews to one when a second
reviewer joins. Production release approval is a separate gate.

## Build once, approve, deploy

A successful **runtime push CI run on main** stores `release-<full commit SHA>` for
30 days. It contains the compiled runtime, static assets, configuration,
lockfile, `RELEASE.json`, file SHA-256 manifest, and archive checksum. It never
contains `.env`, private keys, recordings, local data or a copy of the firmware
implementation. `dist/src/code-index.json` is in it too: the text of this
repository's tracked source and documents, built by `npm run build` from the
same commit, with machine addresses struck out, for Ask AI to look things up
in (docs/ASSISTANT.md). Runtime dependencies are installed from the lockfile on the
server with lifecycle scripts disabled, or reused when the lockfile matches.

`Deploy production` validates the source run, repository, event, workflow and
commit, then waits for the **production** environment's required reviewer.
Approve the release in GitHub Actions after inspecting its CI run and commit.
An older commit is refused if any path except the root README changed while
approval was pending. Before validation and again after approval, the complete
Git root trees must match apart from `README.md`; directory tree hashes cover
all descendant source and configuration files. This lets documentation move
forward without invalidating an already checked runtime artifact. The
workflow also supports an admin-only manual dispatch with a successful main
CI `run_id`. PR runs and manual CI runs cannot be promoted.
README-only CI has no runtime artifact. Its production validation exits
without entering the production environment or requesting approval; manually
trying to promote such a run is refused.

## README maintenance

`Update README structure` runs on GitHub daily at approximately 09:17 Hong Kong
time and can be started with Run workflow. It needs no API key and no running
local computer. GitHub may delay scheduled runs.

`ci/readme_structure.py` builds a compact directory tree from `git ls-files`:
all tracked directories and visible root files, with generated/private data
directories excluded. It replaces only the block between
`project-structure:start` and `project-structure:end` in `README.md` and never
updates prose or links. No tree difference means no commit and no PR.

For changes, the bot reuses `automation/readme-structure`, opens a README-only
PR, explicitly dispatches CI with `readme_only=true`, waits for the brief
required checks, then squash-merges through branch protection. It never uses
an admin bypass, force push or production credentials. Manual CI still runs
the full pipeline by default, and the README-only input is honored only when
the actual diff modifies just `README.md` and no firmware override is set.

The built-in GitHub token needs contents, pull-request and actions write
permissions for this workflow. Enable **Allow GitHub Actions to create and
approve pull requests** in repository Settings → Actions → General. The bot
creates PRs but does not submit reviews. The explicit CI dispatch avoids an
extra personal token and supplies required checks for bot-created PRs.

If main advances during the check, branch protection prevents a stale PR merge.
The next daily run merges current main into the bot branch and regenerates
the tree. A merge conflict or any edits outside the generated tree stop the
automation and leave the PR for inspection.

To preview or verify locally:

```sh
python3 ci/readme_structure.py
python3 ci/readme_structure.py --check
python3 -m unittest discover -s ci -p 'test_*.py'
```

The environment accepts only `main`; only that job gets the dedicated SSH key.
Production runs are serialized and running deployments are never cancelled by
new pushes. A pinned SSH host key prevents connecting to an impostor. On EC2,
the dedicated `tmedge-ci` account's key has a forced command with no shell,
forwarding, PTY, or arbitrary sudo access. It can report releases or submit a
checksum-verified runtime archive to the root-owned deployment receiver.

GitHub required reviewers are supported for public repos; on private repos,
the plan must explicitly support that feature. **Do not provision production
credentials or enable automatic deployment without this gate.** Environment
configuration is server-side state, not something a workflow YAML can enforce.

## Deployment and rollback

The CI job uses the same `deploy/deploy.sh artifact <archive>` entry point as
manual artifact deployment. No rebuilding happens during promotion. The
receiver validates every archive member before extraction, rejects links,
traversal, duplicate paths and oversized payloads, verifies the file manifest,
and refuses to overwrite an existing release. One server lock covers upload
acceptance, activation, health checks and retention.

Manual use with the administrator's existing SSH identity:

```sh
deploy/deploy.sh                 # checks, builds and packages a local release
deploy/deploy.sh artifact /path/to/tmedge.tar.gz
deploy/deploy.sh list
deploy/deploy.sh rollback <id>   # inspect list and select a known healthy id
```

The dedicated CI key needs `DEPLOY_RESTRICTED_KEY=1`; administrator keys leave
it unset. `DEPLOY_HOST` and `DEPLOY_SSH_KEY` select the target and identity.
A local build refuses uncommitted changes unless `--allow-dirty` is explicitly
used; such a release is marked dirty. `--skip-checks` is an emergency option,
not used by the production workflow.

Each release gets `/opt/tmedge-releases/<timestamp>-<commit>/`; `/opt/tmedge`
is an atomic symlink to the live one. The shared `.env` stays in
`/opt/tmedge-shared/` with mode 600. Data stays under `/var/lib/tmedge`.
Health requires all three services to remain active without automatic restarts,
the web health endpoint to report a fresh edge snapshot, the console port
and the algo console to respond (200 or 401), and the direct node listener,
when configured, to answer its `/healthz`. A restart-command failure or failed health check
restores the previous release. If restoring also fails, deployment reports a
failure and the operator must inspect systemd logs. The five newest eligible
releases are retained; live and immediate rollback releases are protected.

Release manifests are checked again before rollback. `QUARANTINED` marks a
release whose provenance is not trustworthy; it is excluded from rollback
selection. Never use raw rsync to modify `/opt/tmedge` or a release directory.
Rollback changes code, not user data. Future database/schema changes need
backward-compatible migrations and a separate data recovery plan. Location
configuration uses persistent `NODES_CONFIG`/`DATA_DIR` in file mode or
PostgreSQL tables plus edge `DATA_DIR` in database mode. Apply the reviewed
location schema migration with `npm run db:migrate` before starting the new
edge release; automatic application startup does not create or upgrade schema.
Back up the database and edge data directory as one recovery set so asset
metadata, drafts and stored asset bytes remain aligned. See the
[location storage guide](../docs/location-configuration-storage.md) for the
backup and restore procedure.

A local rehearsal uses real web/edge processes on isolated ports and fake
systemd control. It covers migration, archive promotion, permissions, failed
startup, failed restart command, delayed failure, corruption, manual rollback,
retention, invalid IDs and concurrent deployment refusal. This is not a second
production server: external Cloudflare/Tailscale and hardware behavior still
need live observations.

## Receiver installation and key rotation

An administrator installs reviewed copies of `remote.sh`, `release.py`,
`ci-receiver.py`, and `install-ci-receiver.sh` on EC2, then runs:

```sh
sudo bash /path/to/reviewed/deploy/install-ci-receiver.sh /path/to/ci-key.pub
```

This creates the restricted account and root-owned `/opt/tmedge-deploy` tools;
it does not restart application services. Re-running rotates its dedicated
public key. Keep the private half only in the production environment secret
`DEPLOY_SSH_KEY`; populate `DEPLOY_KNOWN_HOSTS` from the host's public key read
over an already verified administrator SSH connection. Set environment
variable `DEPLOY_HOST` to `tmedge-ci@<EC2 hostname>`. Never put the personal EC2
administrator key into CI. Reinstall reviewed receiver files when they change;
artifacts cannot replace the privileged receiver.

### Keeping the receiver in step

`remote.sh` (which health-checks and rolls back), `release.py` and
`ci-receiver.py` run from `/opt/tmedge-deploy`, not from the release. CI tests
the repo's copies, so when the box's copies fall behind, a release is judged
by rules it was never tested against. On 2026-10-04 that rolled back a
release which had passed every check: the repo's `remote.sh` accepted a new
response from the console port and the installed one, from 2026-09-25, did
not.

So the deploy now compares them first. `ci-receiver.py version` reports the
sha256 of the three installed files, and `deploy/deploy.sh receiver-check`
(an explicit step in `Deploy production`, and the first thing
`deploy.sh artifact` does) refuses to upload anything if they differ from the
release's `deploy/`. The failure names the stale files. A receiver too old
to answer `version` counts as stale.

When a PR changes any of those three files, the administrator updates the
box after merging and before approving the deploy:

```sh
git checkout main && git pull
deploy/deploy.sh receiver-install   # administrator key; clean origin/main only
```

It writes each file beside its target and renames it into place (root-owned,
755), then runs `receiver-check`. It does not touch the CI account or key.
Use `install-ci-receiver.sh` only to create that account or rotate the key.
If a deploy was refused for a stale receiver, re-run its failed job after
installing.

The algo preview compiles the separate firmware sources selected by the
server's `TMSENSE_DIR`. When changing the pinned firmware detector, update that
reviewed source checkout as part of release preparation. Firmware flashing
remains the console's pilot-first process, never an automatic action on merge.

## Companion repositories

TMsense CI runs packet and detector host checks, compiles the secret-free
`tmflash` firmware environment, and retains the firmware binary. TMWAccess
runs typecheck, tests and build on Linux and macOS with Node 22. TMflash runs
fake-serial-node tests and release builds on macOS. These pipelines do not
flash devices or restart the site gateway automatically.

## Turning on account-based adoption (TMflash)

TMflash signs in with an existing algo account using browser verification and
PKCE. It queues requests; a signed-in operator matches the physical UID and
request code in module 06 Adoption to approve. No service token is needed.
See [the adoption runbook](../docs/ADOPTION.md) for account-session scope,
Cloudflare API exceptions, persistent registry preparation and live checks.

File-mode registration must use a writable persistent directory outside the
release. Both the nodes file and its parent must be writable: atomic registry
replacement and the pending-request file require directory access. Production
uses `/var/lib/tmedge/adoption/nodes.json`, inside the service's existing
`ReadWritePaths=/var/lib/tmedge`, with `NODES_CONFIG` pointing there. Merely
making `/opt/tmedge-shared/nodes.json` writable is insufficient when its
parent and the systemd filesystem policy forbid atomic replacement.

`TMFLASH_TOKEN` remains optional compatibility for existing automation. It does
not enable account sign-in or replace its verification. For PostgreSQL mode,
keep the existing separately approved import/cutover and runtime-role setup;
this file-storage preparation must not be used for that mode.
