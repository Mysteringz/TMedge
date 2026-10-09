# Plan A on the live box: runbook

Module 02 sends jobs to the cluster at `ing@10.21.36.12` (SLURM). Each
person signs in to HKUVPN with their own UID, PIN and code; SSH then logs in
as the shared `ing` account, whose password everyone types at each sign-in
and of which only a fingerprint is kept. The design is in
[decisions.md](decisions.md) (#13–#23), the spec in
[HANDOVER.md](HANDOVER.md). This page covers operating it on the EC2 box.

## What has to be on the box

| Piece | Where | Why |
|---|---|---|
| `openconnect` | `/usr/local/sbin/openconnect` | Logs in to `vpn2fa.hku.hk`. Amazon Linux 2023 does not package it; it is built from source in an `amazonlinux:2023` container. |
| `ocproxy` | `/usr/local/bin/ocproxy` | Turns each person's tunnel into a SOCKS port on 127.0.0.1. No root, no tun device, no route changes. |
| `LimitCORE=0` | `/etc/systemd/system/tmedge-edge.service.d/no-core.conf` | A crash during a login must not write memory (and a PIN) to disk. |
| Pinned host keys | `/var/lib/tmedge/algo/train/known_hosts` | ssh refuses the cluster until its keys are pinned. |
| Password fingerprint | `/var/lib/tmedge/algo/train/ssh-password.json` | Sign-ins are checked against it; without it nothing can be sent. Never in git. |

The console says which piece is missing ("NOT READY" next to *hku*, with the
reason under the editor), so check there first.

## First use: nothing to do on the box

The first person to sign in sets things up from the dashboard
(**02 ML Training → CONSOLE → ssh**, or **SEND JOB TO TRAIN**):

1. They sign in with their UID, Portal PIN, a fresh code and the `ing` password.
2. Once their tunnel is up, the dashboard shows the cluster's host-key
   fingerprints. Compare one with `ssh-keygen -lF 10.21.36.12` on a machine
   that already logs in there, then **TRUST & CONTINUE**.
3. The cluster checks the `ing` password itself; if it is accepted, its
   fingerprint is kept, so every later sign-in is checked here first.

After a `passwd` on the cluster (the CONSOLE's ssh mode is a real shell),
the next sign-in ticks **The cluster password has changed**.

The two tools below do the same from the box, for an admin who prefers it.

## Setting the cluster password's fingerprint from the box (optional)

No network, no HKU login: only the `ing` password, typed twice and never shown.

```sh
ssh -i TMcloudkey.pem ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com
cd /opt/tmedge
sudo -u tmedge /usr/local/bin/node --env-file=/opt/tmedge/.env dist/src/tools/hpcpassword.js
```

When the password is changed on the cluster, run this again straight away:
until then sign-ins with the new password are refused here, and ones with
the old password are refused by the cluster.

## Pinning the cluster's host keys from the box (optional; needs your own HKU login)

```sh
ssh -i TMcloudkey.pem ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com
cd /opt/tmedge
sudo -u tmedge /usr/local/bin/node --env-file=/opt/tmedge/.env dist/src/tools/hpchostkeys.js
```

The tool asks for your UID, Portal PIN and a fresh code; none of it is shown
or stored. It opens your tunnel, asks `10.21.36.12` for its keys (no SSH
login: the `ing` password is not needed), logs off, and then shows the
fingerprints. Compare them with what a machine that already logs in there
trusts -- `ssh-keygen -lF 10.21.36.12` on it -- or with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the cluster itself,
before typing `yes`. A login failure
here counts toward the same HKU limits as any other, so type carefully.

This first run is also M0's S1–S4: it shows whether openconnect can log in to
`vpn2fa.hku.hk` from this box's IP with PIN + code on stdin. Write down what
it printed in `docs/hpc/feasibility-results.md`.

## The first job

The **New draft** button starts `synthetic_demo`, a small classifier trained
on generated data using only Python 3's standard library. No dataset,
packages, modules, conda environment or GPU are needed. The same script is
available at [example.py](../../algo-app/src/console/train/example.py) for
uploading to an existing dashboard.

Use the default partition, **1 CPU**, **1 GB**, **0 GPUs**, **0:02:00** and
arguments `--epochs 20 --samples 1000 --seed 42`; leave modules, conda and
environment empty. The log shows 20 epochs, validation loss and accuracy,
then `TMEDGE_EXAMPLE_OK`. These metrics describe the synthetic demo and do
not measure real seat occupancy. The Python 3 batch-launcher fix must be
deployed before sending this example through the dashboard on a node that
does not have `python`.

Sign in at algo.hkumyseat.com → **02 ML Training** → use the example or upload a script
→ **SEND JOB TO TRAIN** → UID, PIN, code, and the `ing` password. The console shows each step (VPN,
tunnel, SSH, upload, sbatch) and the SLURM job id. Then **REFRESH**,
**LOG** and **CANCEL JOB** work without a new code for 10 minutes.

## When it says…

| Message | Meaning |
|---|---|
| HKU did not accept the UID or PIN | One attempt was made and refused. Check the UID has no `@hku.hk`, and the PIN. |
| HKU accepted the PIN but not the one-time code | The code was wrong, or expired while being typed. Wait for a new one. |
| The HKU VPN asked for something this dashboard cannot answer | HKU wants Cisco host scan, SAML, or a group choice. If it is a group, set `planA.vpnAuthGroup` in `config/hpc.json`; otherwise this is an M0 finding against Plan A. |
| …host key is not the pinned one, or none is pinned yet | Pin the keys (above). If they were pinned and changed, find out why before re-pinning. |
| That is not the password for ing@10.21.36.12 | Checked on the box against the fingerprint; nothing was sent. If the password was changed, update the fingerprint (above). |
| The cluster did not accept the SSH password | The fingerprint matched but the cluster refused: the password changed there without `hpc-password` being run here. |
| Three HKU logins failed… | The dashboard's own 15-minute pause, protecting the HKU account. |
| sbatch refused the job: … | SLURM's own words: usually a partition or time limit. `config/hpc.json` partitions are placeholders until M0 S7. |

## Turning it off

Set `"backend": "none"` and remove `planA` in `config/hpc.json`, then deploy.
Drafts keep working. Live sessions end when the edge restarts.
To end every session at once without a deploy: `sudo systemctl restart tmedge-edge`.

## A job ID was returned, but the job never appears to run

A job ID means SLURM accepted the submission. Click **Refresh**, then read
**Log** and **Stderr**. The job card shows the scheduler's reason while the
job is queued and the time of the last check. Status polling ends with the
HKU session; sign in and refresh to get current information.

On `ing@10.21.36.12`, `sacct` reports **Slurm accounting storage is disabled**.
Completed jobs eventually disappear from `squeue`, so an old `PENDING`
record cannot establish that a job is still waiting. New batch scripts save
their exit code and elapsed seconds in the submit directory as
`.tmedge-exit-<SLURM id>`. Refresh uses this result when SLURM no longer has
the job. Older jobs without a result show `UNKNOWN` and point to their logs.
A hard kill can prevent the shell from writing a result; absent evidence
also remains `UNKNOWN`.

The batch launcher prefers the active environment's `python`, falls back to
`python3`, and explicitly runs one task. The old `occupancy_gbc` example
used by job 324 requires **pandas, scikit-learn and pyarrow**, plus a real parquet file with
`hour`, `weekday`, `temp_c`, `noise_db`, `wifi_clients` and `occupied`
columns. Its example `--data` path is not uploaded or provisioned by the
dashboard. Select an environment containing those packages and replace the
path with your dataset to use that old script. New drafts use the
self-contained synthetic example described above.
