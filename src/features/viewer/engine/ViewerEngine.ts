import {
  Engine, Scene, Color3, Color4, Vector3, Mesh, VertexData, DirectionalLight, HemisphericLight, CascadedShadowGenerator,
  DefaultRenderingPipeline, SSAO2RenderingPipeline, SSRRenderingPipeline, ImageProcessingConfiguration, CubeTexture,
  UniversalCamera, ArcRotateCamera, Ray, MeshBuilder, DynamicTexture, StandardMaterial, Matrix, type AbstractMesh,
  type Observer, type Nullable, type Camera, PBRMaterial, Texture, Material, TransformNode, Quaternion, Plane, type PickingInfo,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials/sky/skyMaterial';
import type { ModelData, ModelElement } from '@shared/model/types';
import { focusBBox } from '@shared/model/types';
import type { CameraSnapshot, Comment } from '@shared/comments/model';
import { CATEGORY_ICON } from '@shared/comments/model';
import { MaterialLibrary } from './materials';
import { extractOpenings, type Opening, type Motion } from './openings';

export type Quality = 'low' | 'medium' | 'high';
export type CamMode = 'walk' | 'orbit';
export const EYE = 1.6;

export function isMobileDevice() {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600);
}
export function defaultQuality(): Quality {
  return isMobileDevice() ? 'low' : 'high';
}

interface PresetCfg { scale: number; shadowMap: number; cascades: number; ssao: number; ssr: boolean; bloom: boolean; msaa: number; texSize: number }
const PRESETS: Record<Quality, PresetCfg> = {
  low: { scale: 1.4, shadowMap: 1024, cascades: 2, ssao: 0, ssr: false, bloom: false, msaa: 1, texSize: 256 },
  medium: { scale: 1.15, shadowMap: 2048, cascades: 3, ssao: 0.5, ssr: false, bloom: true, msaa: 1, texSize: 512 },
  high: { scale: 1, shadowMap: 2048, cascades: 4, ssao: 0.75, ssr: true, bloom: true, msaa: 4, texSize: 512 },
};

export interface PickResult {
  element: ModelElement | null;
  point: Vector3;
  normal: Vector3;
}

const NO_COLLIDE = /Window|Door|Furnishing|Covering|Member/;

/** Game-like walking speeds (m/s). */
export const WALK_SPEED = 4.3;
export const RUN_SPEED = 7.5;
const TURN_SPEED = 2.2; // rad/s for the arrow keys
const REACH = 3.2; // how far away you can open a door (m)
/** height of the horizontal section cut above a floor, like a plan drawing (m) */
export const SECTION_CUT = 1.3;

/** A door/window in the scene, with its animation state. */
export interface OpeningRT extends Omit<Opening, 'leaves'> {
  open: boolean;
  /** animation progress 0 (closed) … 1 (open) */
  t: number;
  leaves: { node: TransformNode; motion: Motion; base: Vector3; sign: number; meshes: Mesh[] }[];
}

/** Box-mapped world-space UVs (1 unit = 1 m) so procedural textures look right on IFC geometry. */
function boxUVs(p: Float32Array, n: Float32Array): Float32Array {
  const uv = new Float32Array((p.length / 3) * 2);
  for (let i = 0, j = 0; i < p.length; i += 3, j += 2) {
    const ax = Math.abs(n[i]), ay = Math.abs(n[i + 1]), az = Math.abs(n[i + 2]);
    if (ay >= ax && ay >= az) { uv[j] = p[i]; uv[j + 1] = p[i + 2]; }
    else if (ax >= az) { uv[j] = p[i + 2]; uv[j + 1] = p[i + 1]; }
    else { uv[j] = p[i]; uv[j + 1] = p[i + 1]; }
  }
  return uv;
}

export class ViewerEngine {
  engine: Engine;
  scene: Scene;
  walkCam!: UniversalCamera;
  orbitCam!: ArcRotateCamera;
  mode: CamMode = 'walk';
  quality: Quality;
  mats: MaterialLibrary;
  elements = new Map<string, ModelElement>();
  pickMeshes: Mesh[] = [];
  renderMeshes: Mesh[] = [];
  groundY = 0;
  sun!: DirectionalLight;
  hemi!: HemisphericLight;
  shadows: CascadedShadowGenerator | null = null;
  pipeline: DefaultRenderingPipeline | null = null;
  ssao: SSAO2RenderingPipeline | null = null;
  ssr: SSRRenderingPipeline | null = null;
  sky!: Mesh;
  skyMat!: SkyMaterial;
  pins = new Map<string, Mesh>();
  frozen = false;
  /** joystick input (-1..1): x = strafe, y = forward */
  move = { x: 0, y: 0 };
  hour = 15;
  visibleStoreyMax = Infinity;
  /** orbit-mode section: index into walkStoreys cut through, or null for the whole closed building */
  section: number | null = null;
  /** world height of the section plane (Infinity = no cut) */
  sectionY = Infinity;
  private tween: Nullable<Observer<Scene>> = null;
  private storeyOrder: string[] = [];
  fps = 0;
  /** doors & windows that open */
  openings: OpeningRT[] = [];
  private openingByElement = new Map<string, OpeningRT>();
  private leafMeshes: Mesh[] = [];
  /** the door/window you are looking at and close enough to use (walk mode) */
  focusOpening: OpeningRT | null = null;
  /** storeys you can stand on, low → high */
  walkStoreys: ModelData['storeys'] = [];
  private keys = new Set<string>();
  private vel = new Vector3();
  private frame = 0;

  /** building bounds (site/terrain excluded) used for framing */
  focus: ModelData['bbox'];

