# A fake HKU for module 02's Plan A tests (HANDOVER.md T2): an AnyConnect
# VPN asking for password + TOTP like vpn2fa.hku.hk, DNS that only answers
# inside the tunnel, and an HPC login node (sshd + fake SLURM) reachable only
# through it. Test identities and TOTP seeds are fake; nothing here is HKU's.
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ocserv openssh-server dnsmasq gnutls-bin openssl python3 python-is-python3 procps iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /var/lib/fakeslurm && chmod 1777 /var/lib/fakeslurm \
    && echo 4100 > /var/lib/fakeslurm/next && touch /var/lib/fakeslurm/lock && chmod 666 /var/lib/fakeslurm/next /var/lib/fakeslurm/lock
COPY fake-slurm/ /usr/local/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /usr/local/bin/* /entrypoint.sh
EXPOSE 4443
ENTRYPOINT ["/entrypoint.sh"]
