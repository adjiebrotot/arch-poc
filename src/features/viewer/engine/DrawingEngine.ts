import {
  Engine, Scene, Color4, Color3, Vector3, Vector4, Mesh, VertexData, ShaderMaterial, Effect, FreeCamera, Camera, Plane, Matrix,
} from '@babylonjs/core';
import type { ModelData, ModelElement } from '@shared/model/types';
import { focusBBox } from '@shared/model/types';

export type DrawingKind = 'plan' | 'rcp' | 'section-a' | 'section-b' | 'elev-n' | 'elev-s' | 'elev-e' | 'elev-w';

export const DRAWINGS: { id: DrawingKind; label: string; short: string; perStorey: boolean }[] = [
  { id: 'plan', label: 'Floor plan', short: 'Plan', perStorey: true },
  { id: 'rcp', label: 'Reflected ceiling plan', short: 'Ceiling', perStorey: true },
  { id: 'section-a', label: 'Section A–A (long)', short: 'Section A', perStorey: false },
  { id: 'section-b', label: 'Section B–B (cross)', short: 'Section B', perStorey: false },
  { id: 'elev-n', label: 'North elevation', short: 'North', perStorey: false },
  { id: 'elev-s', label: 'South elevation', short: 'South', perStorey: false },
  { id: 'elev-e', label: 'East elevation', short: 'East', perStorey: false },
  { id: 'elev-w', label: 'West elevation', short: 'West', perStorey: false },
];

Effect.ShadersStore['drawingVertexShader'] = `
precision highp float;
attribute vec3 position; attribute vec3 normal;
uniform mat4 world; uniform mat4 viewProjection;
varying vec3 vPos; varying vec3 vN;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPos = wp.xyz; vN = normalize(mat3(world) * normal);
  gl_Position = viewProjection * wp;
}`;
Effect.ShadersStore['drawingFragmentShader'] = `
precision highp float;
varying vec3 vPos; varying vec3 vN;
uniform vec4 cutPlane; uniform vec3 viewDir; uniform vec3 fill; uniform float alpha;
void main() {
  if (dot(cutPlane.xyz, vPos) + cutPlane.w > 0.0) discard;
  vec3 n = normalize(vN);
  float facing = dot(n, viewDir);
  // Seeing the inside of a solid means it was cut: draw it as solid poché.
  if (facing > 0.02) { gl_FragColor = vec4(0.13, 0.15, 0.16, 1.0); return; }
  float shade = 0.80 + 0.20 * abs(facing);
  gl_FragColor = vec4(fill * shade, alpha);
}`;

function fillFor(e: ModelElement): [number, number, number, number] {
  if (e.material === 'glass') return [0.78, 0.88, 0.95, 0.85];
  if (/Slab|Covering/.test(e.type)) return [0.985, 0.98, 0.97, 1];
  if (/Furnish/.test(e.type)) return [0.93, 0.93, 0.92, 1];
  if (e.material === 'grass') return [0.9, 0.94, 0.88, 1];
  return [1, 1, 1, 1];
}

export interface ViewState { cx: number; cy: number; half: number }

export class DrawingEngine {
  engine: Engine;
  scene: Scene;
  cam: FreeCamera;
  meshes: { mesh: Mesh; el: ModelElement; mat: ShaderMaterial; ymin: number; ymax: number }[] = [];
  kind: DrawingKind = 'plan';
  storey = '';
  view: ViewState = { cx: 0, cy: 0, half: 10 };
  cut: Vector4 = new Vector4(0, 1, 0, -1e6);
  viewDir = new Vector3(0, -1, 0);
  dirty = true;
  onViewChange: (() => void) | null = null;
  private storeyOrder: { name: string; elevation: number }[];

