import {
  Engine, Scene, Color3, Color4, Vector3, Mesh, VertexData, DirectionalLight, HemisphericLight, CascadedShadowGenerator,
  DefaultRenderingPipeline, SSAO2RenderingPipeline, SSRRenderingPipeline, ImageProcessingConfiguration, CubeTexture,
  UniversalCamera, ArcRotateCamera, Ray, MeshBuilder, DynamicTexture, StandardMaterial, Matrix, type AbstractMesh,
  type Observer, type Nullable, type Camera, PBRMaterial, Texture, Material,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials/sky/skyMaterial';
import type { ModelData, ModelElement } from '@shared/model/types';
import { focusBBox } from '@shared/model/types';
import type { CameraSnapshot, Comment } from '@shared/comments/model';
import { CATEGORY_ICON } from '@shared/comments/model';
import { MaterialLibrary } from './materials';

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
  private tween: Nullable<Observer<Scene>> = null;
  private storeyOrder: string[] = [];
  fps = 0;

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
  }
  private onResize: () => void;

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
    for (const e of m.elements) {
      this.elements.set(e.id, e);
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
    this.walkCam.speed = 0.09;
    this.walkCam.inertia = 0.6;
    this.walkCam.angularSensibility = 2500;
    this.walkCam.checkCollisions = true;
    this.walkCam.applyGravity = false;
    this.walkCam.ellipsoid = new Vector3(0.25, 0.6, 0.25);
    this.walkCam.keysUp = [87, 38];
    this.walkCam.keysDown = [83, 40];
    this.walkCam.keysLeft = [65, 37];
    this.walkCam.keysRight = [68, 39];
    this.walkCam.keysUpward = [];
    this.walkCam.keysDownward = [];
    this.walkCam.keysRotateLeft = [81];
    this.walkCam.keysRotateRight = [69];
    // We handle touch ourselves (joystick + drag-to-look)
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
    const cam: Camera = mode === 'walk' ? this.walkCam : this.orbitCam;
    this.scene.activeCamera?.detachControl();
    this.scene.activeCamera = cam;
    if (!this.frozen) cam.attachControl(true);
    this.rebuildPipeline();
  }

  setFrozen(f: boolean) {
    this.frozen = f;
    this.move = { x: 0, y: 0 };
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

  /** Sun position from hour of day (6–20). */
  setTimeOfDay(hour: number) {
    this.hour = hour;
    const t = (hour - 6) / 14; // 0 sunrise … 1 sunset
    const elev = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * (Math.PI / 3) + 0.04;
    const az = Math.PI * t; // east → north → west (southern hemisphere feel)
    const dir = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), -Math.sin(az) * Math.cos(elev)).normalize();
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

  // ---- per-frame: joystick movement + ground following (stairs, gravity) ----------
  private fallSpeed = 0;
  private walkTarget: Vector3 | null = null;
  private tick() {
    if (this.mode !== 'walk') return;
    const cam = this.walkCam;
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    if (!this.frozen && (this.move.x || this.move.y)) {
      const fwd = cam.getTarget().subtract(cam.position);
      fwd.y = 0; fwd.normalize();
      const right = Vector3.Cross(fwd, Vector3.Up()); // right-handed: forward × up = right
      const v = fwd.scale(this.move.y).add(right.scale(this.move.x)).scale(0.9 * dt);
      cam.cameraDirection.addInPlace(v);
      this.walkTarget = null;
    }
    if (this.walkTarget && !this.frozen) {
      const d = this.walkTarget.subtract(cam.position);
      d.y = 0;
      const len = d.length();
      if (len < 0.15) this.walkTarget = null;
      else cam.cameraDirection.addInPlace(d.normalize().scale(Math.min(len * 0.4, 1.1 * dt)));
    }
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
    const r = this.scene.pick(x, y, (m) => this.pickMeshes.includes(m as Mesh) && m.isEnabled());
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
        m.metadata = { commentId: c.id, key };
        const p = Vector3.FromArray(c.anchor.position);
        const n = c.anchor.normal ? Vector3.FromArray(c.anchor.normal) : Vector3.Up();
        m.position = p.add(n.scale(0.05)).add(new Vector3(0, 0.27, 0));
        this.pins.set(c.id, m);
      }
      const e = c.anchor.storey ? this.storeyOrder.indexOf(c.anchor.storey) : -1;
      m.setEnabled(e < 0 || e <= this.visibleStoreyMax);
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
    this.mats.dispose();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}

export { Texture };
