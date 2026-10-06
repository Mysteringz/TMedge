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

## 2026-10-06 (later): Plan A, chosen by the team before M0

The team chose **Plan A**: each person types their own UID, Portal PIN and
one-time code, and the console opens their own HKUVPN tunnel and HPC2021 login
with them. They chose it before M0 had run, so the first real logins double as
M0's S1–S4 and need a person present, which they have by design: each person
is typing their own code. **The ITS policy question (§3 Q12) is still open.**
If HKU says no to relaying credentials, switch to `"backend": "none"`.

13. **Credentials are sealed in the browser** (ECDH P-256 + HKDF + AES-GCM to a
    one-time server key; `src/shared/hpcseal.ts`). This site is behind
    Cloudflare Tunnel, so TLS ends twice before the edge. Sealing means
    Cloudflare, cloudflared and Express only ever carry ciphertext. The edge
    decrypts straight into a Buffer (`Credentials`), never a JavaScript string,
    and zeroes it the moment the SSH login is done, before any upload or
    sbatch. A V8 heap snapshot taken after a full run contains no trace of the
    PIN (`test/hpcstack.test.ts`).
14. **The code is sent only when openconnect asks for it.** Against a real
    AnyConnect server, a wrong PIN makes openconnect show the form again and
    read the next stdin line as a second password. Fed "PIN\nOTP\n" up front,
    one typo would cost two failed logins and send the code as a password. So
    the driver writes the PIN, waits for the second-factor prompt, and kills
    openconnect on "Login failed". That is one attempt per click (rule 4).
    openconnect's stderr carries Set-Cookie headers, so it is never logged or
    shown; failures map to fixed messages.
15. **The system's OpenSSH as a ControlMaster, not paramiko or ssh2.**
    - **No new dependency:** the runtime dependencies stay express and ws.
    - **Session cache:** the master connection is the cache; later commands reuse
      it with no password.
    - **The password:** it reaches ssh only via SSH_ASKPASS. A tiny helper asks a
      one-time Unix socket in a 0700 directory, so the password is never in argv
      or the environment.
    - **Host keys:** pinned with `StrictHostKeyChecking=yes` (the handover's
      RejectPolicy).
16. **The code is copied with tar over the same SSH connection**, to
    `hpc2021.hku.hk`, not SFTP to `hpc2021-io1`. That is one login instead of
    two, so the PIN lives half as long. Job code is small; the IO nodes are
    for bulk data, which stays out of scope (§6.2).
17. **Limits for a 1 GB t3.micro:**
    - 4 concurrent sessions (one tunnel, ocproxy and ssh master each).
    - 10 minutes idle.
    - SOCKS ports 21000–21099 on loopback only.
    - Locked for 15 minutes after 3 failed logins in 15 minutes, per dashboard
      account *and* per HKU UID, before anything reaches HKU.
18. **Status:** while someone is signed in, their active jobs are polled
    every 30 s, and polling does not keep the session alive. Otherwise the
    job shows its last-known state, and "Refresh" asks for a code only if
    the session has ended (§6.6 layers 1 and 3; the webhook layer is not
    built).
19. **The local fake HKU** (`test/hpc-stack/`, `npm run test:hpc-stack`, needs
    Docker) uses ocserv with password + TOTP, DNS and SSH that exist only inside
    the tunnel, and a fake SLURM. All names are under `.test`. Two things it
    taught us that matter at HKU:
    - openconnect's retry behaviour (#14).
    - ocserv refuses a source IP after failed logins. If HKU does the same, one
      person's typos could lock everyone out, because everyone shares the EC2
      IP. Measuring this is in m0-checklist.md.
20. **On the box**, see plan-a-runbook.md:
    - openconnect and ocproxy are built for Amazon Linux 2023, which does not
      package them.
    - `LimitCORE=0` on the edge unit. It was `infinity` with systemd-coredump
      on, so a crash mid-login would have written the PIN to disk.
    - The 2 GB swap is unencrypted. A PIN lives for seconds, but could in
      principle be paged out; encrypted swap is the fix if that matters.

## 2026-10-06 (later still): the cluster is ing@10.21.36.12, not HPC2021

21. **The SSH target is `ing@10.21.36.12`**, a SLURM cluster inside HKU's
    network, reached through each person's own HKUVPN tunnel as before.
    `ing` is **one account the whole team shares**:
    - Every person still signs in to the VPN as themselves (UID, PIN, code).
    - On the cluster, every job runs as `ing`. The dashboard still keeps each
      person's jobs apart in its UI and API.
    - Anyone with the password can see every job in `~ing/hpc-dash` from a
      shell.
    The config is `planA.submitHost`, `sshUser: "ing"` and
    `sshAuth: "shared-password"`. `sshUser: null` with `sshAuth: "pin"` is
    still there for personal accounts (HPC2021's model).
22. **The shared password is typed at every sign-in and kept only as a
    fingerprint** (the team's instruction).
    - **The fingerprint:** scrypt, N=2^15, r=8, with a random salt
      (`hpc/fingerprint.ts`). It is stored in
      `DATA_DIR/algo/train/ssh-password.json` (0600) on the box, never in git.
      This repo may be public, and a hash of a shared password in it would
      invite offline guessing.
    - **Who sets it:** an admin sets or changes it with `npm run hpc-password`,
      typed hidden and twice.
    - **When it is checked:** each sign-in checks the typed password against
      the fingerprint *before* the VPN login. A typo costs no HKU login, no
      one-time code and no failed SSH attempt on the cluster, and does not
      count toward the HKU lockout.
    - **Guessing:** because the check answers at once, wrong guesses are
      limited to 5 per person per 15 minutes.
