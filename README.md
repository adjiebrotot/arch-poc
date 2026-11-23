# Architect Tool POC

A **fully static** proof of concept for a residential architecture practice, deployable to GitHub Pages:

* **Feature 1 – Design it yourself.** Every design starts from the client's own envelope: the **lot** (drawn on a 1 m grid or traced over an OpenStreetMap map) and the **footprint of each floor** (lot ⊇ ground floor ⊇ level 2 ⊇ level 3). Then the client either sketches the rooms themselves (Sketch it yourself) or lets us generate them inside those footprints, from a template (Start from a template) or from a chat (Just tell us). All three produce a `PlanSpec` that opens in a friendly, touch-first editor with comments.
* **Feature 2 – Walk & comment.** The architect publishes an IFC or GLB model. The client views watermarked 2D drawings (plans, reflected ceiling plan, sections, elevations) or walks through a photoreal 3D scene, and pins comments exactly where they mean.

Everything runs in the browser. The external calls are the optional LLM Cloudflare Worker, which is treated as a black box (see [`docs/llm-worker-contract.md`](docs/llm-worker-contract.md)), and OpenStreetMap services, used only when a client chooses to find their lot on a map (tiles, address search and road data; see [Lot from a map](#lot-from-a-map-openstreetmap)).

## Quick start

```bash
npm ci
npm run dev          # http://localhost:5173
npm test             # Vitest: envelope hierarchy, generator (L/U/T/diagonal/multi-storey footprints), feasibility, OSM helpers, editor, adapters, LLM, IFC
npm run build        # → dist/ (base path /arch-poc/ unless BASE_PATH is set)
npm run check        # svelte-check / TypeScript
npx tsx scripts/build-samples.ts   # re-bake the sample GLB + example design bundle
npx tsx scripts/ifc-batch.ts <dir> # parse every .ifc in a folder (robustness / timing report)
python3 scripts/make-textured-ifc.py <ambientCG-dir>  # re-author the textured IFC sample (needs ifcopenshell, pillow)
```

Optional: copy `.env.example` to `.env` and set `VITE_LLM_WORKER_URL` to try the Worker locally. Add `&llm=mock` to the setup URL of a *Just tell us* plan (`#/design/setup?id=…&llm=mock`) to use canned chat responses. `VITE_TILE_URL`, `VITE_GEOCODER_URL` and `VITE_OVERPASS_URL` swap the OpenStreetMap services (see below).

## Deploying to GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. *(Optional, for AI chat)* **Settings → Secrets and variables → Actions → Variables → New repository variable**: `VITE_LLM_WORKER_URL` = `https://<your-worker>.workers.dev`. Use a *variable*, not a secret. It's a public URL and the Worker holds the keys.
3. Push to `main`. `.github/workflows/deploy.yml` installs, runs the tests, builds with `BASE_PATH=/<repo-name>/` and deploys.

Routing is hash-based (`/#/design`, `/#/viewer/walk`…), so refreshing any route works on Pages. The IFC parser uses the **single-thread** web-ifc WASM build, because Pages can't send COOP/COEP headers (no `SharedArrayBuffer`).

## Routes

| Route | What |
|---|---|
| `#/` | Landing page with two feature cards |
| `#/design` | Choose a mode (Sketch / Template / Tell us), recent plans (they reopen at the step they were left at), import, example plan with comments |
| `#/design/setup?id=…` | The workflow before the editor. Sketch: **Lot → Ground floor**. Template: **Lot → All floors → Template → Pick a layout**. Tell us: **Lot → All floors → Describe → Pick a layout** |
| `#/design/sketch`, `#/design/creative`, `#/design/chat` | Start a new plan in that mode (goes to the lot step) |
| `#/design/workspace?id=…` | Editor: ✏️ Edit / 💬 Comment, 2D/3D, undo/redo, autosave, footprint tool, *Send to architect* |
| `#/viewer` (`?project=<id>`) | Load a published project, a demo sample, or upload IFC/GLB (Architect role) |
| `#/viewer/plan` | Watermarked 2D drawings with comments and PNG/PDF export |
| `#/viewer/walk` (`?comment=<id>`) | 3D walkthrough / orbit, minimap, time of day, quality presets, spatial comments |
| `#/comments` | All comments: filter, resolve (architect), export/import JSON |

The header has a **Client / Architect** toggle (demo only, no auth). Architects can upload models, resolve comments and hide the watermark. Clients can edit plans and comment.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Static site (GitHub Pages)"]
    direction TB
    App["App shell<br/>hash router · role toggle"] --> D & V & C
    subgraph D["Feature 1 · Design"]
      Setup["Setup flow<br/>lot (grid · OSM map) → floor footprints"] --> Env[("Envelope<br/>lot ⊇ GF ⊇ L2 ⊇ L3")]
      Env -->|Sketch| WS
      Env -->|Template · Tell us| Gen["generator.ts<br/>rooms inside the footprints"]
      Feas["feasibility.ts<br/>(against the envelope)"] --> Gen
      Chat["Describe step"] --> LLM["LLMProvider<br/>Worker → RuleBased · Mock"]
      LLM -->|Zod-validated, clamped| Feas
      Gen --> PS[("PlanSpec")]
      PS <--> Adapter["openplan3dAdapter"] <--> OP3D["vendor/openplan3d<br/>room detection"]
      PS --> WS["Workspace editor<br/>SVG 2D · Babylon 3D preview"]
    end
    subgraph V["Feature 2 · Viewer"]
      Load["modelStore"] -->|.ifc| Worker2["Web Worker<br/>web-ifc single-thread WASM"]
      Load -->|.glb/.gltf| GLB["Babylon glTF loader"]
      Worker2 & GLB --> MD[("ModelData<br/>elements · storeys · Psets")]
      MD --> Walk["ViewerEngine<br/>PBR · IBL · CSM · SSAO2/SSR · walk/orbit"]
      MD --> Draw["DrawingEngine<br/>ortho + cut plane · poché · edges"]
    end
    C["Comments<br/>shared model + store"]
    WS & Walk & Draw --> C
    C & WS & Load --> SA["StorageAdapter"] --> LS[("localStorage +<br/>IndexedDB cache")]
  end
  LLM -. "POST /parse (no keys)" .-> CF["Cloudflare Worker<br/>(maintained separately)"]
  Setup -. "tiles · search · roads" .-> OSM["OpenStreetMap<br/>tiles · Nominatim · Overpass"]
  Pages[("public/projects/&lt;id&gt;/<br/>model + comments.json")] --> Load
```

### Folder structure

```
src/
  App.svelte, main.ts, app.css
  shared/          router, StorageAdapter (+ local impl), comments (model, store, UI), model types, UI kit
    planspec/      schema.ts, site.ts (lot, roads, compass), envelope.ts (lot ⊇ footprints ⊇ rooms)
    geo/           osm.ts (local metric frame, tiles, Nominatim search, Overpass roads, frontage detection)
  features/
    landing/
    design/        DesignHome, planStore, PlanThumb
      setup/       DesignFlow (steps), LotStep, FloorsStep, TemplateBrief, ChatBrief, LayoutStep, NewPlan
      generator/   raster.ts, program.ts, generator.ts, feasibility.ts, templates.ts
      llm/         WorkerProvider, RuleBasedProvider, MockProvider, FallbackProvider, Zod schemas
      engine/      openplan3dAdapter.ts, plan3d.ts (PlanSpec → 3D), planSvg.ts
      workspace/   Workspace, PlanCanvas (the one canvas for lots, footprints and rooms), MapTiles, SiteSheet, Compass, editor.svelte.ts (ops, history, anchors), Preview3D
    viewer/        ViewerHome, WalkView, PlanView, Minimap, Joystick
      model/       ifcParse.ts, ifc.worker.ts, glbLoad.ts, modelStore.ts, slice.ts
      engine/      ViewerEngine.ts (3D), DrawingEngine.ts (2D), materials.ts
    comments/      CommentsPage
vendor/openplan3d/ vendored geometry core (MIT) + MODIFICATIONS.md
public/            samples/ (duplex.ifc, family-home.glb, example bundle), projects/, env/
docs/              llm-worker-contract.md
tests/             Vitest suites
```

### Stack and the reasons behind each choice

* **Vite + TypeScript + Svelte 5.** We chose Svelte over React because openPlan3D, the editor we adapt, is Svelte, and because Svelte compiles to small bundles, which keeps the landing page fast (Lighthouse mobile: Performance 96, Accessibility 100 locally).
* **Svelte stores / runes** instead of Zustand. They're the idiomatic Svelte equivalent, so we don't need an extra dependency.
* **Babylon.js 9** for every 3D view: the walkthrough, the 2D drawings and the workspace preview. openPlan3D's three.js viewer is *not* used, so the app ships one 3D engine, not two.
* **web-ifc** directly rather than That Open Engine components. Those are built on three.js; we only need the parser. It runs in a Web Worker with the single-thread WASM.
* **Tailwind CSS 4**, **Zod 4**, **lz-string** (share links), **jsPDF** (lazy-loaded).
* **Lazy loading.** Babylon, web-ifc and jsPDF only download on the routes that need them. The landing page loads about 60 KB of JS (gzip).

## How the features work

### Feature 1

#### The workflow: Lot → floor footprints → rooms

The spatial hierarchy is **Lot → floor footprint(s) → rooms**, and every mode follows it:

| Mode | Steps | Who draws the rooms |
|---|---|---|
| **Sketch it yourself** | Lot → ground-floor footprint → draw rooms → *+ Add floor* → adjust its footprint → draw its rooms | The client |
| **Start from a template** | Lot → the footprint of **every** floor → pick a template (and fine-tune it) → pick a generated layout | Generated inside the footprints |
| **Just tell us** | Lot → the footprint of **every** floor → describe the home in a chat → pick a generated layout | Generated inside the footprints |

* **User-defined geometry**: the lot, the number of floors and each floor's footprint. **System-generated geometry** (Template / Tell us): the rooms, their arrangement, hallways, stairs, walls, doors and windows. In Sketch the client draws both.
* The hierarchy is enforced everywhere, on every edit (`src/shared/planspec/envelope.ts`): the ground floor stays inside the lot, every upper floor inside the floor immediately below it, and every wall inside its floor's footprint. A drag that would break it stops where it is and says why; a lot or lower floor can't be shrunk under what sits on it.
* A footprint is the **outer face** of the outside walls. Outside walls (25 cm) run along it with their outer face on it, so rooms live inside the *wall line* (the footprint pulled in by half a wall).
* Lots, footprints and rooms all use **the same point-by-point interaction** on the same canvas (`PlanCanvas.svelte`): tap each corner (it snaps to the **1 m grid**; on a map it follows the map), tap the first corner or *Done* to close, drag corners, pull a ⊕ in the middle of a side to add one, tap a corner to remove it. Outlines that cross themselves are refused. Nothing assumes rectangles; a *rectangle W × D* shortcut is offered for the lot and footprints, as a starting point only.
* Plans remember where they are (`meta.stage`: `lot`, `floors`, `brief`, `layout`, `design`) and reopen at that step.

#### Lot on a grid

A blank 1 m grid: tap the lot's corners. The side facing down the screen becomes the street; tap any side to mark it as a street (several sides for corner or through lots) or move the ➜ entrance there; drag the entrance along a street side. The **compass** sets north: drag it, or pick "the street faces N/NE/E…" in *Streets & north*, where road names and widths are also set.

#### Lot from a map (OpenStreetMap)

* Search an address (OpenStreetMap **Nominatim**, one request per search, as its usage policy asks), type coordinates (`-33.8688, 151.2093`) or use the device location, then trace the lot over **OpenStreetMap tiles**.
* The plan is a local metric frame centred on the searched point (Web-Mercator is conformal, so one scale factor gives metres; `src/shared/geo/osm.ts`). **North comes from the map** and is locked: the compass can't be turned by hand on a map lot.
* When the outline is closed, the roads around it are fetched from the **Overpass API** and each lot side is tested: a road roughly parallel to the side, in front of it within about 28 m (service lanes only within 12 m), makes it a street side, named after the road. The best one gets the entrance.
* The plan is then turned so the street is at the bottom (the usual way to draw a plan), and north follows: `site.geo.rotation` is stored and the north angle equals it, so the real-world orientation is kept. *North up* is one tap away while no footprint exists. The map can be shown under the floors step too.
* `VITE_TILE_URL` (`{z}/{x}/{y}` template), `VITE_GEOCODER_URL` and `VITE_OVERPASS_URL` point these at other providers. Attribution (© OpenStreetMap contributors) is shown on the map. If a service can't be reached, the lot still works: search accepts coordinates and the street side can be tapped.

#### Floor footprints

* The ground floor is drawn inside the lot (the lot stays visible as context).
* *+ Add floor* starts the new storey as an **exact copy of the floor immediately below**, which then shows as a hatched silhouette. The client can make it smaller or change its shape, never reach outside it. Template / Tell us define every floor here before anything is generated; Sketch defines the ground floor here and adds floors in the editor.

#### Generating rooms inside the footprints (Template / Tell us)

* **Templates are programmes, not buildings** (`generator/templates.ts`): *The Cottage*, *The Family Home*, *The Entertainer*, *The Townhouse*. The footprints never change to fit a template: a template that needs more space than the floors offer is **adapted down** (fewer rooms, shown as *Adapted*), and the fine-tune chips (bedrooms/bathrooms, extra rooms, preferences) show what fits.
* **Feasibility** (`generator/feasibility.ts`) is checked against the real envelope: total footprint area and each floor's area. It uses minimum room areas, +15 % circulation, +12 % walls and 7 m² of stairs per extra floor; the ground floor must be at least 28 m² and upper floors 16 m². For example, 60 m² on one floor allows 2 bed 1 bath, while 3 bed shows “Needs ~70 m²+”. Infeasible options are shown greyed out with the reason, not hidden, and the nearest brief that fits is suggested.
* **Programme** (`generator/program.ts`): public rooms (entry, living, kitchen, dining, family room, garage), service rooms (study, laundry, powder room) and private rooms (main bedroom with ensuite and walk-in robe when there are 2+ bathrooms, bedrooms, bathrooms). On several floors the bedrooms go up, by the space each floor has; a bathroom goes on every floor with bedrooms, and the ground floor gets a powder room or guest bathroom. Spare space becomes a family room, study, retreat or storage; preferences such as *main bedroom downstairs* and *living faces the back garden* change the arrangement.
* **Generator** (`generator/generator.ts`, `raster.ts`), deterministic and seeded (mulberry32):
  1. A local frame lines the grid up with the footprint's main wall direction and puts the lot's main street at the front. Each floor's wall line is rasterised into 25 cm cells, with the exact share of each cell inside the polygon, so diagonal and irregular sides are handled exactly.
  2. A **hallway spine** is chosen so every part of the floor is within reach (about 6 m), the street side gets the public rooms and the quiet side the private ones. Wings out of reach (L, T, U shapes) get a **branch hallway**.
  3. On multi-storey homes the **stairs** sit beside the spine, inside the smallest (top) footprint, in the same place on every floor, preferably against an outside wall; the landings stack over the ground-floor hallway.
  4. Rooms reach **straight out** from a side of the hallway, so walls stay straight; each side is sliced along the hallway into rooms by target area (a balanced partition keeps sizes even across strips). Small wet rooms keep only the depth they need and the neighbouring bedroom wraps behind them; the main bedroom gets a strip for the ensuite and walk-in robe.
  5. Walls are the boundaries between rooms, **clipped to the exact wall line**, so rooms meet diagonal outside walls exactly; rooms are then detected from the walls by the same openPlan3D engine the editor uses. Doors go on shared walls (living, kitchen and dining get wide openings), windows on outside walls, the garage door on the street side and the **front door faces the lot's entrance**.
  6. Several seeded candidates are **scored** (every room reachable, daylight for habitable rooms, proportions, sizes, hallway share, entry and garage on the street) and the best distinct ones are offered. Same envelope + brief + seed ⇒ the same plan (tested).
* **Tell us (chat)**: the envelope is already drawn, so the chat only needs **bedrooms and bathrooms**; it also picks up extra rooms (study, garage, laundry, dining, family room, powder room) and relationships (*main bedroom downstairs*, *living facing the back garden*). If the client mentions a size or number of floors that differs from the footprints, the assistant points out that the footprints set them. `FallbackProvider` tries the `WorkerProvider` (15 s timeout) and falls back to the `RuleBasedProvider` (regex/keywords, understands short answers like “2”) when the URL is unset, on errors, on HTTP 429 or on invalid output; fallback shows the badge “Offline mode – simplified parsing”. Parsed requirements appear as editable chips.

#### The workspace

* **PlanSpec** (`src/shared/planspec/schema.ts`): a Zod schema in metres. `site` holds the lot outline (`boundary`), the road sides (`roads`, by edge index), the `entrance`, `northAngle` (degrees clockwise from the top of the plan), `source` (`grid` / `map`) and, for map lots, `geo` (origin and rotation). Each floor has its `footprint`. Plans saved before footprints existed get one traced from their outside walls when they open; plans saved before lots were polygons get a rectangle with one road on the front side. `planSpecToOpenPlan3D()` and `openPlan3DToPlanSpec()` convert to and from openPlan3D's centimetre model.
* **Tools**: Move, Add a room, Draw wall, Add door, Add window, Remove, 🏠 Footprint and 🧭 Lot & road. Corners snap to the **1 m grid** and to walls and wall corners; doors and windows slide in 10 cm steps. Room areas update live through openPlan3D room detection. Other features: undo/redo, autosave, coach marks in Sketch mode, an Advanced drawer, pinch-zoom, long-press to grab on touch, and bottom sheets.
* **Rooms of any shape**: *Add a room* defaults to **⬠ Any shape**: tap each corner, then tap the first corner (or *Done*, or Enter) to close. Lengths and the area show while you draw; Backspace or *↶ Corner* removes the last corner. Corners just outside the footprint are pulled onto its outside wall; a room that reaches outside is refused. **▭ Rectangle** keeps drag-a-box / tap-to-drop.
* **Sketch mode** starts each floor with its outside walls already in place around one *Open space*; rooms drawn inside split it. Outside walls follow the footprint: they can't be deleted or dragged on their own, only through 🏠 **Footprint**, where dragging the footprint's corners moves them and any inside wall meeting them slides along (doors and windows stay roughly where they were). A footprint change that would leave a room outside is refused.
* **Floors**: the floor tabs show each footprint's area. In Sketch, *+ Add floor* copies the floor below (footprint and outside walls) and opens 🏠 Footprint so it can be made smaller before drawing its rooms. Generated plans offer *Change floors & regenerate…*, which goes back to the floors step.
* **Reshaping**: select a room with *Move* and its corners appear as handles. Drag a corner and every wall meeting there follows; a corner that sits in the middle of another wall (a T-junction) slides along that wall, and inside walls that T into a moved wall stay attached and keep their direction. Pull the **⊕** in the middle of a side to add a corner there (the wall is split, its doors and windows stay put). Tap a corner and *Remove corner* (or Delete) to straighten the two walls back into one. Dragging a whole wall still moves it along its normal.
* **Lot, roads & compass** (`src/shared/planspec/site.ts`): with **🧭 Lot & road** you drag lot corners (never into the ground floor), pull a ⊕ to add one, tap a corner to remove it, or *Redraw lot* (grid lots). Each side shows its length and the direction it faces. Tap a side to mark a **road** along it or move the **➜ entrance** there; drag the entrance along any road side. *Roads & north* has one-tap layouts for the common cases: **One road**, **Corner lot (L)** with the side road on the left or right, and **Front & back**. The **compass** (top left) shows north and which way the main road faces. Roads, footpaths, the lot kerb and the entrance also appear in the SVG export and the 3D preview, where the sun's path follows the compass.
* **Comments in the workspace**: each pin is anchored to an element id plus local coordinates (position along a wall and side offset, or offset from a room's centroid), so it **follows the element when it moves**. A comment can carry a category and a photo (stored as a base64 thumbnail).
* **Send to architect**: a JSON bundle (PlanSpec + comments + requirements), or a compressed `#/design/workspace?share=…` link for small plans.

### Feature 2

* **Loading**: drag and drop, file picker (Architect role), demo samples, or published projects. Progress comes from the worker. Parsed models are cached in IndexedDB. Large files (> 25 MB on phones, > 150 MB on desktop) prompt for a *simplified* load without furniture or small parts.
* **IFC metadata**: each mesh keeps its `expressID`, GlobalId, class, name, storey (via `IfcRelContainedInSpatialStructure` / `IfcRelAggregates`) and flattened Psets. Render meshes are merged per *storey × material* for fewer draw calls, and invisible per-element meshes handle picking and collisions.
* **IFC textures**: web-ifc only outputs colours, so `model/ifcTextures.ts` reads textures from the IFC itself:
  * The three texture kinds are `IfcImageTexture` (external image), `IfcBlobTexture` (embedded JPG/PNG) and `IfcPixelTexture` (raw pixels).
  * They can be attached per representation item (`IfcStyledItem` → `IfcSurfaceStyleWithTextures`, including IFC2x3 `IfcPresentationStyleAssignment`) or per material (`IfcMaterialDefinitionRepresentation` + `IfcRelAssociatesMaterial`).
  * Explicit UVs come from `IfcIndexedTriangleTextureMap`. They're matched onto web-ifc's re-centred triangles by shape, so unit scaling and re-centring are handled.
  * Without explicit UVs, textures are box-mapped in metres and scaled by `TextureTransform`.
  * External images are fetched relative to the model URL (same-origin only). For uploads, select or drop the image files together with the `.ifc`; missing images are reported and fall back to the material colour.
* **Rendering**: PBR material library (timber floor, concrete, plaster, tile, glass, brushed metal, grass, roof), with procedural textures, so there are no texture downloads. Lighting is HDR IBL plus a directional sun with cascaded shadow maps and a time-of-day slider. Post-processing uses `DefaultRenderingPipeline` (ACES tone mapping, bloom, FXAA, vignette), SSAO2 at Medium and High, and SSR at High on desktop. There's a sky and a ground plane. Glass is transparent and has no collisions, and neither do door leaves, so you can walk through doorways.
* **Quality presets**: Low (phones: lower resolution, 2 shadow cascades, no AO), Medium and High (desktop). The default is detected automatically and can be overridden in ⚙️.
* **Walk**: on desktop, WASD or the arrow keys plus pointer-lock mouse look, and double-click the floor to walk there. On mobile, a joystick (left), drag to look, and tap the floor to walk there. Eye height is 1.6 m, with collisions, gravity and a step-up ground follower for stairs. There's also an orbit mode, a minimap (tap to walk there), “Go inside”, and a storey cut-away.
* **3D comments**: 💬 freezes movement. Tapping raycasts and stores the world position, surface normal, element id / `expressID`, storey, a camera snapshot and a thumbnail. Pins are billboards. Tapping a pin opens the thread, and **Go to view** flies back to the exact viewpoint.
* **2D drawings**: an orthographic camera with a cut plane. A custom shader discards geometry beyond the cut and draws the cut solids as dark poché; edges are drawn with Babylon's edges renderer (clipped by the same plane). The set covers floor plans at storey + 1.2 m, the **reflected ceiling plan** (looking up, mirrored), Section A–A and B–B, and four elevations. Every view has a storey selector, scale bar, north arrow, and pan/zoom. The diagonal **“DRAFT — NOT FOR CONSTRUCTION”** watermark is drawn on screen and baked into PNG/PDF exports, and the Client role can't turn it off. 2D comments share the 3D anchor model, so they appear in both views.

### Walkthrough controls & doors/windows

- **Move:** WASD (arrows: forward/back + turn), **Shift** to run. Walk 4.3 m/s, run 7.5 m/s. Mobile: joystick + drag to look.
- **Minimap:** tap to glide there, drag your marker to move live, ▲/▼ to change floor, ⤢ to enlarge.
- **3D floor plans (orbit):** in orbit mode the minimap's ▲/▼ cut the building horizontally. **Roof** shows the whole closed building; each floor below removes everything more than 1.3 m above that floor (roof, upper storeys, the top of its own walls), so you look down into its rooms. Walking always switches back to the whole building.
- **Doors & windows:** look at one and press **E** (or F, or click/tap it) to open or close it. Closed doors block you.
- **Which way they open** (`src/features/viewer/engine/openings.ts`):
  - IFC operation type is read from the element (IFC4 `IfcDoor.OperationType`) or its type (`IfcDoorStyle`/`IfcDoorType`, `IfcWindowPanelProperties`): `SINGLE_SWING_LEFT/RIGHT`, `DOUBLE_DOOR_*`, `SLIDING_TO_LEFT/RIGHT`, `ROLLINGUP`, `SIDEHUNG*`, `TOPHUNG`, `BOTTOMHUNG`, `PIVOT*`, `SLIDING*`, `FIXEDCASEMENT`...
  - Hinge side and swing side follow the IFC convention: a door swings towards its local +Y, and left/right is the hinge side seen looking along +Y (local axes come from the `IfcLocalPlacement` chain).
  - When the file doesn't say: name hints (fixed, casement, slider, awning...) and size; doors then swing away from you, casements open inwards.
  - The moving leaf is separated from the lining/frame geometrically (pieces inset from the frame move).

## Architect publishing workflow (the POC's stand-in for a backend)

1. Create `public/projects/<id>/project.json`:

   ```json
   {
     "id": "duplex",
     "title": "Duplex townhouses",
     "versionId": "v2",
     "versionLabel": "Version 2 · Design development",
     "previousVersion": "Version 1 · Concept",
     "model": "../../samples/duplex.ifc",
     "comments": "comments.json",
     "publishedAt": "2026-11-19T09:00:00.000Z"
   }
   ```

   `model` may be a file in the same folder (`model.ifc` / `model.glb`) or a relative path.
2. Optionally add `comments.json` (an array of comments, e.g. exported from `#/comments`) and list the project in `public/projects/index.json`.
3. Commit and push. Pages redeploys. Send the client `https://<owner>.github.io/<repo>/#/viewer?project=<id>`.
4. The client's comments are stored **locally** on their device. They use **Comments → Export** (or *Send to architect* in the design workspace) and send the JSON back. The architect imports it at `#/comments` (or the design page), replies and resolves, then exports an updated `comments.json` into the next published version.

The repo ships `public/projects/duplex/` (the duplex IFC, version label, “Compare with previous version” placeholder, and five pre-filled client/architect comments in 2D and 3D, with snapshots and replies).

## Demo content

* `public/samples/duplex.ifc`: IFC 2x3 sample (2 storeys plus foundation and roof, about 270 elements, Psets).
* `public/samples/textured-cottage/`: a properly **textured IFC4** model (authored with IfcOpenShell by `scripts/make-textured-ifc.py`, CC0 photo textures). It exercises every way IFC carries textures, see below.
* `public/samples/family-home.glb`: GLB baked from the seeded *Family Home* template (`scripts/build-samples.ts`).
* Three seeded templates: *The Cottage*, *The Family Home* and *The Townhouse* (`generator/templates.ts`).
* Pre-filled comments: `public/projects/duplex/comments.json` (viewer) and `public/samples/example-design-bundle.json` (workspace: **Design → Open example with comments**).

## Persistence

`StorageAdapter` (`src/shared/storage/StorageAdapter.ts`) is the only persistence boundary. `LocalStorageAdapter` keeps plans, comments and preferences in `localStorage` and parsed models in IndexedDB. Everything round-trips through JSON export and import. A REST, Supabase or Firebase backend can implement the same interface without UI changes.

## Known limitations (POC)

* **No backend or auth.** The role toggle is cosmetic; data stays on each device and travels as JSON files or share links.
* **Compare with previous version** is a labelled placeholder (“coming soon”).
* **Performance on real phones is unverified.** It was checked only in headless Chromium with software WebGL (SwiftShader). The Low preset is designed for ≥30 fps on mid-range phones; confirm on real devices before relying on it.
* **Drawings**: poché depends on the model's normals being consistent. Open or flipped IFC geometry can show dark patches. There are no dimensions, annotations or hatching standards yet.
* **IFC**: very large models parse on the device. The single-thread WASM is slower than the multi-thread build. The simplified mode only drops furniture and small classes, with no mesh decimation.
* **Generator**: rooms are arranged on a 25 cm grid aligned with the footprint's main wall direction, so inside walls stay square to it (diagonal outside walls are followed exactly). Very irregular footprints (deep U shapes, many wings) give valid but less elegant plans; a footprint much bigger than the brief gets very generous rooms plus a family room, study or storage. Stairs are a single 2.25 × 3 m dog-leg core in the same place on every floor. A generated plan is a starting point to edit, not a design.
* **Map lots**: OpenStreetMap rarely has property boundaries, so the client traces the lot by eye over the map; accuracy is that of the tiles (about 0.3 m at zoom 19). Road detection needs the road to be in OSM and roughly parallel to a lot side, within about 28 m. The public tile server and Nominatim have usage policies meant for light use: point `VITE_TILE_URL` / `VITE_GEOCODER_URL` at a commercial or self-hosted service before real traffic.
* **The rule-based chat parser** covers common phrasings only. The Worker is expected to do the heavy lifting.
* **GLB** materials map to the curated library by name keywords. Embedded textures are not kept.
* **IFC textures**: `IfcIndexedPolygonalTextureMap` and `IfcTextureCoordinateGenerator` parameters are not interpreted; those fall back to box mapping. Real-world exports (Revit, Archicad, Tekla) rarely contain textures at all; they carry colours, which map to the curated PBR library. See [`docs/ifc-compatibility.md`](docs/ifc-compatibility.md) for the models tested.

## Next steps

* A backend (behind `StorageAdapter`) for projects, versions and comments, with auth (magic links for clients, SSO for staff) and roles enforced on the server.
* Real-time sync for comments (WebSocket or Durable Objects), and notifications.
* Version diffing (element GlobalId diff → highlight added, removed and changed elements).
* Dimensioned drawings, room tags from `IfcSpace`, sheet layouts and title blocks.
* Model optimisation pipeline (Draco/meshopt GLB, LODs) for large projects on phones.
* Furniture and finishes in the client editor, reusing more of openPlan3D's catalogue.
