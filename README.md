# TMedge

TMedge turns thermal sensor reports into live seat availability for HKUMySeat. It includes occupancy processing, a student dashboard with 3D floor maps and group-seat suggestions, and an authenticated console for diagnostics, algorithm tuning, firmware updates, and cluster training jobs.

Student HTTP APIs support bearer access for external apps alongside browser
cookie sessions. See [student token authentication](docs/student-token-auth.md)
for token login, expiry, revocation, and integration examples.

Security fixes, validation and deployment requirements are tracked in
[the security specsheet](docs/SECURITY_BUG_SPEC.md). TMsense 1.7 encrypted
telemetry and per-device/gateway/publisher credentials are documented in
[the coordinated protocol and migration runbook](docs/ENCRYPTED_NODE_PROTOCOL.md).

The edge and student web services run separately. The student service receives [occupancy snapshots](src/shared/types.ts) containing seat states and totals, without thermal pixels or person detections. Thermal frames and optional calibration camera images belong to privileged diagnostics and [training storage](docs/TRAINING_POSTGRES.md).

## Interesting techniques

- **One sensor authority per table.** The [occupancy engine](src/edge/occupancy.ts) selects an owner or a healthy fallback sensor. This prevents overlapping views from counting the same people twice.
- **Geometry-aware counting.** [Sensor projection](src/shared/geometry.ts) accounts for mounting height, rotation, and wide-angle optics. Heat is normalized by pixel floor area before estimating how many people a merged blob represents.
- **Stable counts with explicit uncertainty.** Seat hysteresis and median zone counts reduce flicker. Missing sensors produce unknown seats, which are excluded from availability and group suggestions.
- **Shared allocation rules.** The server and browser use the same [table allocation code](src/shared/allocate.ts), keeping recommendations consistent with the displayed floor plan.
- **Bounded live updates.** [WebSocket broadcasting](src/shared/fanout.ts) skips updates when a client's outgoing queue is full. The [student feed](web-app/src/data.ts) reconnects with backoff and marks availability unknown when freshness is lost. See [MDN's WebSocket reference](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).
- **A reusable 3D custom element.** The [floor viewer](public-web/vendor/floor-viewer.js) loads models on demand, caches them, and updates markers without rebuilding the scene. It uses [custom elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements), [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver), and explicit graphics-resource cleanup.
- **A preview backed by real firmware.** The [detector preview](src/algo/detector.ts) compiles the firmware's detector for the host. [Live parameter edits](src/algo/params.ts) revert after 15 minutes unless retained.
- **Authentication before effects.** [Encrypted telemetry](src/edge/secure.ts) supports per-device AES-GCM keys. [Replay cursors](src/edge/replay.ts) persist before accepted packets can change routes or occupancy. Compatibility requirements are documented in the [protocol contract](docs/ENCRYPTED_NODE_PROTOCOL.md).
- **Credentials sealed in the browser.** [Training credential handling](src/shared/hpcseal.ts) uses the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) to bind encrypted credentials to one user, action, and job.
- **Controlled firmware releases.** [Rollouts](src/edge/rollout.ts) prove one pilot node before updating the rest. Firmware builds run in an isolated worker, and the [deployment pipeline](deploy/pipeline.md) promotes checked artifacts with health checks and rollback.

## Technologies and libraries

- **Application stack:** [TypeScript](https://www.typescriptlang.org/), [React](https://react.dev/), [React Router](https://reactrouter.com/), [Vite](https://vite.dev/), [Express](https://expressjs.com/), and [ws](https://github.com/websockets/ws).
- **Visualization:** [Three.js](https://threejs.org/docs/) for floor models and [React Flow](https://reactflow.dev/) for the pipeline editor.
- **Browser development tools:** [CodeMirror](https://codemirror.net/) with [Lezer highlighting](https://lezer.codemirror.net/docs/ref/) for Python editing, plus [xterm.js](https://xtermjs.org/) for the cluster terminal.
- **Persistence:** [node-postgres](https://node-postgres.com/) and [TypeORM](https://typeorm.io/) for PostgreSQL storage and explicit migrations. The separate training worker uses [Psycopg](https://www.psycopg.org/psycopg3/docs/).
- **Offline training:** [NumPy](https://numpy.org/doc/) and [OpenCV](https://docs.opencv.org/) process calibration samples outside the student application.
- **Cluster integration:** [OpenConnect](https://www.infradead.org/openconnect/), [ocproxy](https://github.com/cernekee/ocproxy), and [Slurm](https://slurm.schedmd.com/documentation.html).
- **Supporting tools:** [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) for human verification, [PlatformIO](https://docs.platformio.org/en/latest/) for firmware builds, and [Playwright](https://playwright.dev/) for browser regressions.

## Fonts and styling

The student interface uses [Archivo](https://fonts.google.com/specimen/Archivo). The algorithm console uses [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans) and [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono).

The [student styles](web-app/src/tokens.css) use [CSS custom properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascading_variables/Using_custom_properties) and [color-mix()](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix) for consistent colors and spacing. Console animations respect [reduced-motion preferences](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

## Project structure

```text
TMedge/
├── .github/workflows/
├── algo-app/src/console/
│   ├── train/
│   └── updates/
├── ci/
├── config/
├── deploy/training/
├── docker/
│   ├── postgres-local/init/
│   └── postgres-test/init/
├── docs/hpc/
├── public-console/
├── public-web/
│   ├── assets/
│   │   ├── floors/
│   │   └── images/
│   └── vendor/three/
├── rigs/intern-demo/
├── src/
│   ├── algo/train/hpc/
│   ├── console-client/
│   ├── edge/
│   ├── infrastructure/
│   │   ├── algo/
│   │   ├── firmware-build/
│   │   ├── http/
│   │   ├── postgres/migrations/
│   │   ├── provisioning/
│   │   └── web/
│   ├── modules/
│   ├── shared/logging/
│   ├── tools/
│   └── web/
├── test/
│   ├── golden/train/
│   └── hpc-stack/fake-slurm/
├── tools/
├── web-app/src/pages/
├── Dockerfile
├── Dockerfile.firmware-worker
├── README.md
└── package.json
```

- [src/edge/](src/edge/) owns telemetry, sensor authority, counting, and firmware operations. [src/web/](src/web/) serves student accounts and occupancy.
- [src/modules/](src/modules/) separates application rules from the storage and process integrations in [src/infrastructure/](src/infrastructure/).
- [web-app/](web-app/) contains the student interface; [algo-app/](algo-app/) contains the operator console.
- [public-web/assets/floors/](public-web/assets/floors/) holds GLB floor models, while [public-web/assets/images/](public-web/assets/images/) holds campus photographs. [public-web/vendor/three/](public-web/vendor/three/) contains locally served Three.js modules.
- [rigs/intern-demo/](rigs/intern-demo/) supports thermal/RGB calibration. [tools/](tools/) contains training and export utilities.
- [test/](test/) covers protocol contracts, occupancy, authentication, persistence, and lifecycle behavior. [ci/](ci/) pins companion repository revisions.

Further detail is available in the [algorithm console documentation](docs/ALGO_DASHBOARD.md), [student account documentation](docs/student-accounts.md), and [deployment pipeline](deploy/pipeline.md).
