# HANDOVER — HKU HPC Job Dashboard

> Handover spec for Claude Code. Read this whole file before writing code.
> Status: **pre-implementation**. Nothing is built yet. Milestone M0 (feasibility spike) gates everything else.
> Last updated: 2026-10-06

---

## 1. Goal

A web dashboard, hosted on AWS EC2, where team members can:

1. Upload Python training code (a single `.py` or a `.zip` project).
2. Fill in job resources (partition, CPUs, GPUs, memory, time limit, modules / conda env).
3. Click **Run**. The job is submitted to HKU's SLURM cluster (HPC2021).
4. See job status, tail logs, and cancel jobs.

**The hard constraint.** HKU HPC login nodes only accept SSH from the HKU campus network or through HKUVPN. HKUVPN requires MFA: UID@hku.hk + Portal PIN + a 6-digit OTP from Microsoft Authenticator or SMS. The EC2 server is off-campus.

**Chosen approach (Plan A).** Each user types their own UID, PIN and current OTP when they submit (or refresh). The backend uses those once to open a short-lived VPN tunnel for that user only, does the SSH work, then drops the credentials. SLURM jobs keep running after the tunnel closes.

Fallbacks are Plan B (per-user pull agent, no VPN) and Plan C (an official HKU route). See §12. The M0 results decide which plan we build.

---

## 2. Known facts (verified 2026-10-06)

| Fact | Source |
|---|---|
| VPN endpoint `vpn2fa.hku.hk` (Cisco AnyConnect / Secure Client) | its.hku.hk/kb/setup-procedure-of-hkuvpn-with-multi-factor-authentication-mfa-for-linux/ |
| VPN login: username `UID@hku.hk` or `UID@connect.hku.hk`, password = Portal PIN, then an `Answer:` prompt for the 6-digit OTP | same |
| Supported MFA methods: Microsoft Authenticator OTP or SMS (SMS OTP valid 3 min). The phone-call method does not work. | same |
| HPC2021 head node `hpc2021.hku.hk` is for editing, compiling and job submission | hpc.hku.hk/guide/ssh-login-and-file-transfer-guide/ |
| IO nodes `hpc2021-io1.hku.hk`, `hpc2021-io2.hku.hk` are for file transfer | same |
| SSH username = bare UID (e.g. `tmchan`, not `tmchan@hku.hk`). Password = Portal PIN, or the initial password if never reset. | same |
| Login nodes accept SSH only from the campus network or HKUVPN | same |
| Login node is not for heavy work; jobs go through the scheduler | hpc.hku.hk/hpc/hpc2021/userguide/ |

## 3. Unknowns (M0 must answer these)

Record the answers in `docs/feasibility-results.md`.

1. Does `openconnect` authenticate to `vpn2fa.hku.hk` with PIN and OTP fed on stdin? Does the server require Cisco hostscan/CSD?
2. Does auth work from an AWS IP? Test `ap-east-1` (Hong Kong) and one other region. Watch for Entra "unusual sign-in" blocks.
3. Can several **different** users hold tunnels at the same time from one EC2 IP?
4. Idle timeout and maximum session length of a VPN session.
5. Is the same OTP rejected if reused within its 30 s window? Do one controlled test only.
6. Does HPC2021 sshd allow public-key auth, or only password?
7. Exact partition names, GPU `--gres` syntax, `sacct` availability, and module / conda conventions on HPC2021.
8. Is IO-node storage the same `$HOME` as the head node? (Docs imply shared storage; confirm.)
9. Do compute nodes have outbound HTTPS? This enables the job-status webhook.
10. Do login nodes have outbound HTTPS, and is `scrontab` or `crontab` allowed? Plan B depends on both.
11. Does SLURM `--mail-user` deliver email on HPC2021?
12. **Policy:** do HKU ITS / HPC rules allow users to enter HKU credentials into a third-party relay like this? Get a written answer (draft email in Appendix A). **If the answer is no, Plan A is dead. Go to Plan B or C.**

### Decision gate after M0

| Outcome | Build |
|---|---|
| Policy OK, openconnect + PIN/OTP works from EC2, concurrent users OK | **Plan A** |
| Policy OK but EC2 auth blocked or flaky; login nodes have outbound HTTPS + cron/scrontab | **Plan B** |
| HKU offers Open OnDemand, slurmrestd, a service account or IP whitelisting | **Plan C** (possibly in combination) |
| Policy not OK and no B/C path | Stop. Report back to the human. |

