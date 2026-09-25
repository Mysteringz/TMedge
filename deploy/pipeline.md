# From a branch to hkumyseat.com

```
branch ──PR──► CI (.github/workflows/ci.yml) ──merge──► main ──► deploy/deploy.sh ──► health check ──► (automatic rollback)
```

## CI

Every PR and every push to `main` runs, on Ubuntu with Node 22 (the server's
major version): typecheck, `npm test`, the crosscheck against `TMsense` (checked
out beside this repo), the full build, and `deploy/test-deploy.sh`, which
rehearses the deploy script against a scratch `/opt` without contacting any
server.

Reproduce a CI run locally, in the same OS family:

```sh
npm run typecheck && npm test && npm run crosscheck && npm run build && deploy/test-deploy.sh
```

## Protecting `main` (GitHub settings, once)

Settings → Rules → Rulesets → New branch ruleset, target `main`:

- Restrict deletions; block force pushes.
- Require a pull request before merging. Required approvals: **0** while one
  person develops (GitHub never lets you approve your own PR), 1 once there is
  a second developer; add a `CODEOWNERS` file naming the admin then.
- Require status checks to pass: **`check`** (the CI job). Also tick "require
  branches to be up to date", so what merges is what was tested.
- Bypass list: the repository admin, for emergencies.

TMedge is a private repo: rulesets on private repos need GitHub Pro (personal)
or Team (organisation). On the free plan they are not enforced; CI still runs
and reports on every PR.

## Deploying

```sh
deploy/deploy.sh              # checks, build, upload, switch, health-check
deploy/deploy.sh list         # releases on the box, * = live
deploy/deploy.sh rollback     # to the release before the live one
deploy/deploy.sh rollback <id>
```

A deploy refuses a dirty tree (`--allow-dirty` to override, and the release id
then says `-dirty`), re-runs every check before uploading (`--skip-checks`
only where CI just ran them), and never uploads `.env`, `data/` or
`node_modules`.

On the box, each deploy is a new directory `/opt/tmedge-releases/<utc>-<sha>/`;
`/opt/tmedge` is a symlink to the live one, so the systemd units never change.
The switch is one atomic rename. "Healthy" means all three units active and
not restarted by systemd for 10 s, `/healthz` answering 200 and the console
answering 200 or 401. Anything else switches the symlink back and restarts the
previous release. The five newest releases are kept, and never the live one or
the one before it is pruned.

## One-time migration of the live box

The box today has a plain `/opt/tmedge` that rsync wrote over. Convert it once:

1. Look at the units first. The migration assumes they reference
   `/opt/tmedge` (`WorkingDirectory`, `EnvironmentFile=/opt/tmedge/.env`) and
   nothing inside it by a resolved path:

   ```sh
   ssh -i ../TMcloudkey.pem ec2-user@<host> 'systemctl cat tmedge-edge tmedge-web tmedge-sim'
   ```

2. Migrate. It moves the current tree to `releases/<utc>-pre-pipeline`, moves
   `.env` to `/opt/tmedge-shared/.env` (linked back into the release), points
   `/opt/tmedge` at it and restarts. If the site is not healthy afterwards it
   puts every file back where it was and says so. The site is down only for
   the restart, as with any deploy.

   ```sh
   deploy/deploy.sh migrate
   ```

3. Deploy normally from then on. The first deploy after migrating reuses the
   old tree's `node_modules` if `package-lock.json` has not changed.

Rolling back past the pipeline is `deploy/deploy.sh rollback <id>-pre-pipeline`.
