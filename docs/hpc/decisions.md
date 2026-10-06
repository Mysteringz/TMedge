# Module 02 (ML Training on HKU HPC2021): decisions

HANDOVER.md rule 8: date, decision, why. The spec itself is
[HANDOVER.md](HANDOVER.md); what has to happen before any job reaches HKU is
[m0-checklist.md](m0-checklist.md).

## 2026-10-06: M1 built inside the algo console

**Status.** M1 (drafts, uploads, spec validation, sbatch rendering, no HPC)
and the module 02 screen are built. **M0 has not run**, no plan (A/B/C) has
been chosen, and nothing in this module reaches `*.hku.hk`. The backend is
`"none"`. `config/hpc.json` refuses any other value, and no endpoint accepts a
PIN, OTP or HPC password (`test/train.test.ts`: "no endpoint accepts HKU
credentials before the M0 gate").

1. **Module 02 lives in TMedge (TypeScript, Express), not in a separate FastAPI
   app.** The task was module 02 *of algo.hkumyseat.com*. That site is
   `src/algo/server.ts`, which already has per-person accounts, sessions, the
   write guard, CI and the deploy pipeline. The handover picked Python for
   paramiko and openconnect, which are M2/M3 concerns; M1 needs neither. When a
   real backend arrives, rule 5's own escape hatch fits: the gateway can be its
   own process (in Python if that helps) behind a Unix socket, implementing
   `HpcBackend` (`src/algo/train/backend.ts`).
2. **The handover's paths map as follows:**
   - `/app/jobs/*` → `src/algo/train/{spec,sbatch,zip,uploads,store,routes}.ts`
   - `/api/*` → `/api/train/*`
   - `docs/*.md` → `docs/hpc/*.md`
   - the UI → `algo-app/src/console/Train.tsx` (+ `train/`)
3. **Dashboard accounts are the algo console's accounts** (scrypt, one per
   person, Turnstile). The handover's argon2id, SameSite=Strict and CSRF token
   (§6.1, T4-5) are replaced as follows:
   - **Cookie:** the existing cookie is SameSite=Lax. `auth.ts` explains why:
     Cloudflare Access's first navigation.
   - **CSRF:** every write must carry the `x-tm-algo` header. A cross-site page
     cannot send that header without a CORS preflight, and this server never
     grants one.
   - **Open before M4:** decide whether credential-bearing requests need more
     (for example a Strict cookie scoped to `/api/train`).
   - **Not built yet:** the admin "see all jobs" view (`?all=1`). The algo
     console has no admin role.
4. **A JSON store, not Postgres + Alembic.** There is one writer, and each
   person has at most 100 jobs. The record shape is §8's, so moving to a table
   later is a copy. `audit.jsonl` is §8's `audit_log`. An unreadable
   `jobs.json` makes the module refuse all reads and writes; it is never
   overwritten.
5. **Uploads are the request body (`application/octet-stream`), then a
   separate create, rather than one multipart request.** This adds no runtime
   dependency. The body is streamed to disk through a byte meter, never held in
   memory (the box has 1 GB).
6. **The sbatch script uses relative `--output`/`--error` and
   `cd "$SLURM_SUBMIT_DIR/code"`.** As a result, nothing at render time
   depends on `$HOME`, and the preview is byte-for-byte what will be
   submitted.
   - Around `module`/`conda`, the script runs `set +u` (their scripts read
     unset variables).
   - `source` and `conda activate` are separate lines: in `a && b`, a failing
     `a` does not stop a `set -e` script.
   - **Consequence for M3:** submit with
     `cd <remote_dir> && sbatch --parsable job.sbatch`.
7. **`maxUploadMb` is 95, not 200.** algo.hkumyseat.com is behind a Cloudflare
   Tunnel, which rejects request bodies over 100 MB with its own 413.
8. **Places where validation is stricter than §6.2.**
   - **Spec fields:**
     - A conda env name may not start with `.` or `-` (`..` and `--help`
       passed the original pattern).
     - The entrypoint may not start with `-` or `/`.
     - Args and env values may not contain NUL or lone surrogates (bash cannot
       carry them unchanged).
     - At most 64 args, 32 env vars, and env values of up to 1024 characters.
   - **Zip uploads:**
     - Refused: backslashes, control characters, and `.` or empty path
       segments.
     - Refused: encrypted, ZIP64 and split archives.
     - Entries may not overlap, and local and central names must agree.
     - At most 1000 `.py` files (more is a virtualenv).
     - Mac litter (`__MACOSX/`, `.DS_Store`) is skipped.
   - **Per-person limits:** 2 GB of code, 100 jobs, 5 pending uploads (kept for
     an hour).
9. **Deferred until there is something to use it:**
   - `notify_email` is refused until M0 Q11 shows mail is delivered and the HPC
     profile exists. The renderer supports it, and it has a golden test.
   - Webhook lines wait for M5 and M0 Q9.
   - The HPC profile (`hku_uid`, `vpn_domain`, §6.1) moves to M4, where it is
     first needed.
10. **Editor: CodeMirror 6**, as the design hand-off asks.
    - CodeMirror writes its styles into a `<style>` element. The console's CSP
      has no `'unsafe-inline'`, so the shell page carries a fresh nonce per
      page (`sendShell`) and the editor passes it via `EditorView.cspNonce`.
      Without that, the editor rendered blank in Chromium.
    - Module 02 is lazy-loaded, so the sign-in page does not download the
      editor.
11. **Design mapping:**
    - "Test Results" becomes **JOB**: state, SLURM id, elapsed, exit, and the
      jobs table.
    - "Export Model" becomes **JOB SPEC**.
    - The toolbar's dataset/epochs fields become arguments, because datasets
      are out of scope (§6.2).
    - "SEND JOB TO TRAIN" is drawn where the design puts it, disabled, with the
      reason on screen.
    - No accuracies or losses are shown, because none exist yet. Model export
      is not in the handover and is left out.
12. **Unresolved: the deployment target differs from the handover's (§11).**

    | | Live box | Handover assumes |
    |---|---|---|
    | Instance and OS | t3.micro, Amazon Linux 2023 | Ubuntu 24.04 |
    | Region | ap-southeast-1 | ap-east-1 preferred |
    | Swap | 2 GB unencrypted | none, or encrypted |
    | Packaging | systemd units | Docker Compose |

    Run M0's S2 from the host and region that would actually run the gateway.
    Check that openconnect and ocproxy can be installed there.
