# M0: the feasibility spike, before any job reaches HKU

The team chose Plan A on 2026-10-06 before M0 had run (decisions.md). M0's
questions still need answers, and the first real logins answer S1–S4:
`npm run hpc-hostkeys` on the box (plan-a-runbook.md) is S1–S4 with a person
present. Record what you see in `feasibility-results.md`.

- **Who:** one volunteer with an HKU account, with a person present the whole
  time.
- **Duration:** about two hours.
- **Where results go:** write them in **`docs/hpc/feasibility-results.md`**.
  Create that file only when there are results: its existence is the signal
  rule 7 waits for. Redact every credential.

**The cluster is `ing@10.21.36.12`**, not HPC2021 (decisions.md #21).
Wherever this list says `hpc2021.hku.hk`, read `10.21.36.12`. HKUVPN
(`vpn2fa.hku.hk`) is unchanged.

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

## Added by Plan A: one IP for everyone

Every dashboard user reaches `vpn2fa.hku.hk` from the EC2 box's single IP.
A local stand-in for the VPN (ocserv) refuses an IP for minutes after a
failed login, which would let one person's typo lock out every user. The
dashboard's own guard stops each person after 3 failures, but it cannot
change what HKU does. Record:

- [ ] After one deliberate wrong code (S14), can a *different* person log in
      from the same EC2 IP straight away?
- [ ] Do two people logging in within the same minute both succeed (S11)?

If HKU throttles per IP, tell the team to type their code carefully, and
consider Plan B or C (an IP allow-list, §12).

## Also decide at M0

- **The gateway host.** The live box is Amazon Linux 2023 in ap-southeast-1
  (decisions.md #12). Can openconnect and ocproxy be installed there, and does
  authentication work from that IP?
- **Policy (§3 Q12).** Send the Appendix A email. If HKU says no to
  credential relay, Plan A is dead.
- **The plan:** A, B or C. Record the choice in decisions.md.