---

## 4. Plan A architecture

```
 Browser (team member)
   │  HTTPS (Caddy, Let's Encrypt)
   ▼
┌──────────────────────── EC2 (ap-east-1 preferred) ─────────────────────────┐
│  web: React + Vite SPA (static, served by Caddy)                           │
│  api: FastAPI (single uvicorn worker) ── Postgres (jobs, users, audit)     │
│        │                                                                    │
│        ├── gateway/  VPN Session Manager (in-process)                       │
│        │     per user: openconnect --script-tun → ocproxy SOCKS5            │
│        │     on 127.0.0.1:<port from pool>                                  │
│        │                                                                    │
│        └── hpc/      HPC client (paramiko over PySocks socket)              │
│               SFTP → hpc2021-io1.hku.hk   (upload code)                     │
│               SSH  → hpc2021.hku.hk        (sbatch / squeue / sacct / scancel)
└─────────────────────────────────────────────────────────────────────────────┘
   │  userspace tunnel (no root, no route changes on the host)
   ▼
 vpn2fa.hku.hk ──► HKU campus network ──► HPC2021 (SLURM)
```

Key design decisions:

- **`openconnect` + `ocproxy`, not the Cisco client.** `--script-tun --script "ocproxy -D <port>"` turns the tunnel into a local SOCKS5 proxy. It needs no root or `NET_ADMIN`, never changes EC2 routing (so it cannot cut off our own access to the box), and each user gets an isolated tunnel.
- **Credentials never touch disk, DB, queue, logs or process args.** They live in the request handler's memory, go to openconnect over **stdin**, and are dropped. This is why the gateway runs in-process, why there is no Redis/Celery for submissions, and why there is a **single uvicorn worker**. Document this constraint in code comments.
- **Auth and connect are two steps.** Step 1, `openconnect --authenticate`, exchanges PIN+OTP for a session cookie. Step 2 connects with `--cookie-on-stdin`. Auth failures (bad PIN or OTP) can then be told apart from tunnel failures.
- **The Portal PIN is reused for SSH** inside the same operation, because HPC SSH password = Portal PIN. Optional: if M0 shows key auth is allowed, support a per-user ed25519 key (see §6.5), which removes the separate HPC-password field.
- **Session cache:** after a successful auth, keep that user's tunnel and SSH connection open for `VPN_IDLE_TTL` (default 10 min). Status refreshes and log fetches during that window need no new OTP.
- **Host key pinning:** HPC host keys are pinned in config; paramiko uses `RejectPolicy`.

---

## 5. Tech stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, SQLAlchemy 2 + Alembic, Pydantic v2 (`SecretStr` for credentials) |
| HPC/SSH | `paramiko`, `PySocks` (`rdns=True` so DNS resolves inside the VPN) |
| VPN | `openconnect`, `ocproxy` (both apt packages on Debian/Ubuntu) |
| DB | Postgres 16 (SQLite allowed for local dev) |
| Frontend | React + Vite + TypeScript; Server-Sent Events for submit progress |
| Proxy/TLS | Caddy |
| Deploy | Docker Compose on EC2 (Ubuntu 24.04), EBS volume for uploads |
| Tests | pytest, pytest-asyncio, hypothesis, Playwright (UI), docker compose test stack |

---

## 6. Component specs

### 6.1 Dashboard authentication (our app, separate from HKU)

- Invite-only local accounts: an admin creates users. Passwords hashed with argon2id.
- Session cookie `HttpOnly; Secure; SameSite=Strict`. CSRF token on state-changing requests.
- Each dashboard user has an HPC profile: `hku_uid` and the `vpn_username` domain (`@hku.hk` or `@connect.hku.hk`).
- Authorization: users see and act on **only their own** jobs. Admins can see all jobs but can never submit as someone else.

### 6.2 Uploads and job spec

- Accept `.py` (≤ 5 MB) or `.zip` (≤ `MAX_UPLOAD_MB`, default 200).
- Zip safety: reject absolute paths, `..`, symlinks, more than 5,000 entries, or more than 1 GB uncompressed. Extract into `/data/uploads/<job_uuid>/code/`.
- Datasets are **out of scope**. Data must already be on HPC storage; the job spec can reference a path.
- Job spec fields and validation:

