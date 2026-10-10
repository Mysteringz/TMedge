# Secure device adoption and TMflash account sign-in

## Operator flow

In TMflash set Console URL to `https://algo.hkumyseat.com` and click **Sign in
with algo account**. Complete the existing browser verification; the console
automatically returns its one-use code to the initiating TMflash session. If
the browser keeps the return page open, click **Return to TMflash**. A failed
authorization shows **Retry connection**; an expired fallback obtains a fresh
code. Select 1, 2 or 4 fps, flash, then compare the USB board UID and request
code in **Adoption**. Type both to approve. The board stays unplaced; its first
fresh authenticated report changes verification to **Verified reports**.
Direct WSS setup also requires a fresh report ACK from the rebooted board.

A 24-hour account session authorizes only preflight, pending requests and
status. It cannot approve, access imagery, place devices or operate the
console. The one-use login code lasts sixty seconds and is bound to the Mac's
private PKCE verifier. The callback state and scheme are checked. Passwords
stay in browser sign-in. Sessions stay in Keychain; only digests and account
bindings persist on the server in mode-0600 files under DATA_DIR.

Logout, Adoption revocation, expiry, account removal or password changes end
access. Registered boards authenticate independently with their telemetry
keys. When DEVICE_KEYS_FILE is enabled, enrol the physical key first: approval
cannot admit an identity with no permitted authentication key. This change
preserves the existing sensor protocol and does not migrate legacy keys.

## Cloudflare

Keep the current human Access policy for the main algo application, including
`/tmflash/connect`, `/api/tmflash/authorize`, `/adoption`, `/api/adoption` and
`/console-app/*`. Configure separate path-specific Access applications with
Bypass / Include Everyone only for:

- `algo.hkumyseat.com/api/provision/*`
- `algo.hkumyseat.com/api/tmflash/exchange`
- `algo.hkumyseat.com/api/tmflash/logout`

These paths are independently protected by TMedge account-session or PKCE
verification. Remove the old provisioning Service Auth policy for the same
path so it cannot require a service token. Cloudflare's more-specific
application path takes precedence over the main application. If a WAF browser
signature rule still blocks the native app, narrow its exception to these
machine paths; browser challenges cannot be completed by URLSession.

References: [path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[endpoint exceptions](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

## Prepare file-mode production storage

The live server must retain registrations across releases and allow atomic
writes. The current production systemd sandbox permits `/var/lib/tmedge`.
Use a private adoption directory there instead of granting write access to
`/opt/tmedge-shared`, which holds environment secrets.

Review `deploy/prepare-adoption-storage.py`, transfer that exact reviewed file
to an administrator scratch location and run on EC2:

```sh
sudo python3 /tmp/prepare-adoption-storage.py \
  --env /opt/tmedge-shared/.env --release /opt/tmedge
# Inspect the dry run, then apply the same command with --apply.
```

It preserves the live registry byte for byte, makes private storage owned by
the DATA_DIR owner, creates a private environment backup, and sets only
NODES_CONFIG. It refuses existing adoption storage, an existing NODES_CONFIG,
invalid identities, release-local data or PostgreSQL mode. It never prints
secrets and never restarts services. The next normal approved artifact release
loads the new path. Do not overwrite another operator's existing registry.

Rollback code through the normal release workflow. Retain the persistent
registry during rollback so admitted identities survive. The private `.env`
backup is for administrator recovery; restoring it deliberately switches the
registry source back and must be reviewed if new devices were adopted.

## Release and verification

Required CI checks run before merge. Main CI produces the exact artifact;
GitHub production approval is required before deployment. Do not copy dirty
code into the live release or bypass that approval.

Public verification after release/configuration:

1. Unauthenticated preflight → JSON 401; exchange with invalid code → JSON
   401; no browser redirect, HTML page or Cloudflare refusal.
2. Human authorize and Adoption remain inaccessible without algo sign-in.
3. Start sign-in from the built TMflash.app and complete browser verification.
   The popup returns automatically, without a second authorization click.
   Test → **Console access is verified. Adoption is ready.**
4. Request a real new device, match/approve UID and request code, verify its
   authenticated report/ACK, then restart through the supported deployment
   flow and confirm registration survived.
5. Sign out/revoke → preflight refuses; changing/removing the account also
   invalidates its sessions. Silent nodes remain unknown.

Local regressions cover those account and approval boundaries, private durable
stores, 60-second code expiry, native response validation, encrypted firmware
report/ACK, and Chromium/WebKit phone layouts in both appearance settings.
