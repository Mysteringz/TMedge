#!/usr/bin/env bash
# Run as root on EC2 from a reviewed copy of deploy/, with a public key file.
# Installs infrastructure only; never restarts the application or tunnel.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${1:?public key file required}"
ssh-keygen -l -f "$KEY" >/dev/null
id tmedge-ci >/dev/null 2>&1 || useradd --create-home --shell /bin/bash tmedge-ci
install -d -m 755 -o root -g root /opt/tmedge-deploy
for file in remote.sh release.py ci-receiver.py; do
  install -m 755 -o root -g root "$HERE/$file" "/opt/tmedge-deploy/$file"
done
install -d -m 700 -o tmedge-ci -g tmedge-ci /home/tmedge-ci/.ssh
# Re-running rotates the one dedicated key; the personal admin key is untouched.
printf 'restrict,command="sudo -n /opt/tmedge-deploy/ci-receiver.py \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$(cat "$KEY")" > /home/tmedge-ci/.ssh/authorized_keys
chown tmedge-ci:tmedge-ci /home/tmedge-ci/.ssh/authorized_keys
chmod 600 /home/tmedge-ci/.ssh/authorized_keys
staged="$(mktemp)"
trap 'rm -f "$staged"' EXIT
printf 'tmedge-ci ALL=(root) NOPASSWD: /opt/tmedge-deploy/ci-receiver.py *\n' > "$staged"
visudo -cf "$staged"
install -m 440 -o root -g root "$staged" /etc/sudoers.d/tmedge-ci
# The handover identifies this release as overwritten in place. Keep evidence,
# but exclude it from automatic rollback selection and retention operations.
legacy=/opt/tmedge-releases/20260924T184336Z-6a789c4fa4-dirty
if [ -d "$legacy" ] && [ "$(readlink /opt/tmedge)" != "$legacy" ]; then
  printf 'Overwritten outside deployment pipeline on 2026-09-25; see HANDOVER.md\n' > "$legacy/QUARANTINED"
fi
printf 'Receiver installed; application services were not restarted.\n'