| Field | Validation |
|---|---|
| `name` | `^[A-Za-z0-9_-]{1,40}$` |
| `partition` | in `HPC_PARTITIONS` allowlist (config, filled from M0 `sinfo`) |
| `cpus_per_task` | int 1–64 |
| `mem_gb` | int 1–512 |
| `gpus` | int 0–8; only allowed on GPU partitions |
| `time_limit` | `^\d{1,2}-\d{2}:\d{2}:\d{2}$` or `^\d{1,3}:\d{2}:\d{2}$`, ≤ partition max |
| `modules` | each in `HPC_MODULE_ALLOWLIST` |
| `conda_env` | optional, `^[A-Za-z0-9_.-]{1,64}$` |
| `entrypoint` | relative path that exists in the upload and ends in `.py` |
| `args` | list of strings, each ≤ 256 chars, each `shlex.quote`d on render |
| `env` | dict; keys `^[A-Z_][A-Z0-9_]{0,63}$`, values quoted |
| `notify_email` | bool → `--mail-type=END,FAIL --mail-user=<uid>@connect.hku.hk` (only if M0 confirms mail works) |

### 6.3 sbatch template (`app/hpc/templates/job.sbatch.j2`)

Jinja2 with `autoescape=False`. Every user-derived value **must** pass through a validator above or `shlex.quote`. Golden-file tests are required.

```bash
#!/bin/bash
#SBATCH --job-name={{ name }}
#SBATCH --partition={{ partition }}
#SBATCH --time={{ time_limit }}
#SBATCH --cpus-per-task={{ cpus_per_task }}
#SBATCH --mem={{ mem_gb }}G
{% if gpus > 0 %}#SBATCH --gres=gpu:{{ gpus }}{% endif %}
#SBATCH --output={{ remote_dir }}/slurm-%j.out
#SBATCH --error={{ remote_dir }}/slurm-%j.err
{% if notify_email %}#SBATCH --mail-type=END,FAIL
#SBATCH --mail-user={{ mail_user }}{% endif %}

set -euo pipefail
{% if webhook_url %}trap 'curl -fsS -m 10 -X POST "{{ webhook_url }}?event=end&code=$?" || true' EXIT
curl -fsS -m 10 -X POST "{{ webhook_url }}?event=start" || true{% endif %}

cd {{ remote_dir_q }}/code
module purge
{% for m in modules %}module load {{ m }}
{% endfor %}
{% if conda_env %}source "$(conda info --base)/etc/profile.d/conda.sh" && conda activate {{ conda_env }}{% endif %}
{% for k, v in env.items() %}export {{ k }}={{ v }}
{% endfor %}
srun python {{ entrypoint_q }} {{ args_q }}
```

The GPU `--gres` syntax, `module`/`conda` usage and partition names must be adjusted to M0 findings.

### 6.4 Gateway — VPN Session Manager (`app/gateway/`)

Interface:

```python
class VpnSessionManager:
    async def open(self, user_id: int, vpn_user: str, pin: SecretStr, otp: SecretStr) -> VpnSession
    def get(self, user_id: int) -> VpnSession | None   # live session or None
    async def close(self, user_id: int) -> None
    async def close_all(self) -> None                   # on shutdown

class VpnSession:
    user_id: int
    socks_port: int
    opened_at: datetime
    last_used: datetime
    state: Literal["authenticating", "connecting", "up", "closing", "dead"]
```

Behavior:

1. **Auth:** spawn
   `openconnect --protocol=anyconnect --authenticate --user=<vpn_user> --passwd-on-stdin vpn2fa.hku.hk`.
   Write `PIN\nOTP\n` to stdin and close stdin. Parse stdout for `COOKIE=`, `HOST=`/`CONNECT_URL=` and `FINGERPRINT=`. Timeout 45 s.
   - If stdin feeding does not satisfy the `Answer:` prompt (M0 will show), fall back to `pexpect`, or to `--form-entry` once the form field names are known.
   - Map failures to `AuthFailed(bad_credentials | bad_otp | server_error | timeout)` from stderr patterns captured in M0.
   - **Never retry automatically.** A retry can burn the OTP or count toward an HKU account lockout.
2. **Connect:** spawn
   `openconnect --protocol=anyconnect --cookie-on-stdin --servercert <FINGERPRINT> --script-tun --script "ocproxy -D <port>" <CONNECT_URL>`
   and write the cookie to stdin. Wait until `127.0.0.1:<port>` accepts a SOCKS5 handshake. Timeout 30 s.
