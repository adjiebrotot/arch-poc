# Modifications to openPlan3D

Upstream: https://github.com/laanlabs/openPlan3D @ `771c9e1` (MIT, see `LICENSE`).

## What upstream is

openPlan3D is a SvelteKit 2 / Svelte 5 + three.js floor-plan editor
(~245 source files). It includes Firebase, server routes (MCP and agent
bridges, share storage), a 4,400-line canvas component, a furniture catalogue,
exports and a path tracer. Its extension points are:

* the plain-TypeScript data model in `src/lib/models/types.ts` (Floor, Wall, Room, Door, Window), in centimetres
* pure geometry utilities in `src/lib/utils/*` (room detection, wall profiles, hit testing…)
* Svelte stores for project state, and the `FloorPlanCanvas` and `ThreeViewer` components

## What we vendored and why

A static GitHub Pages POC can't carry upstream's server routes, Firebase or
three.js (the viewer uses Babylon.js). Upstream's UI is also aimed at
power users, which is the opposite of “non-architect friendly”. So we vendored
the **framework-free geometry core** and built a new, simplified, touch-first
editor on top of it (`src/features/design/workspace/`).

| File | Status |
|---|---|
| `src/models/types.ts` | Copied unchanged |
| `src/utils/roomDetection.ts` | Import paths changed (`$lib/models/types` → `../models/types`); logic unchanged |
| `src/utils/wallProfiles.ts` | Import paths changed; logic unchanged |
| `src/utils/roomNesting.ts` | Import paths changed; logic unchanged |
| `index.ts` | **New**: a small public surface (`detectRooms`, `resolveRoomGeometry`, `getRoomPolygon`, `roomCentroid`, types) |

## How it's used

* `src/features/design/engine/openplan3dAdapter.ts` has `planSpecToOpenPlan3D()` and its inverse `openPlan3DToPlanSpec()`. They convert metres ⇄ centimetres, `[x,y]` ⇄ `{x,y}`, opening offsets in metres ⇄ 0–1 positions, and room type ⇄ `details.roomType`.
* `recomputeRooms()` runs openPlan3D's planar face detection, which handles T-junctions and crossings, after every wall edit. That's how rooms and **live m² areas** appear as clients draw. Room names and types are carried across edits by matching centroids.
* Unit tests: `tests/adapter.test.ts`.

## Not taken from upstream

The SvelteKit app shell, Firebase, server/MCP routes, the three.js viewer,
furniture catalogue, exports, i18n, the path tracer and the original UI components.
