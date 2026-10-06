# M0: the feasibility spike, before any job reaches HKU

M0 is a hard gate (HANDOVER.md §3, §14, rule 7). Until it has run, module 02
saves drafts and renders their `job.sbatch` but submits nothing.

- **Who:** one volunteer with an HKU account, with a person present the whole
  time.
- **Duration:** about two hours.
- **Where results go:** write them in **`docs/hpc/feasibility-results.md`**.
  Create that file only when there are results: its existence is the signal
  rule 7 waits for. Redact every credential.

## Rules for the session

- Never put the PIN in shell history or argv. Read it with `read -s`.
- Never automate or store an OTP. Use one OTP per attempt, typed by the person.
- Make exactly **one** deliberate wrong-OTP attempt (S14) and **one**
  OTP-reuse attempt (S13). Never probe lockout limits.
- Never retry authentication automatically.

## The tests (HANDOVER.md T0, run from a laptop off campus, EC2 ap-east-1, EC2 ap-southeast-1)

| ID | Do | Record |
|---|---|---|
| S1 | `printf '%s\n%s\n' "$PIN" "$OTP" \| openconnect --protocol=anyconnect --authenticate --user=UID@hku.hk --passwd-on-stdin vpn2fa.hku.hk` | `COOKIE=` printed? Prompt names and form fields |
| S2 | S1 from each EC2 region | Works? Any Entra "unusual sign-in" email? |
| S3 | Connect with the cookie and `--script-tun --script "ocproxy -D 21000"`, then `curl --socks5-hostname 127.0.0.1:21000 -v telnet://hpc2021.hku.hk:22` | SSH banner; DNS resolved inside the tunnel |
| S4 | `ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:21000 %h %p' UID@hpc2021.hku.hk`; `ssh-keyscan` through the proxy | PIN works for SSH; host keys to pin |
| S5 | Add a test public key to `authorized_keys`, then log in with `-o PreferredAuthentications=publickey` | Key auth allowed? |
| S6 | SFTP a file to `hpc2021-io1`, `ls` it from `hpc2021` | Same `$HOME`? |
| S7 | `sinfo -s`, an sbatch hello world, `squeue`, `sacct`, `scancel`; a GPU job running `nvidia-smi` | Partitions, max times, `--gres` syntax, `module avail` |
| S8 | `curl -sS -m 10 https://example.com` inside a job | Outbound HTTPS from compute nodes (webhook) |
| S9 | The same curl on a login node; `scrontab -l`; `crontab -l` | Plan B viable? |
| S10 | Leave the tunnel idle; separately, keep it busy | Idle timeout, maximum session length |
| S11 | Two volunteers, simultaneous tunnels from one EC2 IP | Both stay up? |
| S12 | Same user authenticates again while the first tunnel is up | First session kicked? |
| S13 | Reuse one OTP within 30 s (**once**) | Accepted or rejected |
| S14 | One wrong OTP (**once**) | Error text, for the parser |
| S15 | A job with `#SBATCH --mail-type=END` | Does the email arrive? |

## Added by M1: checks for the script module 02 renders

Submit `test/golden/train/conda.sbatch` (from a scratch directory that has a
`code/train.py`) with `cd <dir> && sbatch --parsable job.sbatch`, over a
**non-interactive** SSH session the way a backend would, and record:

- [ ] Does `module` exist in the job? Non-login batch shells sometimes lack it.
      If it doesn't, the shebang becomes `#!/bin/bash -l` (one line in
      `src/algo/train/sbatch.ts` plus the goldens).
- [ ] Do `module purge`, `module load`, and `source …/conda.sh` +
      `conda activate` succeed (they run under `set +u`)?
- [ ] Do the relative `--output=slurm-%j.out` / `--error` land in the
      submit directory?
- [ ] Is `srun python …` the right launcher for a single-task job, or should it
      be plain `python`?
- [ ] What is the exact GPU request syntax (`--gres=gpu:N`,
      `--gres=gpu:<type>:N`, or `--gpus`)?

Then update `config/hpc.json`:

- set `partitions` (name, `maxTime`, `gpu`, `maxGpus`) from `sinfo`;
- set `modules` from `module avail`;
- set `"verified": true`.

The "placeholders · M0" tag on the JOB SPEC card disappears once `verified`
is true.

## Also decide at M0

- **The gateway host.** The live box is Amazon Linux 2023 in ap-southeast-1
  (decisions.md #12). Can openconnect and ocproxy be installed there, and does
  authentication work from that IP?
- **Policy (§3 Q12).** Send the Appendix A email. If HKU says no to
  credential relay, Plan A is dead.
- **The plan:** A, B or C. Record the choice in decisions.md.