3. **Ports:** allocate from the pool `SOCKS_PORT_RANGE` (default 21000–21099), loopback only.
4. **Process hygiene:** set `PR_SET_PDEATHSIG` via `preexec_fn` so children die with the API process. Run a reaper task every 30 s that closes sessions idle longer than `VPN_IDLE_TTL` and kills orphan `openconnect` processes. Credentials must **never** appear in argv or env (test T4-3).
5. **Limits:** one session per user. A global cap of `VPN_MAX_SESSIONS` (default 10) returns HTTP 429 when full.
6. **Dashboard-side lockout guard:** 3 failed auths per user in 15 min blocks further attempts for 15 min, with a UI message explaining that this protects their HKU account.

### 6.5 HPC client (`app/hpc/`)

```python
class HpcClient:
    def __init__(self, session: VpnSession, uid: str, password: SecretStr | None, pkey: PKey | None)
    def upload_dir(self, local: Path, remote: str) -> None         # SFTP via hpc2021-io1
    def submit(self, remote_dir: str) -> int                        # sbatch --parsable → job id
    def status(self, job_ids: list[int]) -> dict[int, JobStatus]    # sacct (+ squeue fallback)
    def tail_log(self, remote_dir: str, job_id: int, max_bytes=65536) -> str
    def cancel(self, job_id: int) -> None                           # scancel
```

- Sockets: `s = socks.socksocket(); s.set_proxy(socks.SOCKS5, "127.0.0.1", port, rdns=True); s.connect((host, 22))`, then `SSHClient.connect(host, username=uid, password=..., sock=s)`.
- Remote layout: `$HOME/hpc-dash/jobs/<job_uuid>/{code/, job.sbatch, meta.json, slurm-<id>.out, slurm-<id>.err}`. Resolve `$HOME` with `sftp.normalize(".")`.
- All remote commands are fixed strings. The only interpolated values are validated integers (job ids) and server-generated paths, passed through `shlex.quote`.
- Status: `sacct -j <ids> --format=JobID,State,ExitCode,Elapsed,Start,End,NodeList --parsable2 --noheader`. Ignore `.batch` and `.extern` steps. Map states to `PENDING|RUNNING|COMPLETED|FAILED|CANCELLED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|UNKNOWN`. Parse `CANCELLED by <uid>` correctly.
- Optional SSH key mode (only if M0 Q6 says yes): generate per-user ed25519 keys, encrypt the private key with AWS KMS (envelope encryption), and have the user add the public key to `~/.ssh/authorized_keys` once.

### 6.6 Job status updates (three layers)

1. **Live session polling:** while a user's tunnel is up, poll their non-terminal jobs every 30 s.
2. **Webhook from the job** (only if M0 Q9 says compute nodes have outbound HTTPS): `POST /api/hooks/jobs/{job_uuid}?event=start|end&code=N&sig=<HMAC>`. The per-job HMAC key is generated at submit. The hook may only move state forward and never accepts anything else.
3. **On-demand refresh:** otherwise the UI shows "last known: RUNNING (12 min ago)" and a **Refresh** button, which asks for PIN + OTP if there is no live session.

Optional: SLURM email notifications (§6.2).

---

## 7. Flows

### 7.1 Submit

```
UI: upload + spec → POST /api/jobs                          → job.status = DRAFT
UI: click Run → modal {PIN, OTP, [HPC password if differs]} → POST /api/jobs/{id}/submit
API returns op_id; UI opens SSE /api/ops/{op_id}/events
  1. gateway.get(user) or gateway.open(user, pin, otp)   → event "vpn_auth" / "vpn_up"
  2. HpcClient(...).upload_dir(...)                      → event "uploading"
  3. render job.sbatch, upload, sbatch --parsable        → event "submitted" {slurm_job_id}
  4. job.status = SUBMITTED; audit_log row
  5. drop credential references; session stays cached for VPN_IDLE_TTL
Errors → event "error" {code, user_message}; job.status = SUBMIT_FAILED (retryable with a new OTP)
```

Target: submit completes in under 60 s from clicking Run.

### 7.2 Refresh, logs, cancel

If a live session exists, use it. Otherwise prompt for PIN + OTP and open a session. Cancel always asks for confirmation.

---

## 8. Data model

