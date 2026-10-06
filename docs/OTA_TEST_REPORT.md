# M3 OTA verification — 2026-10-04

Result: PASS on real M3 hardware through the live TMedge console API over the direct WSS/HTTPS transport.

- Node: Above M3, `30:ed:a0:cb:f5:f8`.
- Live TMedge release: `20261004T100403Z-4ff2098f872c`.
- TMsense source: `352750b049603444278b04cd4a154b6838825b2b`, clean working tree.
- Uploaded 35 tracked release source files through `/console-app/api/firmware/uploads`; built with `tmflash` on EC2.
- Image: `tmsense-1.5`, 964064 bytes.
- SHA-256: `eb8ed8284e787b5da6519d0025849d7a22ee7ea9b2159835180b6d3ce81b8524`.
- Rollout: `roll-mutpnuhq`, target M3 only.
- 11:01:42 UTC: rollout started.
- 11:01:45 UTC: authenticated firmware download logged.
- 11:01:57 UTC poll: rebooting, 100%.
- 11:02:02 UTC: node reauthenticated.
- 11:02:03 UTC: firmware confirmed; rollout done, 1 of 1.
- Boot counter 60 → 61; same firmware version reinstalled with a newly built image.
- Post-reboot: online, accepted REPORT ACKs, zero sensor errors and rejected packets; detector settings and Wi-Fi retained.

Access: SSH to EC2 using the supplied PEM; short-lived local API session issued using the existing server session code and credentials. Credentials stayed on EC2 and were not printed. No authentication settings, accounts, services, or repository source files changed. The new firmware image remains available in the console.

Earlier local validation: 43 relevant TMedge tests; 19 crosschecks, including 104 firmware transport assertions, passed.

Scope: console API upload/build → live direct-cloud download → flash/reboot → health confirmation. Browser file-picker interaction, gateway/UDP hardware OTA, deliberate failure/rollback, and power-loss recovery were not tested.
