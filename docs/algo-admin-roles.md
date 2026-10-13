# Algo admin roles

Viewer accounts can read operational state and their own training files/jobs. Operators can change algorithm parameters, use routine sensor controls and run their own training/HPC sessions. Engineers additionally control firmware, provisioning and advanced/security commands. Named Admins alone manage and delete accounts. Admin authority does not grant access to another user's jobs or HPC credentials.

Existing account files normalize missing roles to engineer. Existing explicit and roleless legacy Engineers intentionally gain all operational controls; they remain Engineers. No existing account becomes an admin automatically. Assign Operator explicitly for narrower operational access. Role changes, disabling, password reset and revoke-all increment the account session version; previous cookies stop working. Open feeds and terminals recheck authority within five seconds. New HTTP requests and terminal input check immediately. Submitted remote jobs continue running.

A legacy JSON record with no `role` key remains an Engineer. An explicit empty string (`"role": ""`) or null is invalid and fails the entire account file closed; it is not treated as a legacy role. Before rollout, confirm the file is valid and explicitly assign `operator` to people who should retain narrower access. Bootstrap an identified Admin with the local CLI rather than automatically promoting legacy users.

Device Adoption reads remain available to signed-in accounts. Issuing/revoking TMflash access, approving/denying physical devices, and authorizing a native TMflash sign-in require Engineer or Admin. Native provisioning credentials recheck the enabled account epoch and this capability; demotion, revoke-all, password reset, deletion or same-name recreation invalidates prior credentials.

Location configuration is available to named Admin and Operator accounts through the dedicated `locations.manage` capability. Engineers and Viewers do not receive it, even though Engineers retain their separate firmware and provisioning capabilities. Published locations are visible in the manager; each account sees and edits only its own private drafts and previews.

See the [location management OpenAPI contract](location-management.openapi.yaml) for the console API, edge model transfer and student model response requirements.

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

## Team roles

Separately from the access roles above, an account can carry team roles: ML, front-end, back-end, firmware, hardware. An Admin sets them on the Accounts page. They are labels the team uses to find and assign each other; they are shown in the landing page's mailbox, task assignment and search. They grant no capability, are not consulted by any permission check, and changing them does not increment the session version or end a session. A legacy record with no `teamRoles` key has none; a value outside the list fails the account file closed, like an invalid role.

## A person's own account

Every role has **Account settings** (`/account`), opened from the account icon at the right of the header. That icon is also where the username, the access role and **Sign out** now live; the header no longer spells the name out. `/api/account` serves the page, acts only on the account the session belongs to, and takes no username in any route or body.

- **Profile**: username, access role, team roles, creation date. Read-only; an Admin sets them on the Accounts page.
- **Email notifications**: one address and what it should hear about (sensors, training jobs, firmware, live parameter changes, team mail, tasks). Stored in `account-settings.json` beside the account file, mode 0600. The address is the owner's alone: no Admin route, team list or Ask AI prompt carries it. It is bound to the account's creation time, so a reused username does not inherit it, and it is dropped at the next save once its account no longer exists. An address is **confirmed** before anything is sent to it: `POST /api/account/email-codes` emails a six-digit code (30 minutes, five tries, three codes per quarter hour) and `POST /api/account/email-confirmations` takes it back; a changed address is unconfirmed again. What is then sent, and how often, is in [EMAIL.md](EMAIL.md). On a server with no mail service the API reports `emailDelivery: false`, and the page says the address is kept and nothing is sent.
- **Password**: needs the current password, at least 12 characters, and a different one. It ends every session of the account and any TMflash app session; the browser it was changed from is given a new session so it carries on. Five tries of the current password per five minutes.
- **Sessions**: **Sign out everywhere** ends every session of the account, that browser's included.

With sign-in off (local mode) there is no account, so the page shows the local operator and nothing to save. Every write needs the `x-tm-algo` header and a same-origin request, like the rest of the console.