```
users(id, email, password_hash, is_admin, created_at, disabled_at)
hpc_profiles(user_id PK/FK, hku_uid, vpn_domain, ssh_pubkey NULL, ssh_privkey_kms NULL, host_keys_ok_at)
jobs(id, uuid, user_id FK, name, spec JSONB, upload_path, upload_sha256,
     status, slurm_job_id NULL, remote_dir NULL, exit_code NULL,
     webhook_key_hash NULL, created_at, submitted_at, started_at, ended_at, last_polled_at)
audit_log(id, user_id, action, job_id NULL, ip, user_agent, result, created_at)   -- never credentials
```

Job status enum: `DRAFT, SUBMITTING, SUBMIT_FAILED, SUBMITTED, PENDING, RUNNING, COMPLETED, FAILED, CANCELLED, TIMEOUT, OUT_OF_MEMORY, UNKNOWN`.

## 9. API

```
POST   /api/auth/login | /api/auth/logout
GET    /api/me
PUT    /api/me/hpc-profile
POST   /api/jobs                       multipart: file + spec JSON
GET    /api/jobs                       own jobs (admin: ?all=1)
GET    /api/jobs/{id}
POST   /api/jobs/{id}/submit           body: {pin, otp, hpc_password?}  → {op_id}
GET    /api/ops/{op_id}/events         SSE
POST   /api/jobs/{id}/refresh          body: {pin?, otp?}  (creds only if no live session)
GET    /api/jobs/{id}/log?stream=out|err
POST   /api/jobs/{id}/cancel           body: {pin?, otp?}
GET    /api/vpn/session                {state, expires_in} for current user
DELETE /api/vpn/session                close my tunnel now
POST   /api/hooks/jobs/{uuid}          webhook (HMAC)
GET    /api/healthz
```

Credential-bearing bodies: exclude them from all request logging, error reporting (Sentry `before_send` scrubber) and validation-error echoes. Pydantic errors must not echo the `pin` or `otp` values.

## 10. Config (`.env`, never committed; `.env.example` committed)

```
DATABASE_URL=postgresql+psycopg://...
SECRET_KEY=...
VPN_HOST=vpn2fa.hku.hk
HPC_SUBMIT_HOST=hpc2021.hku.hk
HPC_TRANSFER_HOST=hpc2021-io1.hku.hk
HPC_KNOWN_HOSTS=/config/known_hosts          # pinned, captured during M0
HPC_PARTITIONS=[...]                          # from M0 sinfo
HPC_MODULE_ALLOWLIST=[...]
VPN_IDLE_TTL_SECONDS=600
VPN_MAX_SESSIONS=10
SOCKS_PORT_RANGE=21000-21099
MAX_UPLOAD_MB=200
WEBHOOK_BASE_URL=https://<domain>/api/hooks/jobs   # empty = disabled
AWS_KMS_KEY_ID=                                # only for SSH-key mode
```

## 11. Deployment (EC2)

