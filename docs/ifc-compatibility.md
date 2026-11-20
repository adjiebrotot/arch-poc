# IFC compatibility report

Models tested against the viewer's IFC pipeline (web-ifc 0.0.80, single-thread WASM + `src/features/viewer/model/ifcParse.ts`).
Parse times come from `npx tsx scripts/ifc-batch.ts <dir>` in Node. Browser load times are from headless Chromium with
software WebGL, upload → model ready, including the Web Worker and IndexedDB caching.

| Model | Source | Schema | Size | Parse (Node) | Elements | Levels | Browser load | Notes |
|---|---|---|---|---|---|---|---|---|
| Duplex (bundled sample) | Revit 2011 | IFC2X3 | 2.3 MB | 0.25 s | 273 | 4 | ~1.5 s | Reference model; green roof detected as grass |
| AC20-FZK-Haus | KIT / Archicad | IFC4 | 2.6 MB | 0.40 s | 97 | 2 | 1.6 s | Pitched roof slabs inside `IfcRoof` → roof material (was timber floor before the fix) |
| Ifc4_SampleHouse | buildingSMART | IFC4 | 2.3 MB | 0.08 s | 82 | 2 | 1.5 s | Barrel roof, furniture shows in plan |
| IfcOpenHouse | IfcOpenShell | IFC4 | 0.1 MB | 0.01 s | 35 | 1 | – | |
| ISSUE_159 kleine Wohnung | Archicad 22 | IFC4 | 10.2 MB | 0.81 s | 518 | 4 | 2.5 s | Geometry at absolute height (~500 m) while storey elevations are relative: the offset is detected and applied |
| ISSUE_034 HouseZ | – | IFC2X3 | 5.2 MB | 0.20 s | 228 | 3 | 1.5 s | Building not axis-aligned; drawings show its true orientation |
| ISSUE_021 Mini Project | – | IFC2X3 | 3.4 MB | 1.06 s | 2,636 | 1 | – | Single “Undefined” storey |
| Office_A | – | IFC2X3 | 4.1 MB | 0.52 s | 967 | 3 | – | |
| dental_clinic | Revit | IFC2X3 | 13.0 MB | 1.25 s | 2,894 | 4 | 3.3 s | Plan renders in ~3.4 s (fast edge finder) |
| Ifc4_Revit_ARC | Revit | IFC4 | 13.6 MB | 0.70 s | 446 | 6 | 2.3 s | Topography excluded from framing |
| FM_ARC_DigitalHub | – | IFC4 | 14.3 MB | 0.96 s | 705 | 3 | 3.2 s | 159 m long; web-ifc warns about some faces |
| schependomlaan | Revit (NL) | IFC2X3 | 49.3 MB | 2.13 s | 4,102 | 6 | 4.3 s | Above the 25 MB phone threshold → “simplified” prompt on phones |
| Building-Architecture | buildingSMART sample | IFC4X3_ADD2 | 0.1 MB | 0.01 s | 12 | 1 | – | |
| Building-Landscaping | buildingSMART sample | IFC4X3_ADD2 | 1.1 MB | 0.02 s | 7 | 1* | 1.0 s | *No `IfcBuildingStorey` → a single “Model” level is created |
| **Textured cottage** (bundled sample) | This repo, IfcOpenShell | IFC4 | 74 KB + 228 KB images | 0.01 s | 27 | 1 | ~1 s | All IFC texture mechanisms, see below |
| pixel-texture fixture | web-ifc tests | IFC4 | 1 KB | – | 1 | – | – | Texture isn't attached to geometry, so it's ignored |

Sources: [web-ifc test models](https://github.com/ThatOpen/engine_web-ifc/tree/main/tests/ifcfiles/public),
[buildingSMART Sample-Test-Files](https://github.com/buildingSMART/Sample-Test-Files),
[youshengCode/IfcSampleFiles](https://github.com/youshengCode/IfcSampleFiles). These files are *not* committed to this repo.

## Textures

None of the real-world exports above contain textures. Revit, Archicad and Tekla write surface colours only, and
public textured IFC samples are essentially non-existent. `public/samples/textured-cottage/textured-cottage.ifc`
(authored by `scripts/make-textured-ifc.py`, schema-validated with IfcOpenShell, CC0 photo textures from ambientCG)
therefore covers each mechanism the IFC4 standard offers:

| Mechanism | Used on | Supported |
|---|---|---|
| `IfcSurfaceStyleWithTextures` + `IfcImageTexture` (external file), default mapping with `TextureTransform` scale | Brick walls, oak floor, deck, plaster | ✅ box-mapped in metres, scale from `TextureTransform` |
| `IfcIndexedTriangleTextureMap` (explicit UVs) on `IfcTriangulatedFaceSet` | Roof tiles, gable walls, lawn | ✅ UVs matched onto web-ifc's re-centred triangles |
| `IfcBlobTexture` (JPEG embedded in the IFC) | Garden path | ✅ |
| `IfcPixelTexture` (inline RGB pixels) | Doors | ✅ |
| Texture on material (`IfcMaterialDefinitionRepresentation`) | – | ✅ applied to elements via `IfcRelAssociatesMaterial` |
| IFC2x3 `IfcPresentationStyleAssignment` / `UrlReference` | – | ✅ (read path; no textured IFC2x3 sample available) |
| `IfcIndexedPolygonalTextureMap`, `IfcTextureCoordinateGenerator` | – | ⚠️ falls back to box mapping |

External images are resolved relative to the model URL (same origin only). When uploading, select or drop the
images together with the `.ifc`; missing images are listed on the model card and fall back to the material colour.

## Issues found and fixed during this test pass

* **Roofs modelled as slabs** (`IfcSlab` inside `IfcRoof`, `PredefinedType=ROOF`, or mostly-tilted faces) now get the roof material instead of timber flooring.
* **Absolute vs. relative storey heights**: when slab/wall geometry consistently sits more than 5 m away from `IfcBuildingStorey.Elevation`, the offset is applied. Plans, ground plane, minimap and “Go inside” are now correct for georeferenced Archicad exports.
* **Site/terrain framing**: lawns, topography and `IfcGeographicElement` are excluded from camera framing, the minimap and drawing extents.
* **No storeys** (IFC4.3 infrastructure): a single “Model” level is created.
* **Green ≠ grass**: only site-like elements get the grass material. Other green elements (e.g. carpet) keep their own colour.
* **Large models in 2D**: edges use Babylon's fast edge finder (O(n log n)), and meshes over 20k triangles skip edges. The dental clinic plan went from hanging the tab to ~3.4 s.
* **“Go inside”** tries every storey (nearest ground level first) and tolerates floor finishes above the structural level.
