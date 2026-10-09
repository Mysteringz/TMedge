# Algo admin roles

Viewer accounts can read operational state and their own training files/jobs. Engineers can change algorithm parameters and run their own training/HPC sessions. Admins additionally control firmware, provisioning and security commands. Admin authority does not grant access to another user's jobs or HPC credentials.

Existing account files normalize missing roles to engineer. No existing account becomes an admin automatically. Role changes, disabling, password reset and revoke-all increment the account session version; previous cookies stop working. Open feeds and terminals recheck authority within five seconds. New HTTP requests and terminal input check immediately. Submitted remote jobs continue running.

Build the tools in the release directory with `npm run build`. Tools use the release's `.env`, `ALGO_USERS_FILE`, or `DATA_DIR/algo/users.json`. Passwords are entered through the existing terminal prompt or stdin, never command-line arguments.

For an empty store, explicitly create the first admin:

```sh
npm run algo-user -- add operator admin
```

For an existing store, explicitly promote an existing account:

```sh
npm run algo-user -- role operator admin
```

Create other accounts with `add NAME viewer`, `add NAME engineer`, or `add NAME admin`. Unqualified `add NAME` defaults to engineer. Duplicate creation is refused; use `reset-password NAME` for credential changes. `role NAME ROLE` changes a role; `remove NAME` retains its existing local CLI meaning. Every supported writer refuses removal, disabling or demotion of the final enabled explicit admin. Set up a second admin before removing or demoting the first.

Local trusted mode without `ADMIN_PASSWORD` retains operational admin access on the existing localhost-only listener and displays Local operator. It cannot manage named accounts through HTTP. Standalone Basic console remains an explicit legacy operator; the moved console listener remains closed to human API/socket access. Student and device credentials do not grant algo privileges.

Raw node command engineer allowlist: `set` for the existing validated detector parameters, `reset-bg`, `identify`, `save`. `reboot`, reset-cursor, firmware and provisioning require admin. Unsupported/raw numeric commands remain rejected by the existing validator. This change adds no pipeline features or activity-log system.