- Ubuntu 24.04, `t3.small` is enough. Prefer **ap-east-1 (Hong Kong)**, an opt-in region; M0 decides.
- Security group: 80/443 from anywhere (or the team's IP ranges). No public 22; use SSM Session Manager for admin access.
- Docker Compose services: `caddy`, `api` (python:3.12-slim + `openconnect ocproxy`), `postgres`. The `api` container runs as non-root, needs **no** `NET_ADMIN`, and sets `ulimit -c 0`.
- No swap on the host, or encrypted swap, to reduce credential exposure in memory.
- Backups: nightly `pg_dump` to S3. Upload retention 30 days.
- Log retention 30 days. CI greps logs for credential canaries (T4).

---

## 12. Fallback plans

### Plan B — Per-user pull agent (no VPN, no credentials on EC2)

Requires that login nodes have outbound HTTPS and that `scrontab` or `crontab` is allowed (M0 Q10).

- Each user runs a one-time setup **on their own HPC account**: `pip install --user hpcdash-agent && hpcdash-agent init --token <personal token from dashboard>`. This installs a `scrontab` entry (preferred; it runs as a tiny SLURM job) or a crontab entry that runs every minute.
- On each tick the agent: `GET /api/agent/pending` → download code bundle → `sbatch` → `POST /api/agent/report` with `squeue`/`sacct` results and log tails.
- Dashboard credentials: per-user agent tokens with scope `agent`, revocable, stored as hashes.
- Pros: no MFA relay, no credential handling, status updates arrive automatically. Cons: depends on HKU allowing cron/outbound, adds up to one minute of latency, and each user must do the setup.
- Reuse §6.2, §6.3, §8 and the status parsers. Replace §6.4 and §6.5 with `agent/` and the `/api/agent/*` endpoints.

### Plan C — Official HKU route

Ask HKU HPC (Appendix A) about Open OnDemand, `slurmrestd`, a group/service account for automation, or SSH whitelisting of an EC2 Elastic IP. If any exists, swap `HpcClient` for an adapter and keep the rest of the code.

Write `HpcClient` behind an interface (`HpcBackend` protocol) from the start so that B and C plug in.

---

## 13. Repo layout

```
/app
  main.py, config.py, db.py, security.py, logging.py (redaction filter)
  /api        routers: auth, jobs, ops, vpn, hooks, admin
  /gateway    session_manager.py, openconnect.py, ports.py, reaper.py
  /hpc        backend.py (protocol), ssh_backend.py, sbatch.py, parsers.py, templates/
  /jobs       service.py, validators.py, uploads.py
/web          React + Vite SPA
/migrations   Alembic
/spikes       vpn_spike.py, ssh_spike.py, M0 scripts
/tests
  /unit /integration /live /security /load
  /stack      docker-compose.test.yml, ocserv/, slurm/
/docs         feasibility-results.md, runbook.md, decisions.md
HANDOVER.md   (this file)
```

## 14. Milestones

| # | Deliverable | Exit criteria |
|---|---|---|
| **M0** | `spikes/` scripts + `docs/feasibility-results.md` answering §3 + ITS email sent | Human reviews results and picks A/B/C (§3 gate) |
| M1 | Repo skeleton, dashboard auth, DB, upload, spec validation, sbatch rendering (no HPC) | T1 green |
| M2 | Gateway against the mock stack | T2 gateway cases green |
| M3 | HPC client (SFTP, sbatch, sacct/squeue parse, scancel) | T2 HPC cases green |
| M4 | Submit flow + SSE + UI | T2 end-to-end green, Playwright happy path |
| M5 | Status, logs, cancel, session cache, webhook | T2 + T5 green |
| M6 | Security hardening | T4 green, no high findings |
| M7 | EC2 deploy, live tests, team UAT | T3 + T6 + T7 passed, runbook written |

---

## 15. Test plans

Several layers, from cheapest to most realistic. **Only T0 and T3 touch real HKU systems, and both need a human present to type the OTP.** CI runs T1, T2, T4 (automated part), T5 and T6.

### T0 — Feasibility spike (manual, real HKU, one volunteer, ~2 h)

Run from (a) a laptop off-campus, (b) EC2 in ap-east-1, (c) EC2 in ap-southeast-1. Record exact commands, stdout/stderr (**with credentials redacted**) and timings.

| ID | Test | Pass / record |
|---|---|---|
| S1 | `printf '%s\n%s\n' "$PIN" "$OTP" \| openconnect --protocol=anyconnect --authenticate --user=UID@hku.hk --passwd-on-stdin vpn2fa.hku.hk` (read PIN with `read -s`, never put it in shell history) | prints `COOKIE=`; note prompt names and form fields |
| S2 | S1 from EC2 HK and EC2 SG | works? any Entra sign-in alert email? |
| S3 | Connect with cookie + `--script-tun --script "ocproxy -D 21000"`; `curl --socks5-hostname 127.0.0.1:21000 -v telnet://hpc2021.hku.hk:22` | SSH banner received; DNS resolved through tunnel |
| S4 | `ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:21000 %h %p' UID@hpc2021.hku.hk` | login with PIN works; capture host keys (`ssh-keyscan` through proxy) |
| S5 | Add a test pubkey to `authorized_keys`, retry with `-o PreferredAuthentications=publickey` | key auth allowed? |
| S6 | SFTP a file to `hpc2021-io1`, `ls` it from `hpc2021` | same `$HOME`? |
| S7 | `sinfo -s`, `sbatch` hello-world, `squeue`, `sacct`, `scancel`; GPU job with `nvidia-smi` | partitions, gres syntax, `sacct` works |
| S8 | Inside a job: `curl -sS -m 10 https://example.com` | compute-node outbound? |
| S9 | On login node: same curl; `scrontab -l`; `crontab -l` | Plan B viable? |
| S10 | Leave tunnel idle and log when it drops; separately keep it busy | idle timeout and max session length |
| S11 | Two different volunteers, simultaneous tunnels from the same EC2 | both stay up? |
| S12 | Same user, second auth while first tunnel is up | first session kicked? |
| S13 | Reuse one OTP for a second `--authenticate` within 30 s (**once only**) | accepted or rejected |
| S14 | One deliberately wrong OTP (**once only, never probe lockout limits**) | error text for the parser |
| S15 | `#SBATCH --mail-type=END` job | email arrives? |

### T1 — Unit tests (CI, fast, no network)

- **Validators:** every field in §6.2, with property-based tests (hypothesis) that throw shell metacharacters, newlines, unicode and `$(...)` at every string field. The rendered script must never contain an unquoted user string.
- **sbatch rendering:** golden files for CPU, GPU, conda, modules, env and webhook variants.
- **Zip safety:** zip-slip, absolute paths, symlinks, zip bomb, too many entries.
- **Parsers:** `sacct`/`squeue` fixtures, including `.batch`/`.extern` steps, array jobs, `CANCELLED by 123`, `OUT_OF_MEMORY`, `TIMEOUT`, empty output and unknown states. openconnect output fixtures from M0 (success, bad PIN, bad OTP, server error).
- **Gateway state machine** with a fake subprocess: timeouts, early exit, port exhaustion, idle reaping, global cap, no automatic retry after an auth failure.
- **Redaction:** emit logs and exceptions containing canary values `PIN_CANARY_7f3a` and `OTP_CANARY_918273`; assert they never appear in captured logs, Sentry payloads or HTTP error bodies.
- **Lockout guard:** the 4th attempt within 15 min is blocked.
- **AuthZ:** user A gets 404 on B's job for every job endpoint.

### T2 — Integration on a mock HKU stack (CI, docker compose)

`tests/stack/docker-compose.test.yml` builds a fake HKU:

```
network "internet":  api-under-test, ocserv
network "campus":    ocserv, slurm-login (sshd), slurmctld, slurmd x2   (internal: true)
```

- **ocserv** emulates `vpn2fa.hku.hk`: AnyConnect protocol, `auth = "plain[passwd=...,otp=/etc/ocserv/users.oath]"` for password + TOTP. Test users' TOTP seeds live in fixtures; tests generate OTPs with `pyotp`. **TOTP seeds exist only for these fake users, never for real HKU accounts.**
- **SLURM:** based on `giovtorres/slurm-docker-cluster`, plus sshd on the login container, with shared `/home`.
- The isolation check is itself a test: a direct TCP connection from `api` to `slurm-login:22` must **fail**, so every success must go through the tunnel.

| ID | Case | Expect |
|---|---|---|
| I1 | Happy path: upload → submit → RUNNING → COMPLETED → log tail | statuses in order, log contains script output |
| I2 | Wrong password | `AuthFailed(bad_credentials)`, no retry, no openconnect child left |
| I3 | Wrong OTP | `AuthFailed(bad_otp)` |
| I4 | Reused OTP (if ocserv rejects reuse) | clean error |
| I5 | Kill ocserv mid-upload | `SUBMIT_FAILED`, session dead, port released |
| I6 | sshd down on login node | clear error, tunnel closed |
| I7 | Invalid partition (bypassing UI validation) | sbatch error surfaced to user |
| I8 | Session reuse: refresh within TTL | no new auth call |
| I9 | TTL expiry: refresh after TTL | creds requested again |
| I10 | Cancel running job | `CANCELLED` |
| I11 | Two users submit at once | separate ports; each job owned by the correct SLURM user |
| I12 | Global cap reached | 429 |
| I13 | Host key mismatch (swap login container key) | connection refused by `RejectPolicy` |
| I14 | Webhook start/end with valid and invalid HMAC | valid → state change; invalid → 403 and no change |
| I15 | API restart with live tunnels | no orphan openconnect/ocproxy processes; jobs keep last-known state |

### T3 — Live E2E on real HKU (manual, gated)

- `pytest -m hku_live`. Requires `HKU_LIVE=1` and prompts in the terminal for PIN/OTP with `getpass`. **Never in CI.** Skipped by default.
- Cases: L1 CPU hello world; L2 GPU smoke (`nvidia-smi`, `torch.cuda.is_available()`); L3 small real training (MNIST, 1 epoch) with log tail; L4 cancel; L5 a failing script shows `FAILED` and the stderr tail; L6 two team members submit concurrently; L7 refresh after the tunnel expired.

### T4 — Security tests

| ID | Check |
|---|---|
| T4-1 | Credential canaries absent from the DB dump, all logs, `/data`, and Postgres WAL after a full T2 run |
| T4-2 | Canaries absent from `/proc/*/cmdline` and `/proc/*/environ` of all children during auth |
| T4-3 | Core dumps disabled (`ulimit -c` = 0 in the container) |
| T4-4 | TLS: HTTPS only, HSTS, plain HTTP redirects |
| T4-5 | CSRF enforced; cookies `Secure/HttpOnly/SameSite=Strict` |
| T4-6 | IDOR sweep across all job endpoints for two users |
| T4-7 | Injection fuzzing of job spec → rendered sbatch (hypothesis, 10k examples) |
| T4-8 | Upload abuse: oversize, zip bomb, zip-slip, wrong extension |
| T4-9 | Rate limits on login and submit |
| T4-10 | `pip-audit`, `npm audit`, OWASP ZAP baseline scan against staging |

### T5 — Failure and resilience

Run on the T2 stack with fault injection: network partition between `api` and `ocserv` (`tc netem` / `docker network disconnect`), slow VPN (2 s latency), full disk on `/data`, Postgres restart, SLURM controller down (`squeue` fails → status `UNKNOWN`, no crash), and a reaper test (kill `-9` the API → restart → zero orphan processes).

### T6 — Load and concurrency

On the T2 stack: 10 simultaneous submits by 10 users, then 50 refreshes per minute for 10 minutes. Record memory per tunnel, p95 submit time (target under 60 s against the mock) and port pool behavior. Assert that the SSH username always matches the tunnel owner, so there is no cross-user tunnel reuse.

### T7 — User acceptance (team)

Checklist for 3+ team members on production: submit a real training job; find its logs; cancel one job; recover from a mistyped OTP; understand the "session expires in N min" indicator; submit from mobile. Collect friction notes into `docs/uat.md`. Target: every member completes a first submission without help in under 5 minutes.

---

## 16. Rules for Claude Code

1. **Never** store, generate or automate OTPs or TOTP seeds for real HKU accounts. Fake ocserv users in `tests/stack` are the only exception.
2. **Never** write credentials to disk, the DB, logs, argv, env vars, queues or exception messages. Add a T1 redaction test for any new code path that touches credentials.
3. **Never** run anything against `*.hku.hk` without a human present. Live tests stay behind `-m hku_live` and `HKU_LIVE=1`.
4. **Never** auto-retry VPN or SSH authentication.
5. Keep the API at a **single uvicorn worker** while the gateway is in-process. If scaling is ever needed, move the gateway to its own process behind a Unix socket. Do not introduce a broker for credential-bearing work.
6. Build behind the `HpcBackend` protocol so Plan B or C can replace the SSH backend.
7. M0 is a hard gate. Do not start M2+ until `docs/feasibility-results.md` exists and the human has picked a plan.
8. Record notable decisions in `docs/decisions.md` (date, decision, why).

---

## Appendix A — Draft email to HKU HPC / ITS

> To: HPC support (via ITS Service Desk, ithelp@hku.hk)
> Subject: Automated SLURM job submission to HPC2021 from an external research dashboard
>
> Hello,
>
> Our research team (PI: ___, Dept: ___) is building a small internal web dashboard so team members can submit SLURM training jobs to HPC2021. The dashboard is hosted on AWS (Hong Kong region). We'd like to confirm the approved way to do this:
>
> 1. Is it acceptable for each user to enter their own UID, PIN and MFA code into our dashboard, which would then open a short-lived HKUVPN session on their behalf to run `sbatch` (credentials are never stored)?
> 2. Alternatively, does HPC2021 offer Open OnDemand, the SLURM REST API, a service/group account for automation, or SSH access whitelisted for a fixed IP?
> 3. Are `scrontab`/`crontab` and outbound HTTPS permitted from the login nodes?
> 4. Do compute nodes have outbound internet access?
>
> Thank you,
> ___

## Appendix B — Sources

- HKUVPN MFA for Linux: https://its.hku.hk/kb/setup-procedure-of-hkuvpn-with-multi-factor-authentication-mfa-for-linux/
- HPC login and file transfer guide: https://hpc.hku.hk/guide/ssh-login-and-file-transfer-guide/
- HPC2021 user guide: https://hpc.hku.hk/hpc/hpc2021/userguide/
- ITS SSH and secure file transfer: https://its.hku.hk/kb/ssh-and-secure-file-transfer/
