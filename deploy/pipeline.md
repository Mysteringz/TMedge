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
python3 deploy/test-release.py
deploy/test-deploy.sh
```

TMsense and TMWAccess must be checked out beside TMedge. CI pins their commits
in `ci/tmsense.ref` and `ci/tmwaccess.ref` so an unrelated upstream push cannot
silently change a release. Update the pins through a PR after coordinated
protocol changes. Manual CI can override `tmsense_ref` to test an unmerged
firmware change; those runs cannot produce a production artifact.

The required `check` job runs typechecks, unit/integration tests, both protocol
crosschecks, archive security tests, the complete build, and a local deployment
rehearsal. The required `container` job checks the documented Docker build.
PR jobs have read-only tokens and no production secrets. Actions are pinned to
commit SHAs; Dependabot proposes dependency and action updates weekly.

`main` requires a PR, both checks, and an up-to-date branch. Force pushes and
deletion are blocked, including for admins. With one developer, review count
is zero because GitHub does not let authors approve their own PR. CODEOWNERS
names the repository owner; increase required reviews to one when a second
reviewer joins. Production release approval is a separate gate.

## Build once, approve, deploy

A successful **push CI run on main** stores `release-<full commit SHA>` for
30 days. It contains the compiled runtime, static assets, configuration,
lockfile, `RELEASE.json`, file SHA-256 manifest, and archive checksum. It never
contains `.env`, private keys, recordings, local data or a copy of the firmware
implementation. Runtime dependencies are installed from the lockfile on the
server with lifecycle scripts disabled, or reused when the lockfile matches.

`Deploy production` validates the source run, repository, event, workflow and
commit, then waits for the **production** environment's required reviewer.
Approve the release in GitHub Actions after inspecting its CI run and commit.
An older commit is refused if main changed while approval was pending. The
workflow also supports an admin-only manual dispatch with a successful main
CI `run_id`. PR runs and manual CI runs cannot be promoted.

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
the web health endpoint to report a fresh edge snapshot, and the console and
algo debugger to respond. A restart-command failure or failed health check
restores the previous release. If restoring also fails, deployment reports a
failure and the operator must inspect systemd logs. The five newest eligible
releases are retained; live and immediate rollback releases are protected.

Release manifests are checked again before rollback. `QUARANTINED` marks a
release whose provenance is not trustworthy; it is excluded from rollback
selection. Never use raw rsync to modify `/opt/tmedge` or a release directory.
Rollback changes code, not user data. Future database/schema changes need
backward-compatible migrations and a separate data recovery plan.

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
