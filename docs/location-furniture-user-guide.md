# Location furniture user guide

This guide covers shared table and chair models in the location editor and the student room view. Location management is available to named Admin and Operator accounts with the existing `locations.manage` capability. Engineers and Viewers do not receive that capability.

## Add a model to the shared library

1. Open a location draft and keep table shapes, positions, seats, and sensors in **Details & layout** and **Sensors**. Furniture fit controls do not change that logical layout.
2. Open **Room view** and use the **Shared furniture defaults** controls or a table's **Furniture models** controls to open **Furniture models**.
3. In **Upload a shared model**, choose **Furniture type** and select a self-contained `.glb` using **Self-contained GLB (up to 128 MiB)** first. File selection fills **Display name** from the selected filename when the field is empty. Enter or edit **Display name** last, then submit the upload. If you type a `.glb` suffix, it remains in the final name.
4. The success message says the item was uploaded to the shared library and **has not been assigned**. Choose **Use model** separately to assign it. The library is shared across managers with location-management access; uploader identity does not prevent another manager from reusing an item.

Use **Filter by type** and **Search models** to find items. The picker marks incompatible items as **Wrong type** and disables their selection. Uploading furniture uses the shared furniture library; it does not replace the room's custom GLB.

## Set room defaults and table overrides

On **Room view**, **Table model default** applies to tables without a table override. **Chair model default - all seats** applies to each authored seat without a chair override. **Clear default** removes that room-level assignment.

In a table's **Furniture models** section, **Inherit room default** uses the matching room default. **Use table override** creates an assignment for that table and, for a chair model, all of its seats. The override replaces the complete matching default assignment, including its fit values. **Reset to room default** removes the complete override and restores inheritance. If there is no room default, selecting an override lets you choose a shared model.

Each assignment has these fit controls:

- **Uniform scale**: 0.01 to 100. It scales every dimension, including height.
- **Yaw**: -360 to 360 degrees around the vertical axis.
- **Elevation**: 0 to 10 metres from the normalized model base to the floor.

For built-in rectangular rooms, an assigned model replaces the generated primitive for that slot; unassigned slots keep their generated fallback. In a **Custom GLB** room, assigned furniture is overlaid at authored table and seat positions. The **Review location** page warns that custom room GLBs should omit their own table and chair geometry to avoid duplicates. The notice is informational: the editor does not inspect or remove embedded furniture from the room GLB.

## Save, review, and publish

Use **Save draft** to persist private edits. A save, upload, fit change, or preview does not publish. Reopen the draft to verify saved defaults and overrides. The **Furniture assignments** section in **Review location** summarizes defaults and table overrides.

Choose **Publish location** only after reviewing the location and its visibility. **Public - student-visible** locations can appear to students; **Console-only - not shown to students** locations remain hidden. A public furniture-bearing publication is accepted only after every configured web receiver acknowledges the exact asset bytes. Until publication commits, students continue to see the current published revision. If a receiver or asset check fails, fix the release or retry publication; do not try to expose a saved draft through the student model route.

Shared-library display names and uploader details are manager-side metadata. For furniture, the student projection carries only the safe asset reference and fit values from the current published location. A library item or an unpublished draft does not grant student access to its GLB.

## Student room view

In a supported location, choose **3D view** or **2D map** under **Room view**. A supported first visit uses 3D unless that browser already has a saved choice. The choice is stored in that browser only and does not edit the location. A location that does not support 3D stays in the 2D map.

The **Tables by live availability** list remains available in either view. It reports live availability or **No live data** independently of the furniture model. Furniture fit never changes capacity, seat positions, occupancy, or sensor state.