  constructor(public canvas: HTMLCanvasElement, public model: ModelData, quality: Quality) {
    this.quality = quality;
    this.focus = focusBBox(model);
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, antialias: false, powerPreference: 'high-performance' }, true);
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.93, 0.93, 0.92, 1);
    this.scene.skipPointerMovePicking = true;
    this.scene.collisionsEnabled = true;
    this.mats = new MaterialLibrary(this.scene, PRESETS[quality].texSize);
    this.storeyOrder = [...model.storeys].sort((a, b) => a.elevation - b.elevation).map((s) => s.name);
    const sorted = [...model.storeys].sort((a, b) => a.elevation - b.elevation);
    // floors you can walk around on: they have walls or stairs (not foundations or bare roof levels)
    const has = (st: { name: string }, re: RegExp) => model.elements.some((e) => e.storey === st.name && re.test(e.type));
    const walkable = sorted.filter((st) => has(st, /Wall|Stair/i) && !/fdn|found|footing/i.test(st.name));
    const floors = sorted.filter((st) => has(st, /Slab|Wall|Floor|Covering|Stair/i));
    this.walkStoreys = walkable.length ? walkable : floors.length ? floors : sorted;

    this.setupEnvironment();
    this.buildMeshes();
    this.setupCameras();
    this.applyQuality(quality);
    this.setTimeOfDay(this.hour);

    this.scene.onBeforeRenderObservable.add(() => this.tick());
    this.engine.runRenderLoop(() => {
      this.scene.render();
      this.fps = this.engine.getFps();
    });
    this.onResize = () => this.engine.resize();
    window.addEventListener('resize', this.onResize);
    this.onKey = (e: KeyboardEvent) => this.handleKey(e);
    this.onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }
  private onResize: () => void;
  private onKey: (e: KeyboardEvent) => void;
  private onBlur: () => void;
  /** called when you press E/F; return true if handled (the UI shows feedback) */
  onInteract: ((o: OpeningRT | null) => void) | null = null;

  // ---- keyboard (game-style: WASD/arrows, Shift to run, E or F to open/close) -----------
  private handleKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const down = e.type === 'keydown';
    const code = e.code;
    const MOVE = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
    if (MOVE.includes(code)) {
      if (down) this.keys.add(code); else this.keys.delete(code);
      if (this.mode === 'walk' && code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    if (down && !e.repeat && (code === 'KeyE' || code === 'KeyF') && this.mode === 'walk' && !this.frozen) {
      this.updateFocus();
      const o = this.focusOpening;
      if (o) this.toggleOpening(o);
      this.onInteract?.(o);
    }
  }

  // ---- scene setup -------------------------------------------------------------
  private setupEnvironment() {
    const s = this.scene;
    const env = CubeTexture.CreateFromPrefilteredData(`${import.meta.env.BASE_URL}env/environment.env`, s);
    s.environmentTexture = env;
    s.environmentIntensity = 0.9;
    this.hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), s);
    this.hemi.intensity = 0.15;
    this.hemi.groundColor = new Color3(0.35, 0.33, 0.3);
    this.sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.3), s);
    this.sun.intensity = 3;

    this.skyMat = new SkyMaterial('sky', s);
    this.skyMat.backFaceCulling = false;
    this.skyMat.useSunPosition = true;
    this.skyMat.turbidity = 6;
    this.skyMat.luminance = 1;
    this.skyMat.rayleigh = 1.6;
    this.sky = MeshBuilder.CreateBox('skybox', { size: 2000 }, s);
    this.sky.material = this.skyMat;
    this.sky.infiniteDistance = true;
    this.sky.isPickable = false;

    const ip = s.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.1;
    ip.contrast = 1.1;
  }

  private buildMeshes() {
    const s = this.scene;
    const m = this.model;
    // Ground height: lowest storey near 0 (ignores foundation levels).
    const st = [...m.storeys].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
    this.groundY = (st ? st.elevation : m.bbox.min[1]) - 0.03;
    const groups = new Map<string, Mesh[]>();
    const texById = new Map((m.textures ?? []).map((t) => [t.id, t]));
    for (const e of m.elements) this.elements.set(e.id, e);
    let split: ReturnType<typeof extractOpenings> = { statics: m.elements, openings: [] };
    try { split = extractOpenings(m); } catch (err) { console.warn('door/window detection failed', err); }
    for (const e of split.statics) {
      const mesh = new Mesh(`el-${e.id}`, s);
      const vd = new VertexData();
      vd.positions = e.positions;
      vd.normals = e.normals;
      vd.indices = e.indices;
      vd.uvs = e.uvs && e.uvs.length === (e.positions.length / 3) * 2 ? e.uvs : boxUVs(e.positions, e.normals);
      vd.applyToMesh(mesh, false);
      const tex = e.texture ? texById.get(e.texture) : undefined;
      mesh.material = tex ? this.mats.getTextured(tex, e.material, !!e.uvs, e.color) : this.mats.get(e.material, e.color);
      mesh.metadata = { elementId: e.id };
      mesh.isVisible = false; // rendering uses merged meshes below; this one is for picking/collisions
      mesh.checkCollisions = e.material !== 'glass' && !NO_COLLIDE.test(e.type);
      mesh.freezeWorldMatrix();
      this.pickMeshes.push(mesh);
      const key = `${e.storey}|${(mesh.material as PBRMaterial).name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(mesh);
    }
    // Merge per storey+material: few draw calls, still able to hide storeys (cutaway).
    for (const [key, list] of groups) {
      const clones = list.map((x) => { const c = x.clone(`${x.name}-r`, null, true, false) as Mesh; c.isVisible = true; return c; });
      const merged = Mesh.MergeMeshes(clones, true, true, undefined, false, false);
      if (!merged) continue;
      merged.name = `render-${key}`;
      merged.isPickable = false;
      merged.checkCollisions = false;
      merged.metadata = { storey: key.split('|')[0] };
      merged.receiveShadows = true;
      merged.freezeWorldMatrix();
      this.renderMeshes.push(merged);
    }
    this.buildOpenings(split.openings, texById);
    // Ground & site
    const ground = new Mesh('ground', s);
    const G = 400, y = this.groundY;
    const gp = new Float32Array([-G, y, -G, -G, y, G, G, y, G, G, y, -G]);
    const gn = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const gvd = new VertexData();
    gvd.positions = gp; gvd.normals = gn; gvd.indices = [0, 1, 2, 0, 2, 3]; gvd.uvs = boxUVs(gp, gn);
    gvd.applyToMesh(ground);
    ground.material = this.mats.get('grass');
    ground.receiveShadows = true;
    ground.checkCollisions = true;
    ground.metadata = { ground: true };
    ground.freezeWorldMatrix();
    this.pickMeshes.push(ground);
  }

  /** Separate, animatable meshes for each door/window leaf, pivoting about its hinge. */
  private buildOpenings(list: Opening[], texById: Map<string, NonNullable<ModelData['textures']>[number]>) {
    const s = this.scene;
    for (const o of list) {
      const rt: OpeningRT = { ...o, open: false, t: 0, leaves: [] };
      for (const [li, leaf] of o.leaves.entries()) {
        const m = leaf.motion;
        let base: Vector3;
        if (m.type === 'rotate') base = Vector3.FromArray(m.pivot);
        else {
          let x = 0, y = 0, z = 0, n = 0;
          for (const p of leaf.parts) for (let i = 0; i < p.positions.length; i += 3) { x += p.positions[i]; y += p.positions[i + 1]; z += p.positions[i + 2]; n++; }
          base = new Vector3(x / n, y / n, z / n);
        }
        const node = new TransformNode(`opening-${o.id}-${li}`, s);
        node.position = base.clone();
        node.rotationQuaternion = Quaternion.Identity();
        const meshes: Mesh[] = [];
        for (const part of leaf.parts) {
          const mesh = new Mesh(`leaf-${part.id}`, s);
          const pos = new Float32Array(part.positions.length);
          for (let i = 0; i < pos.length; i += 3) { pos[i] = part.positions[i] - base.x; pos[i + 1] = part.positions[i + 1] - base.y; pos[i + 2] = part.positions[i + 2] - base.z; }
          const vd = new VertexData();
          vd.positions = pos;
          vd.normals = part.normals;
          vd.indices = part.indices;
          vd.uvs = part.uvs && part.uvs.length === (part.positions.length / 3) * 2 ? part.uvs : boxUVs(part.positions, part.normals);
          vd.applyToMesh(mesh, false);
          const tex = part.texture ? texById.get(part.texture) : undefined;
          mesh.material = tex ? this.mats.getTextured(tex, part.material, !!part.uvs, part.color) : this.mats.get(part.material, part.color);
          mesh.parent = node;
          mesh.metadata = { elementId: part.id, openingId: o.id };
          mesh.receiveShadows = true;
          mesh.checkCollisions = o.kind === 'door' && part.material !== 'glass';
          meshes.push(mesh);
          this.pickMeshes.push(mesh);
          this.leafMeshes.push(mesh);
          this.openingByElement.set(part.id, rt);
        }
        // which way round to rotate so the free edge goes the right way
        let sign = 1;
        if (m.type === 'rotate' && m.toward) sign = this.rotateSign(m, Vector3.FromArray(m.toward));
        rt.leaves.push({ node, motion: m, base, sign, meshes });
      }
      this.openings.push(rt);
    }
    // frames of operable doors/windows also count as "the door" when you look at them
    for (const o of this.openings) {
      const ex = this.model.elements.find((e) => this.openingByElement.get(e.id) === o)?.expressId;
      if (ex === undefined) continue;
      for (const e of this.model.elements) if (e.expressId === ex && !this.openingByElement.has(e.id)) this.openingByElement.set(e.id, o);
    }
  }

  private rotateSign(m: Extract<Motion, { type: 'rotate' }>, toward: Vector3): number {
    const pivot = Vector3.FromArray(m.pivot), probe = Vector3.FromArray(m.probe).subtract(pivot);
    const q = Quaternion.RotationAxis(Vector3.FromArray(m.axis), Math.min(m.angle, Math.PI / 2));
    const moved = probe.rotateByQuaternionToRef(q, new Vector3()).subtract(probe);
    return Vector3.Dot(moved, toward) >= 0 ? 1 : -1;
  }

  /** Open or close a door/window (animated). */
  toggleOpening(o: OpeningRT, open = !o.open) {
    if (open && !o.open) {
      // doors that swing both ways (or whose direction the model doesn't give) swing away from you
      const cam = this.scene.activeCamera!.position;
      const away = Vector3.Dot(cam.subtract(Vector3.FromArray(o.center)), new Vector3(o.ay[0], 0, o.ay[1])) > 0 ? -1 : 1;
      const toward = new Vector3(o.ay[0] * away, 0, o.ay[1] * away);
      for (const l of o.leaves) if (l.motion.type === 'rotate' && !l.motion.toward) l.sign = this.rotateSign(l.motion, toward);
    }
    o.open = open;
    // a moving or open leaf never blocks you
    for (const l of o.leaves) for (const m of l.meshes) m.checkCollisions = false;
  }

  /** Open/close every door (and optionally window) at once, e.g. for a design preview. */
  setAllOpen(open: boolean, kinds: OpeningRT['kind'][] = ['door'], animate = true) {
    for (const o of this.openings) {
      if (!kinds.includes(o.kind)) continue;
      this.toggleOpening(o, open);
      if (!animate) { o.t = open ? 1 : 0; this.poseOpening(o); this.settleOpening(o); }
    }
  }

  private poseOpening(o: OpeningRT) {
    const k = o.t, e = k * k * (3 - 2 * k); // smoothstep
    for (const l of o.leaves) {
      if (l.motion.type === 'rotate') {
        Quaternion.RotationAxisToRef(Vector3.FromArray(l.motion.axis), l.sign * l.motion.angle * e, l.node.rotationQuaternion!);
      } else {
        const off = l.motion.offset;
        l.node.position.set(l.base.x + off[0] * e, l.base.y + off[1] * e, l.base.z + off[2] * e);
      }
    }
  }

  private settleOpening(o: OpeningRT) {
    if (o.t === 0 && !o.open) for (const l of o.leaves) for (const m of l.meshes) {
      m.checkCollisions = o.kind === 'door' && (this.elements.get(m.metadata.elementId)?.material ?? 'glass') !== 'glass';
    }
  }

  private animateOpenings(dt: number) {
    for (const o of this.openings) {
      const target = o.open ? 1 : 0;
      if (o.t === target) continue;
      const dur = o.kind === 'door' ? 0.75 : 0.6;
      o.t = target > o.t ? Math.min(1, o.t + dt / dur) : Math.max(0, o.t - dt / dur);
      this.poseOpening(o);
      if (o.t === target) this.settleOpening(o);
    }
  }

  /** The door/window under the crosshair (or right in front of you) within reach. */
  updateFocus() {
    if (this.mode !== 'walk' || this.frozen || !this.openings.length) { this.focusOpening = null; return; }
    const cam = this.walkCam;
    const fwd = cam.getTarget().subtract(cam.position).normalize();
    const hit = this.scene.pickWithRay(new Ray(cam.position, fwd, REACH), (m) => this.pickMeshes.includes(m as Mesh) && m.isEnabled() && !m.metadata?.ground);
    let found: OpeningRT | null = null;
    if (hit?.hit && hit.pickedMesh) found = this.openingByElement.get(hit.pickedMesh.metadata?.elementId) ?? null;
    if (!found) {
      // nothing exactly under the crosshair: nearest one roughly ahead of you
      let best = Infinity;
      const f2 = new Vector3(fwd.x, 0, fwd.z).normalize();
      for (const o of this.openings) {
        const d = new Vector3(o.center[0] - cam.position.x, 0, o.center[2] - cam.position.z);
        const dist = d.length();
        if (dist > 2.4 || Math.abs(o.center[1] - cam.position.y) > 2) continue;
        if (!this.isOpeningVisible(o)) continue;
        if (dist > 0.4 && Vector3.Dot(d.scale(1 / dist), f2) < 0.55) continue;
        if (dist < best) { best = dist; found = o; }
      }
    }
    this.focusOpening = found;
  }

  private isOpeningVisible(o: OpeningRT) {
    return o.leaves.some((l) => l.meshes.some((m) => m.isEnabled()));
  }

  /** Door/window at a screen point (tap), if within a few metres. */
  openingAt(x: number, y: number): OpeningRT | null {
    const r = this.pickVisible(x, y, (m) => this.pickMeshes.includes(m as Mesh) && m.isEnabled());
    if (!r?.hit || !r.pickedMesh || r.distance > REACH + 2) return null;
    return this.openingByElement.get(r.pickedMesh.metadata?.elementId) ?? null;
  }

  get center(): Vector3 {
    const b = this.focus;
    return new Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  }
  get size(): number {
    const b = this.focus;
    return Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], b.max[1] - b.min[1]);
  }

  private setupCameras() {
    const s = this.scene;
    const b = this.focus;
    const c = this.center;
    // Walk camera starts outside, in front of the long side, looking at the building.
    const front = new Vector3(c.x, this.groundY + EYE, b.max[2] + Math.max(5, this.size * 0.28));
    this.walkCam = new UniversalCamera('walk', front, s);
    this.walkCam.setTarget(new Vector3(c.x, this.groundY + EYE, c.z));
    this.walkCam.minZ = 0.05;
    this.walkCam.maxZ = 3000;
    this.walkCam.fov = 1.05;
    this.walkCam.speed = 1;
    // we move the camera ourselves (game-style velocity); raw mouse look
    this.walkCam.inertia = 0;
    this.walkCam.angularSensibility = 900;
    this.walkCam.checkCollisions = true;
    this.walkCam.applyGravity = false;
    this.walkCam.ellipsoid = new Vector3(0.25, 0.6, 0.25);
    // We handle keys (WASD, arrows, Shift, E) and touch (joystick + drag-to-look) ourselves
    this.walkCam.inputs.removeByType('FreeCameraKeyboardMoveInput');
    this.walkCam.inputs.removeByType('FreeCameraTouchInput');

    this.orbitCam = new ArcRotateCamera('orbit', -Math.PI / 3, 1.0, this.size * 1.6, c.clone(), s);
    this.orbitCam.lowerRadiusLimit = 2;
    this.orbitCam.upperRadiusLimit = Math.max(this.size * 5, 60);
    this.orbitCam.upperBetaLimit = Math.PI / 2 - 0.02;
    this.orbitCam.wheelDeltaPercentage = 0.02;
    this.orbitCam.pinchDeltaPercentage = 0.004;
    this.orbitCam.panningSensibility = 60;
    this.orbitCam.minZ = 0.1;
    this.orbitCam.maxZ = 3000;
    this.setMode('walk');
  }

  setMode(mode: CamMode) {
    this.mode = mode;
    // a section is an overview tool: walking always happens in the whole building
    if (mode === 'walk' && this.section !== null) this.setSection(null, false);
    const cam: Camera = mode === 'walk' ? this.walkCam : this.orbitCam;
    this.scene.activeCamera?.detachControl();
    this.scene.activeCamera = cam;
    if (!this.frozen) cam.attachControl(true);
    this.rebuildPipeline();
  }

  setFrozen(f: boolean) {
    this.frozen = f;
    this.move = { x: 0, y: 0 };
    this.keys.clear();
    this.vel.setAll(0);
    if (f) this.scene.activeCamera?.detachControl();
    else this.scene.activeCamera?.attachControl(true);
    if (f && document.pointerLockElement) document.exitPointerLock();
  }

  // ---- quality ----------------------------------------------------------------------
  applyQuality(q: Quality) {
    this.quality = q;
    const p = PRESETS[q];
    const dpr = window.devicePixelRatio || 1;
    this.engine.setHardwareScalingLevel(q === 'high' ? 1 : Math.max(1, (dpr / Math.min(dpr, 2)) * p.scale));
    this.shadows?.dispose();
    const csm = new CascadedShadowGenerator(p.shadowMap, this.sun);
    csm.numCascades = p.cascades;
    csm.lambda = 0.85;
    csm.stabilizeCascades = true;
    csm.shadowMaxZ = Math.max(60, this.size * 3);
    csm.autoCalcDepthBounds = q !== 'low';
    csm.filteringQuality = q === 'low' ? CascadedShadowGenerator.QUALITY_LOW : CascadedShadowGenerator.QUALITY_MEDIUM;
    csm.usePercentageCloserFiltering = true;
    csm.bias = 0.004;
    csm.normalBias = 0.02;
    csm.darkness = 0.15;
    for (const m of this.renderMeshes) if (!/glass/.test(m.name)) csm.addShadowCaster(m, false);
    for (const m of this.leafMeshes) if ((this.elements.get(m.metadata.elementId)?.material ?? 'glass') !== 'glass') csm.addShadowCaster(m, false);
    this.shadows = csm;
    this.rebuildPipeline();
  }

  private rebuildPipeline() {
    const p = PRESETS[this.quality];
    const cam = this.scene.activeCamera;
    if (!cam) return;
    this.pipeline?.dispose();
    this.ssao?.dispose();
    this.ssr?.dispose();
    this.ssao = null;
    this.ssr = null;
    const pipe = new DefaultRenderingPipeline('pipe', true, this.scene, [cam]);
    pipe.samples = p.msaa;
    pipe.fxaaEnabled = true;
    pipe.imageProcessingEnabled = true;
    pipe.imageProcessing.toneMappingEnabled = true;
    pipe.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipe.imageProcessing.exposure = 1.1;
    pipe.imageProcessing.contrast = 1.1;
    pipe.imageProcessing.vignetteEnabled = true;
    pipe.imageProcessing.vignetteWeight = 1.2;
    pipe.imageProcessing.vignetteStretch = 0.4;
    pipe.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);
    pipe.bloomEnabled = p.bloom;
    pipe.bloomThreshold = 0.85;
    pipe.bloomWeight = 0.25;
    pipe.bloomKernel = 48;
    pipe.bloomScale = 0.5;
    this.pipeline = pipe;
    if (p.ssao > 0 && this.engine.webGLVersion >= 2) {
      try {
        const ssao = new SSAO2RenderingPipeline('ssao', this.scene, { ssaoRatio: p.ssao, blurRatio: p.ssao }, [cam]);
        ssao.radius = 0.6;
        ssao.totalStrength = 1.1;
        ssao.samples = this.quality === 'high' ? 16 : 8;
        ssao.maxZ = 60;
        ssao.expensiveBlur = this.quality === 'high';
        this.ssao = ssao;
      } catch (e) { console.warn('SSAO unavailable', e); }
    }
    if (p.ssr && !isMobileDevice() && this.engine.webGLVersion >= 2) {
      try {
        const ssr = new SSRRenderingPipeline('ssr', this.scene, [cam], false);
        ssr.strength = 0.6;
        ssr.reflectionSpecularFalloffExponent = 3;
        ssr.maxDistance = 40;
        ssr.step = 0.15;
        ssr.thickness = 0.4;
        ssr.blurDispersionStrength = 0.03;
        ssr.roughnessFactor = 0.2;
        this.ssr = ssr;
      } catch (e) { console.warn('SSR unavailable', e); }
    }
  }

  /** Where north points, in degrees clockwise from -Z (plan "up"). Turns the sun path with it. */
  northAngle = 0;
  setNorth(deg: number) {
    this.northAngle = deg;
    this.setTimeOfDay(this.hour);
  }

  /** Sun position from hour of day (6–20). */
  setTimeOfDay(hour: number) {
    this.hour = hour;
    const t = (hour - 6) / 14; // 0 sunrise … 1 sunset
    const elev = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * (Math.PI / 3) + 0.04;
    const az = Math.PI * t; // east → north → west (southern hemisphere feel)
    const th = (this.northAngle * Math.PI) / 180;
    // east and north on the ground plane (x, z), rotated by the plan's north angle
    const ex = Math.cos(th), ez = Math.sin(th), nx = Math.sin(th), nz = -Math.cos(th);
    const h = Math.cos(elev);
    const dir = new Vector3((ex * Math.cos(az) + nx * Math.sin(az)) * h, Math.sin(elev), (ez * Math.cos(az) + nz * Math.sin(az)) * h).normalize();
    this.sun.direction = dir.scale(-1);
    const warm = 1 - Math.min(1, Math.sin(elev) * 2.2);
    this.sun.diffuse = new Color3(1, 0.93 - warm * 0.3, 0.85 - warm * 0.5);
    this.sun.intensity = 0.6 + Math.sin(elev) * 3.2;
    this.skyMat.sunPosition = dir.scale(100);
    this.skyMat.luminance = 1.05 - warm * 0.25;
    this.scene.environmentIntensity = 0.45 + Math.sin(elev) * 0.6;
    this.mats.setEnvIntensity(this.scene.environmentIntensity);
  }

  setStoreyCutaway(maxStorey: string | null) {
    const idx = maxStorey ? this.storeyOrder.indexOf(maxStorey) : Infinity;
    this.visibleStoreyMax = idx < 0 ? Infinity : idx;
    for (const m of this.renderMeshes) {
      const si = this.storeyOrder.indexOf(m.metadata?.storey);
      m.setEnabled(si <= this.visibleStoreyMax);
    }
    for (const p of this.pickMeshes) {
      const e = this.elements.get(p.metadata?.elementId);
      if (!e) continue;
      p.setEnabled(this.storeyOrder.indexOf(e.storey) <= this.visibleStoreyMax);
    }
  }

  /**
   * Horizontal section through the building, like a 3D floor plan (orbit view).
   * `idx` is a floor in walkStoreys: everything higher than SECTION_CUT above that floor is cut
   * away, so you look down into its rooms with the floors below still in place.
   * null shows the whole, closed building (roof on).
   */
  setSection(idx: number | null, reframe = true) {
    const st = idx === null ? null : this.walkStoreys[idx];
    this.section = st ? idx : null;
    this.sectionY = st ? st.elevation + SECTION_CUT : Infinity;
    // Babylon discards fragments on the positive side: y - cut > 0 → removed
    this.mats.setClipPlane(st ? new Plane(0, 1, 0, -this.sectionY) : null);
    for (const m of this.pins.values()) m.setEnabled(this.pinVisible(m.metadata.storey, m.position.y));
    if (reframe && this.mode === 'orbit') {
      // orbit around the cut floor (or the whole building), keeping the current viewing angle
      const c = this.orbitCam;
      const ty = st ? st.elevation + 0.5 : this.center.y;
      const dy = ty - c.target.y;
      if (Math.abs(dy) > 0.05) {
        const t = c.target.add(new Vector3(0, dy, 0)), p = c.position.add(new Vector3(0, dy, 0));
        this.flyTo({ position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], mode: 'orbit' }, 450);
      }
    }
  }

  private pinVisible(storey: string | undefined, y: number) {
    const e = storey ? this.storeyOrder.indexOf(storey) : -1;
    return (e < 0 || e <= this.visibleStoreyMax) && y <= this.sectionY + 0.4;
  }

  /** Nearest hit that is not cut away by the section plane. */
  private pickVisible(x: number, y: number, pred: (m: AbstractMesh) => boolean): PickingInfo | null {
    if (this.sectionY === Infinity) return this.scene.pick(x, y, pred);
    const hits = this.scene.multiPick(x, y, pred) ?? [];
    let best: PickingInfo | null = null;
    for (const h of hits) if (h.hit && h.pickedPoint && h.pickedPoint.y <= this.sectionY + 1e-3 && (!best || h.distance < best.distance)) best = h;
    return best;
  }

  // ---- per-frame: game-style movement + ground following (stairs, gravity) --------
  private fallSpeed = 0;
  private walkTarget: Vector3 | null = null;
  private tick() {
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    this.animateOpenings(dt);
    if (this.mode !== 'walk') return;
    const cam = this.walkCam;
    const k = this.keys;
    // input: x = strafe right, y = forward (keyboard + joystick)
    let ix = this.move.x, iy = this.move.y;
    if (!this.frozen) {
      if (k.has('KeyW') || k.has('ArrowUp')) iy += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) iy -= 1;
      if (k.has('KeyD')) ix += 1;
      if (k.has('KeyA')) ix -= 1;
      if (k.has('ArrowLeft')) cam.rotation.y -= TURN_SPEED * dt;
      if (k.has('ArrowRight')) cam.rotation.y += TURN_SPEED * dt;
    } else { ix = 0; iy = 0; }
    const mag = Math.hypot(ix, iy);
    if (mag > 1) { ix /= mag; iy /= mag; }
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const fwd = cam.getTarget().subtract(cam.position).normalize();
    fwd.y = 0; fwd.normalize();
    const right = Vector3.Cross(fwd, Vector3.Up()); // right-handed: forward × up = right
    const want = fwd.scale(iy).addInPlace(right.scale(ix)).scaleInPlace(run ? RUN_SPEED : WALK_SPEED);
    if (mag > 0.01) this.walkTarget = null;
    else if (this.walkTarget && !this.frozen) {
      const d = this.walkTarget.subtract(cam.position);
      d.y = 0;
      const len = d.length();
      if (len < 0.12) this.walkTarget = null;
      else want.copyFrom(d.scaleInPlace(Math.min(WALK_SPEED, len * 4) / len));
    }
    // quick acceleration / braking, like a game character
    const a = 1 - Math.exp(-dt * (want.lengthSquared() > 0.01 ? 12 : 16));
    this.vel.addInPlace(want.subtract(this.vel).scaleInPlace(a));
    if (this.vel.lengthSquared() < 1e-4) this.vel.setAll(0);
    else cam.cameraDirection.addInPlace(this.vel.scale(dt));
    // ground follow: ray from knee height downwards
    const origin = cam.position.subtract(new Vector3(0, EYE - 0.45, 0));
    const hit = this.scene.pickWithRay(new Ray(origin, new Vector3(0, -1, 0), 6), (m) => m.checkCollisions && m.isEnabled());
    if (hit?.hit && hit.pickedPoint) {
      const target = hit.pickedPoint.y + EYE;
      const diff = target - cam.position.y;
      if (diff > 0) { cam.position.y += Math.min(diff, 4 * dt + diff * 0.35); this.fallSpeed = 0; }
      else if (diff < -0.01) { this.fallSpeed = Math.min(12, this.fallSpeed + 9.8 * dt); cam.position.y = Math.max(target, cam.position.y - this.fallSpeed * dt); }
      else this.fallSpeed = 0;
    }
    if (++this.frame % 6 === 0) this.updateFocus();
  }

  // ---- floors & quick travel (minimap) -------------------------------------------------
  /** Index into walkStoreys of the floor at height y (camera height). */
  storeyIndexAt(y: number): number {
    let idx = 0;
    this.walkStoreys.forEach((st, i) => { if (st.elevation <= y - 1.0) idx = i; });
    return idx;
  }

  /** A spot you can stand on at (x, z) on a storey: eye position, or null if there's no floor there. */
  findSpot(x: number, z: number, storeyIdx: number): Vector3 | null {
    const st = this.walkStoreys[storeyIdx];
    if (!st) return null;
    const isFloor = (m: AbstractMesh) => m.checkCollisions && m.isEnabled();
    const top = st.elevation + 1.3;
    const down = this.scene.pickWithRay(new Ray(new Vector3(x, top, z), new Vector3(0, -1, 0), 2.2), isFloor);
    let y: number | null = null;
    if (down?.hit && down.pickedPoint && Math.abs(down.pickedPoint.y - st.elevation) < 0.9) y = down.pickedPoint.y;
    else if (storeyIdx === 0 || st.elevation <= this.groundY + 0.6) y = this.groundY;
    if (y === null) return null;
    // keep clear of walls
    const p = new Vector3(x, y + 1.0, z);
    const walls = (m: AbstractMesh) => m.checkCollisions && m.isEnabled() && !m.metadata?.ground;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, d = new Vector3(Math.cos(a), 0, Math.sin(a));
      const h = this.scene.pickWithRay(new Ray(p, d, 0.4), walls);
      if (h?.hit) p.subtractInPlace(d.scale(0.4 - h.distance));
    }
    return new Vector3(p.x, y + EYE, p.z);
  }

  /** Jump (or glide) to a point on the plan, keeping the view direction. */
  travelTo(x: number, z: number, storeyIdx: number, glide = true): boolean {
    let spot = this.findSpot(x, z, storeyIdx);
    if (!spot) spot = this.nearestSpot(x, z, storeyIdx);
    if (!spot) return false;
    this.walkTarget = null;
    this.vel.setAll(0);
    if (this.mode !== 'walk') this.setMode('walk');
    const cam = this.walkCam;
    const dir = cam.getTarget().subtract(cam.position).normalize();
    if (!glide) {
      this.cancelTween();
      cam.position.copyFrom(spot);
      this.fallSpeed = 0;
      return true;
    }
    const dist = Vector3.Distance(cam.position, spot);
    const tgt = spot.add(dir.scale(3));
    this.flyTo({ position: [spot.x, spot.y, spot.z], target: [tgt.x, tgt.y, tgt.z], mode: 'walk' }, Math.min(900, 250 + dist * 40));
    return true;
  }

  /** Closest standable spot on a storey to (x, z), searching outwards. */
  nearestSpot(x: number, z: number, storeyIdx: number): Vector3 | null {
    for (let r = 0.75; r <= 12; r += 0.75) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const s = this.findSpot(x + Math.cos(a) * r, z + Math.sin(a) * r, storeyIdx);
        if (s) return s;
      }
    }
    return null;
  }

  /** Go up/down to another floor, at the same place on the plan when possible. */
  goToStorey(idx: number): boolean {
    if (idx < 0 || idx >= this.walkStoreys.length) return false;
    const p = this.mode === 'walk' ? this.walkCam.position : this.center;
    if (this.travelTo(p.x, p.z, idx)) return true;
    return this.goInside(this.walkStoreys[idx].name);
  }

  private cancelTween() {
    if (this.tween) { this.scene.onBeforeRenderObservable.remove(this.tween); this.tween = null; }
  }

  walkTo(p: Vector3) { this.walkTarget = p.clone(); }

  /** Find a spot inside the building: the given storey, else storeys nearest ground level first. */
  goInside(storeyName?: string): boolean {
    const order = storeyName ? this.model.storeys.filter((s) => s.name === storeyName)
      : [...this.model.storeys].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation));
    return order.some((s) => this.goInsideStorey(s));
  }

  private goInsideStorey(st: ModelData['storeys'][number]): boolean {
    const y = st.elevation + 1.2;
    const b = this.focus, c = this.center;
    let best: Vector3 | null = null, bd = Infinity;
    const isCollider = (m: AbstractMesh) => m.checkCollisions && m.isEnabled() && !m.metadata?.ground;
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const x = b.min[0] + ((b.max[0] - b.min[0]) * (i + 0.5)) / 13, z = b.min[2] + ((b.max[2] - b.min[2]) * (j + 0.5)) / 13;
      const down = this.scene.pickWithRay(new Ray(new Vector3(x, y, z), new Vector3(0, -1, 0), 2), isCollider);
      if (!down?.hit || !down.pickedPoint || Math.abs(down.pickedPoint.y - st.elevation) > 0.6) continue;
      const up = this.scene.pickWithRay(new Ray(new Vector3(x, y, z), new Vector3(0, 1, 0), 4), isCollider);
      if (!up?.hit) continue; // must be under a ceiling
      let clear = true;
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h = this.scene.pickWithRay(new Ray(new Vector3(x, y, z), new Vector3(d[0], 0, d[1]), 0.8), isCollider);
        if (h?.hit) { clear = false; break; }
      }
      if (!clear) continue;
      const dd = (x - c.x) ** 2 + (z - c.z) ** 2;
      if (dd < bd) { bd = dd; best = new Vector3(x, down.pickedPoint.y + EYE, z); }
    }
    if (!best) return false;
    // face the most open direction
    let dir = new Vector3(1, 0, 0), far = -1;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, d = new Vector3(Math.cos(a), 0, Math.sin(a));
      const h = this.scene.pickWithRay(new Ray(best, d, 30), isCollider);
      const dist = h?.hit ? h.distance : 30;
      if (dist > far) { far = dist; dir = d; }
    }
    this.setMode('walk');
    const t = best.add(dir.scale(3));
    this.flyTo({ position: [best.x, best.y, best.z], target: [t.x, t.y - 0.3, t.z], mode: 'walk' });
    return true;
  }

  // ---- picking, snapshots, pins ------------------------------------------------------
  pick(x: number, y: number): PickResult | null {
    const r = this.pickVisible(x, y, (m) => this.pickMeshes.includes(m as Mesh) && m.isEnabled());
    if (!r?.hit || !r.pickedPoint) return null;
    const n = r.getNormal(true, true) ?? Vector3.Up();
    // face the camera
    const cam = this.scene.activeCamera!;
    if (Vector3.Dot(n, cam.position.subtract(r.pickedPoint)) < 0) n.scaleInPlace(-1);
    return { element: this.elements.get(r.pickedMesh?.metadata?.elementId) ?? null, point: r.pickedPoint, normal: n };
  }

  pickPin(x: number, y: number): string | null {
    const r = this.scene.pick(x, y, (m) => !!m.metadata?.commentId && m.isEnabled());
    return r?.hit ? r.pickedMesh!.metadata.commentId : null;
  }

  snapshot(): CameraSnapshot {
    if (this.mode === 'orbit') {
      const c = this.orbitCam;
      return { position: c.position.asArray() as [number, number, number], target: c.target.asArray() as [number, number, number], mode: 'orbit' };
    }
    const c = this.walkCam;
    return { position: c.position.asArray() as [number, number, number], target: c.getTarget().asArray() as [number, number, number], mode: 'walk' };
  }

  /** Small JPEG of the current view (rendered and read back in the same task). */
  async screenshot(width = 320): Promise<string> {
    try {
      this.scene.render();
      const src = this.canvas;
      const h = Math.round((width * src.height) / Math.max(1, src.width));
      const c = document.createElement('canvas');
      c.width = width; c.height = h;
      c.getContext('2d')!.drawImage(src, 0, 0, width, h);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      console.warn('screenshot failed', e);
      return '';
    }
  }

  /** Smoothly fly to a saved viewpoint. */
  flyTo(s: CameraSnapshot, ms = 900) {
    const mode: CamMode = s.mode === 'orbit' ? 'orbit' : 'walk';
    if (mode !== this.mode) this.setMode(mode);
    const toPos = Vector3.FromArray(s.position), toTgt = Vector3.FromArray(s.target);
    if (this.tween) this.scene.onBeforeRenderObservable.remove(this.tween);
    const cam = mode === 'walk' ? this.walkCam : this.orbitCam;
    const fromPos = cam.position.clone();
    const fromTgt = mode === 'walk' ? this.walkCam.getTarget().clone() : this.orbitCam.target.clone();
    const t0 = performance.now();
    this.walkTarget = null;
    this.tween = this.scene.onBeforeRenderObservable.add(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const pos = Vector3.Lerp(fromPos, toPos, e), tgt = Vector3.Lerp(fromTgt, toTgt, e);
      if (mode === 'walk') {
        this.walkCam.position.copyFrom(pos);
        this.walkCam.setTarget(tgt);
      } else {
        this.orbitCam.setTarget(tgt);
        this.orbitCam.setPosition(pos);
      }
      if (k >= 1 && this.tween) { this.scene.onBeforeRenderObservable.remove(this.tween); this.tween = null; }
    });
  }

  setPins(comments: Comment[], activeId?: string | null) {
    const keep = new Set(comments.map((c) => c.id));
    for (const [id, m] of this.pins) if (!keep.has(id)) { m.material?.dispose(true, true); m.dispose(); this.pins.delete(id); }
    for (const c of comments) {
      const key = `${c.status}|${c.role}|${c.category}|${activeId === c.id}`;
      let m = this.pins.get(c.id);
      if (m && m.metadata.key !== key) { m.material?.dispose(true, true); m.dispose(); m = undefined; }
      if (!m) {
        m = MeshBuilder.CreatePlane(`pin-${c.id}`, { size: 0.5 }, this.scene);
        m.billboardMode = Mesh.BILLBOARDMODE_ALL;
        const tex = new DynamicTexture(`pintex-${c.id}`, { width: 128, height: 128 }, this.scene, true);
        const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, 128, 128);
        ctx.fillStyle = c.status === 'resolved' ? '#7C8A80' : c.role === 'architect' ? '#1F2326' : '#A4502F';
        ctx.beginPath(); ctx.arc(64, 52, 40, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(36, 78); ctx.lineTo(92, 78); ctx.lineTo(64, 124); ctx.fill();
        ctx.lineWidth = activeId === c.id ? 10 : 6; ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.arc(64, 52, 40, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '40px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(c.status === 'resolved' ? '✓' : CATEGORY_ICON[c.category ?? 'question'], 64, 54);
        tex.hasAlpha = true;
        tex.update(true);
        const mat = new StandardMaterial(`pinmat-${c.id}`, this.scene);
        mat.diffuseTexture = tex;
        mat.emissiveColor = Color3.White();
        mat.disableLighting = true;
        mat.useAlphaFromDiffuseTexture = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.sideOrientation = Material.CounterClockWiseSideOrientation;
        m.material = mat;
        m.renderingGroupId = 1;
        m.metadata = { commentId: c.id, key, storey: c.anchor.storey };
        const p = Vector3.FromArray(c.anchor.position);
        const n = c.anchor.normal ? Vector3.FromArray(c.anchor.normal) : Vector3.Up();
        m.position = p.add(n.scale(0.05)).add(new Vector3(0, 0.27, 0));
        this.pins.set(c.id, m);
      }
      m.setEnabled(this.pinVisible(c.anchor.storey, m.position.y));
    }
  }

  project(p: Vector3): { x: number; y: number; visible: boolean } {
    const cam = this.scene.activeCamera!;
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    const v = Vector3.Project(p, Matrix.Identity(), this.scene.getTransformMatrix(), cam.viewport.toGlobal(w, h));
    const scale = this.engine.getHardwareScalingLevel();
    return { x: v.x * scale, y: v.y * scale, visible: v.z > 0 && v.z < 1 };
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.mats.dispose();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}

export { Texture };
