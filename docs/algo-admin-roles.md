# Algo admin roles

Viewer accounts can read operational state and their own training files/jobs. Operators can change algorithm parameters, use routine sensor controls and run their own training/HPC sessions. Engineers additionally control firmware, provisioning and advanced/security commands. Named Admins alone manage and delete accounts. Admin authority does not grant access to another user's jobs or HPC credentials.

Existing account files normalize missing roles to engineer. Existing explicit and roleless legacy Engineers intentionally gain all operational controls; they remain Engineers. No existing account becomes an admin automatically. Assign Operator explicitly for narrower operational access. Role changes, disabling, password reset and revoke-all increment the account session version; previous cookies stop working. Open feeds and terminals recheck authority within five seconds. New HTTP requests and terminal input check immediately. Submitted remote jobs continue running.

A legacy JSON record with no `role` key remains an Engineer. An explicit empty string (`"role": ""`) or null is invalid and fails the entire account file closed; it is not treated as a legacy role. Before rollout, confirm the file is valid and explicitly assign `operator` to people who should retain narrower access. Bootstrap an identified Admin with the local CLI rather than automatically promoting legacy users.

Device Adoption reads remain available to signed-in accounts. Issuing/revoking TMflash access, approving/denying physical devices, and authorizing a native TMflash sign-in require Engineer or Admin. Native provisioning credentials recheck the enabled account epoch and this capability; demotion, revoke-all, password reset, deletion or same-name recreation invalidates prior credentials.

Build the tools in the release directory with `npm run build`. Tools use the release's `.env`, `ALGO_USERS_FILE`, or `DATA_DIR/algo/users.json`. Passwords are entered through the existing terminal prompt or stdin, never command-line arguments.

For an empty store, explicitly create the first admin:

```sh
npm run algo-user -- add operator admin
```

For an existing store, explicitly promote an existing account:

```sh
npm run algo-user -- role operator admin
```

Create other accounts with `add NAME viewer`, `add NAME operator`, `add NAME engineer`, or `add NAME admin`. Unqualified `add NAME` defaults to operator. Duplicate creation is refused; use `reset-password NAME` for credential changes. `role NAME ROLE` changes a role; `remove NAME` retains its existing local CLI meaning. Every supported writer refuses removal, disabling or demotion of the final enabled explicit admin. Set up a second admin before removing or demoting the first.

Local trusted mode without `ADMIN_PASSWORD` retains operational admin access on the existing localhost-only listener and displays Local operator. It cannot manage named accounts through HTTP. Standalone Basic console remains an explicit legacy operator; the moved console listener remains closed to human API/socket access. Student and device credentials do not grant algo privileges.

Raw node command Operator allowlist: `set` for the existing validated detector parameters, `reset-bg`, `identify`, `save`. `reboot`, reset-cursor, firmware and provisioning require Engineer or Admin. Unsupported/raw numeric commands remain rejected by the existing validator. This change adds no pipeline features or activity-log system.

Account deletion requires a current revision and another enabled Admin when deleting an Admin. It revokes live access without cancelling jobs or deleting operational history. Reusing a username can expose retained username-owned jobs/profile history, but fresh cryptographic account material prevents old cookies or live HPC credentials/tickets from becoming valid again.
