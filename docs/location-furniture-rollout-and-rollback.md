# Location furniture rollout and rollback

This runbook covers rollout of furniture-bearing location snapshots and a safe rollback. Furniture-bearing public snapshots use strict version 3 (v3); snapshots without furniture retain the existing v2 or legacy v1 behavior. `CampusView` remains versionless. Follow [Location configuration storage](location-configuration-storage.md) for persistent-path, backup, and restore ownership.

## Release order

1. Inventory every configured student web receiver and its persistent published-model directory. Back up the active location registry or database, edge `DATA_DIR`, web `DATA_DIR`, and deployment configuration as one recovery set. Keep persistent paths outside release directories.
2. Deploy the v3-capable web receiver to **every** configured target while the edge still emits no furniture-bearing snapshots. Keep all targets on a compatible release; do not leave an older receiver in the target set.
3. Verify each receiver build accepts the strict v3 contract and versionless campus projection, rejects malformed or unknown furniture fields, and serves a GLB only to an authenticated student when a current winning public floor references that asset. Run the repository's v3 validator and two-target acknowledgement coverage against the receiver build.
4. Confirm each receiver has completed its published-model integrity receipt initialization before it receives asset traffic. In production, startup waits for this barrier before binding the listener.
5. Only after every receiver is ready, release the edge publisher that can emit v3. Observe the first normal publication through the existing explicit location workflow and confirm all configured receivers acknowledge every required asset before the location revision commits.

The existing asset acknowledgement proves durable receipt of the matching asset ID and SHA-256 bytes. It does **not** prove that a target understands v3. There is no runtime capability negotiation, emission flag, new endpoint, or alternate transfer protocol; the web-first release gate provides version compatibility.

## Published-model integrity receipts

Before the first inventory or cutover, drain all old web writers that could accept transfers or write the published-model directory. For instances sharing one directory, use one migration coordinator or an explicit cross-process serialization claim/barrier; non-owner instances must wait for the owner's initializer to complete before binding or accepting asset traffic. When instances have separate published-model directories, initialize each directory before its listener accepts traffic.

The web store keeps a private `{ sha256, byteLength }` receipt beside each immutable published GLB. At first cutover, the initializer validates each pre-existing GLB, writes or verifies its receipt durably, and writes the versioned `.integrity-baseline-v1` marker last. The marker content is `{"schemaVersion":1}`. Per-asset receipts use the corresponding `<assetId>.meta` file. The marker and receipts must be durable before cutover completes. Once the marker exists, reads fail closed if a receipt is missing or mismatched; a read never silently adopts the current bytes as a new baseline. An authenticated exact-byte retry may repair a missing receipt only when the existing validated bytes match the supplied digest and length.

For a valid GLB that predates receipt cutover, the first inventory establishes its baseline from the current bytes because no earlier expected digest was stored. It cannot detect a structurally valid mutation that happened before that baseline. If the prior bytes are in doubt, compare with a trusted backup; the new baseline is not proof of the older bytes' integrity. Changes after receipt creation fail closed.

Keep receipt files and the marker in the persistent published-model directory. Do not copy a release over that data directory or delete receipts as a routine code rollback.

## Data-based rollback

Rollback removes furniture assignments from current public data through the normal private edit and publish flow:

1. For each affected public location, edit its private draft and remove `furnitureDefaults` and every table's `furnitureOverrides`. Save and review the draft.
2. Publish each edited location through the existing **Publish location** action. The ordinary all-target acknowledgement gate still applies. A failed target leaves the previous winning revision active; restore the target and retry the publication.
3. Verify **every** configured web receiver's current versionless campus projection contains no furniture assignment fields and that the edge emits the existing v2 snapshot shape for those locations (or keeps a pre-existing legacy v1 path where applicable). The `proceduralRoom: "simple-rectangle-v1"` marker is supported v2 content and may remain.
4. Keep v3-capable web receivers while any target may still hold or receive a v3 snapshot. Keep the feature-capable edge parser/runtime while any saved draft or published history contains furniture fields.

Do not strip furniture fields from a furniture-bearing snapshot or force a version downgrade. Do not delete immutable GLBs, receipts, drafts, or publication history as rollback steps. When no current winning public floor references a withdrawn asset, the student model route denies that asset; if another current winning floor still references it, that reference continues to authorize it. A publication rollback changes current public data and access; it does not rewrite history or erase private edits.