  constructor(public canvas: HTMLCanvasElement, public model: ModelData) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }, true);
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(1, 1, 1, 1);
    this.scene.skipPointerMovePicking = true;
    this.storeyOrder = [...model.storeys].sort((a, b) => a.elevation - b.elevation);
    this.cam = new FreeCamera('ortho', new Vector3(0, 100, 0), this.scene);
    this.cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.cam.minZ = 0.1;
    this.cam.maxZ = 2000;
    for (const e of model.elements) {
      const m = new Mesh(`d-${e.id}`, this.scene);
      const vd = new VertexData();
      vd.positions = e.positions; vd.normals = e.normals; vd.indices = e.indices;
      vd.applyToMesh(m);
      const mat = new ShaderMaterial(`dm-${e.id}`, this.scene, 'drawing', {
        attributes: ['position', 'normal'],
        uniforms: ['world', 'viewProjection', 'cutPlane', 'viewDir', 'fill', 'alpha'],
        needAlphaBlending: e.material === 'glass',
      });
      mat.backFaceCulling = false;
      const f = fillFor(e);
      mat.setColor3('fill', new Color3(f[0], f[1], f[2]));
      mat.setFloat('alpha', f[3]);
      m.material = mat;
      m.metadata = { elementId: e.id };
      // Fast O(n log n) edge finder; very heavy meshes (detailed furniture/MEP) get no edges.
      if (e.material !== 'glass' && e.indices.length / 3 < 20000) {
        m.enableEdgesRendering(0.98, false, { useAlternateEdgeFinder: true, useFastVertexMerger: true });
        m.edgesWidth = 2.2;
        m.edgesColor = new Color4(0.22, 0.24, 0.26, 1);
      }
      let ymin = Infinity, ymax = -Infinity;
      for (let i = 1; i < e.positions.length; i += 3) { ymin = Math.min(ymin, e.positions[i]); ymax = Math.max(ymax, e.positions[i]); }
      m.freezeWorldMatrix();
      this.meshes.push({ mesh: m, el: e, mat, ymin, ymax });
    }
    this.engine.runRenderLoop(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.scene.render();
    });
    this.resizeObs = new ResizeObserver(() => { this.engine.resize(); this.applyCamera(); });
    this.resizeObs.observe(canvas);
  }
  private resizeObs: ResizeObserver;

  storeyElevation(name: string) { return this.storeyOrder.find((s) => s.name === name)?.elevation ?? 0; }
  nextStoreyElevation(name: string) {
    const i = this.storeyOrder.findIndex((s) => s.name === name);
    return this.storeyOrder[i + 1]?.elevation ?? this.storeyElevation(name) + 3;
  }

  /** Configure cut plane, camera direction and visible elements for a drawing type. */
  setDrawing(kind: DrawingKind, storey: string) {
    this.kind = kind;
    this.storey = storey;
    const b = focusBBox(this.model);
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const elev = this.storeyElevation(storey);
    const next = this.nextStoreyElevation(storey);
    let cut = new Vector4(0, 1, 0, -1e6); // nothing cut
    let dir = new Vector3(0, -1, 0), up = new Vector3(0, 0, -1);
    let visible = (_m: (typeof this.meshes)[number]) => true;
    switch (kind) {
      case 'plan': {
        const h = elev + 1.2;
        cut = new Vector4(0, 1, 0, -h);
        visible = (m) => (m.el.storey === storey || (m.ymin < h && m.ymax > elev - 0.05)) && m.ymax > elev - 0.4;
        break;
      }
      case 'rcp': {
        const h = next - 0.35;
        cut = new Vector4(0, -1, 0, h); // keep only what is above the cut
        dir = new Vector3(0, 1, 0);
        visible = (m) => m.ymax > h && m.ymin < next + 0.5;
        break;
      }
      case 'section-a':
        cut = new Vector4(-1, 0, 0, cx); // remove x < cx… keep the far half
        dir = new Vector3(1, 0, 0); up = new Vector3(0, 1, 0);
        break;
      case 'section-b':
        cut = new Vector4(0, 0, -1, cz);
        dir = new Vector3(0, 0, 1); up = new Vector3(0, 1, 0);
        break;
      case 'elev-n': dir = new Vector3(0, 0, 1); up = new Vector3(0, 1, 0); break;
      case 'elev-s': dir = new Vector3(0, 0, -1); up = new Vector3(0, 1, 0); break;
      case 'elev-e': dir = new Vector3(-1, 0, 0); up = new Vector3(0, 1, 0); break;
      case 'elev-w': dir = new Vector3(1, 0, 0); up = new Vector3(0, 1, 0); break;
    }
    this.cut = cut;
    this.viewDir = dir;
    // Babylon clip plane: removes points where dot(n,p)+d > 0 — same convention, so edges get clipped too.
    this.scene.clipPlane = new Plane(cut.x, cut.y, cut.z, cut.w);
    for (const m of this.meshes) {
      const on = visible(m) && !(kind.startsWith('elev') && /Furnish/.test(m.el.type));
      m.mesh.setEnabled(on);
      m.mat.setVector4('cutPlane', cut);
      m.mat.setVector3('viewDir', dir);
    }
    const c = new Vector3(cx, (b.min[1] + b.max[1]) / 2, cz);
    this.cam.position = c.subtract(dir.scale(200));
    this.cam.upVector = up;
    this.cam.setTarget(c);
    this.fit();
  }

  /** Screen-space axes of the current view in world coordinates. */
  private axes() {
    const right = Vector3.Cross(this.viewDir, this.cam.upVector).normalize(); // RH: dir × up = right
    return { right, up: this.cam.upVector.clone().normalize() };
  }

  fit() {
    const b = focusBBox(this.model);
    const { right, up } = this.axes();
    const corners: Vector3[] = [];
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push(new Vector3(x, y, z));
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of corners) { const u = Vector3.Dot(p, right), v = Vector3.Dot(p, up); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    this.view = { cx: (u0 + u1) / 2, cy: (v0 + v1) / 2, half: Math.max((v1 - v0) / 2, (u1 - u0) / 2 / aspect) * 1.12 };
    this.applyCamera();
  }

  applyCamera() {
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const { right, up } = this.axes();
    const b = this.model.bbox;
    const centre = new Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    // position camera so that the view centre (cx, cy) in screen axes is in the middle
    const along = Vector3.Dot(centre, this.viewDir);
    const p = right.scale(this.view.cx).add(up.scale(this.view.cy)).add(this.viewDir.scale(along - 300));
    this.cam.position = p;
    this.cam.setTarget(p.add(this.viewDir));
    const h = this.view.half;
    this.cam.orthoTop = h; this.cam.orthoBottom = -h;
    this.cam.orthoLeft = -h * aspect; this.cam.orthoRight = h * aspect;
    this.dirty = true;
    this.onViewChange?.();
  }

  /** px per metre on screen (CSS pixels) */
  get pxPerMetre() { return this.canvas.clientHeight / (2 * this.view.half); }

  pan(dxPx: number, dyPx: number) {
    const k = 1 / this.pxPerMetre;
    this.view.cx -= dxPx * k;
    this.view.cy += dyPx * k;
    this.applyCamera();
  }
  zoom(factor: number, atX?: number, atY?: number) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const ax = atX ?? w / 2, ay = atY ?? h / 2;
    const k = 1 / this.pxPerMetre;
    const wx = this.view.cx + (ax - w / 2) * k, wy = this.view.cy - (ay - h / 2) * k;
    this.view.half = Math.min(500, Math.max(0.5, this.view.half / factor));
    const k2 = 1 / this.pxPerMetre;
    this.view.cx = wx - (ax - w / 2) * k2;
    this.view.cy = wy + (ay - h / 2) * k2;
    this.applyCamera();
  }

  /** World → CSS pixel position on the canvas. */
  project(p: Vector3): { x: number; y: number } {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const v = Vector3.Project(p, Matrix.Identity(), this.scene.getTransformMatrix(), this.cam.viewport.toGlobal(w, h));
    return { x: v.x, y: v.y };
  }

  /** Pick the first surface that survives the cut plane. x/y in CSS px. */
  pick(x: number, y: number) {
    const hits = this.scene.multiPick(x, y, (m) => m.isEnabled() && !!m.metadata?.elementId) ?? [];
    hits.sort((a, b) => a.distance - b.distance);
    for (const h of hits) {
      const p = h.pickedPoint!;
      if (this.cut.x * p.x + this.cut.y * p.y + this.cut.z * p.z + this.cut.w > 1e-3) continue;
      const el = this.model.elements.find((e) => e.id === h.pickedMesh?.metadata?.elementId) ?? null;
      const n = h.getNormal(true, true) ?? this.viewDir.scale(-1);
      if (Vector3.Dot(n, this.viewDir) > 0) n.scaleInPlace(-1);
      return { element: el, point: p, normal: n };
    }
    return null;
  }

  /** Visible screen-axis bounds → used for scale bar. */
  render() { this.dirty = true; }

  snapshotCanvas(): HTMLCanvasElement {
    this.scene.render();
    return this.canvas;
  }

  dispose() {
    this.resizeObs.disconnect();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
