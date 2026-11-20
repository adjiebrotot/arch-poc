import { PBRMaterial, DynamicTexture, Color3, Texture, RawTexture, Material, type Scene, type BaseTexture } from '@babylonjs/core';
import type { MaterialKey, TextureInfo } from '@shared/model/types';

/**
 * Curated PBR material library. Textures are procedural (canvas-generated),
 * so there are no large image downloads. Meshes get world-space box-mapped UVs
 * (1 UV unit = 1 m), so `scale` = repeats per metre.
 */
type Painter = (ctx: CanvasRenderingContext2D, s: number) => void;

function noise(ctx: CanvasRenderingContext2D, s: number, base: string, amount: number, seed = 1) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < s * s * 0.08; i++) {
    const v = rnd() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${rnd() * amount})`;
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

const painters: Partial<Record<MaterialKey, { paint: Painter; scale: number }>> = {
  'timber-floor': {
    scale: 0.5,
    paint: (ctx, s) => {
      const tones = ['#B98A5E', '#AE7F55', '#C29468', '#A87A50', '#B48659'];
      const plank = s / 8;
      for (let r = 0; r < 8; r++) {
        let x = -((r * 37) % 5) * (s / 5);
        while (x < s) {
          const w = s * (0.45 + ((r * 13 + x) % 3) * 0.15);
          ctx.fillStyle = tones[(r * 3 + Math.abs(Math.floor(x))) % tones.length];
          ctx.fillRect(x, r * plank, w, plank);
          for (let g = 0; g < 6; g++) {
            ctx.strokeStyle = 'rgba(80,50,25,0.12)';
            ctx.beginPath();
            const y = r * plank + (g + 0.5) * (plank / 6);
            ctx.moveTo(x, y);
            ctx.bezierCurveTo(x + w / 3, y + 2, x + (2 * w) / 3, y - 2, x + w, y);
            ctx.stroke();
          }
          ctx.fillStyle = 'rgba(60,35,15,0.5)';
          ctx.fillRect(x, r * plank, 1.5, plank);
          x += w;
        }
        ctx.fillStyle = 'rgba(60,35,15,0.45)';
        ctx.fillRect(0, r * plank, s, 1.5);
      }
    },
  },
  timber: { scale: 1, paint: (ctx, s) => { noise(ctx, s, '#9C6F47', 0.15, 3); for (let i = 0; i < 40; i++) { ctx.strokeStyle = 'rgba(60,35,15,0.15)'; ctx.beginPath(); ctx.moveTo(0, (i / 40) * s); ctx.lineTo(s, (i / 40) * s + 4); ctx.stroke(); } } },
  concrete: { scale: 0.5, paint: (ctx, s) => noise(ctx, s, '#A9A6A0', 0.25, 7) },
  plaster: { scale: 0.5, paint: (ctx, s) => noise(ctx, s, '#F1EEE8', 0.05, 11) },
  exterior: { scale: 0.5, paint: (ctx, s) => noise(ctx, s, '#E4DED3', 0.12, 13) },
  tile: {
    scale: 1.66,
    paint: (ctx, s) => { noise(ctx, s, '#E9E7E2', 0.06, 5); ctx.strokeStyle = '#C9C5BD'; ctx.lineWidth = 3; ctx.strokeRect(0, 0, s, s); },
  },
  grass: {
    scale: 0.4,
    paint: (ctx, s) => {
      noise(ctx, s, '#6F8F4E', 0.3, 17);
      for (let i = 0; i < s * 3; i++) { ctx.fillStyle = `rgba(${90 + (i % 40)},${120 + (i % 50)},60,0.35)`; ctx.fillRect((i * 97) % s, (i * 57) % s, 1, 3); }
    },
  },
  roof: { scale: 1, paint: (ctx, s) => { noise(ctx, s, '#4A4D50', 0.2, 19); for (let i = 0; i < 8; i++) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect((i / 8) * s, 0, 2, s); } } },
};

const BASE: Record<MaterialKey, { color: string; metallic: number; roughness: number }> = {
  plaster: { color: '#F2EFE9', metallic: 0, roughness: 0.92 },
  exterior: { color: '#E6E0D6', metallic: 0, roughness: 0.9 },
  concrete: { color: '#ABA8A2', metallic: 0, roughness: 0.85 },
  'timber-floor': { color: '#B98A5E', metallic: 0, roughness: 0.55 },
  timber: { color: '#9C6F47', metallic: 0, roughness: 0.6 },
  tile: { color: '#E9E7E2', metallic: 0, roughness: 0.3 },
  glass: { color: '#BFD6E2', metallic: 0, roughness: 0.04 },
  metal: { color: '#B8BCC0', metallic: 0.9, roughness: 0.35 },
  roof: { color: '#4A4D50', metallic: 0.2, roughness: 0.6 },
  grass: { color: '#6F8F4E', metallic: 0, roughness: 0.95 },
  fabric: { color: '#D8D3CA', metallic: 0, roughness: 0.95 },
  dark: { color: '#2A2B2D', metallic: 0.1, roughness: 0.5 },
  default: { color: '#D9D5CE', metallic: 0, roughness: 0.8 },
};

export class MaterialLibrary {
  private cache = new Map<string, PBRMaterial>();
  constructor(private scene: Scene, private texSize = 512) {}

  get(key: MaterialKey, tint?: [number, number, number, number]): PBRMaterial {
    // furniture/default keep their own colour (quantised so materials are shared)
    const useTint = tint && (key === 'default' || key === 'fabric' || key === 'dark');
    const id = useTint ? `${key}:${tint!.slice(0, 3).map((v) => Math.round(v * 8)).join(',')}` : key;
    let m = this.cache.get(id);
    if (m) return m;
    const b = BASE[key];
    m = new PBRMaterial(`mat-${id}`, this.scene);
    m.albedoColor = useTint ? new Color3(tint![0], tint![1], tint![2]).toLinearSpace() : Color3.FromHexString(b.color).toLinearSpace();
    // geometry is right-handed with counter-clockwise front faces (glTF / web-ifc convention)
    m.sideOrientation = Material.CounterClockWiseSideOrientation;
    m.metallic = b.metallic;
    m.roughness = b.roughness;
    const p = painters[key];
    if (p) {
      const t = new DynamicTexture(`tex-${key}`, { width: this.texSize, height: this.texSize }, this.scene, true);
      p.paint(t.getContext() as unknown as CanvasRenderingContext2D, this.texSize);
      t.update(true);
      t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
      t.uScale = t.vScale = p.scale;
      t.anisotropicFilteringLevel = 4;
      m.albedoTexture = t;
      m.albedoColor = Color3.White();
    }
    if (key === 'glass') {
      m.alpha = 0.22;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      m.backFaceCulling = false;
      m.environmentIntensity = 1.4;
      m.indexOfRefraction = 1.5;
    }
    if (key === 'tile') m.clearCoat.isEnabled = true;
    this.cache.set(id, m);
    return m;
  }

  private images = new Map<string, BaseTexture>();
  private blobUrls: string[] = [];

  /** Image texture from the model itself (IFC textures, glTF base colour). */
  private image(info: TextureInfo): BaseTexture | null {
    let t = this.images.get(info.id);
    if (t) return t;
    if (info.rgba && info.width && info.height) {
      t = RawTexture.CreateRGBATexture(info.rgba, info.width, info.height, this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    } else if (info.data && !info.missing) {
      const url = URL.createObjectURL(new Blob([info.data as BlobPart], { type: info.mime ?? 'image/png' }));
      this.blobUrls.push(url);
      t = new Texture(url, this.scene, { noMipmap: false, invertY: info.source !== 'gltf', samplingMode: Texture.TRILINEAR_SAMPLINGMODE, mimeType: info.mime });
    } else return null;
    t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 8;
    this.images.set(info.id, t);
    return t;
  }

  /** PBR material using a model texture; falls back to the curated material if the image is missing. */
  getTextured(info: TextureInfo, key: MaterialKey, explicitUVs: boolean, tint?: [number, number, number, number]): PBRMaterial {
    const id = `${info.id}|${explicitUVs ? 'uv' : 'box'}|${key}`;
    let m = this.cache.get(id);
    if (m) return m;
    const base = this.image(info);
    if (!base) return this.get(key, tint);
    // one image, several UV scales (explicit UVs vs metre box-mapping) → per-material clone
    const tex = (base instanceof RawTexture ? base : (base as Texture).clone()) as Texture;
    const reps = explicitUVs ? 1 : info.scale ?? 1;
    tex.uScale = tex.vScale = reps;
    const b = BASE[key];
    m = new PBRMaterial(`mat-${id}`, this.scene);
    m.sideOrientation = Material.CounterClockWiseSideOrientation;
    m.albedoTexture = tex;
    m.albedoColor = Color3.White();
    m.metallic = key === 'metal' ? b.metallic : 0;
    m.roughness = key === 'tile' ? 0.35 : Math.max(0.55, b.roughness);
    if (key === 'glass') { m.alpha = 0.3; m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND; m.backFaceCulling = false; }
    this.cache.set(id, m);
    return m;
  }

  /** Revoke later: textures may still be decoding when the scene is torn down. */
  dispose() { const urls = this.blobUrls.splice(0); setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 10_000); }

  setEnvIntensity(v: number) {
    for (const m of this.cache.values()) m.environmentIntensity = m.name === 'mat-glass' ? v * 1.4 : v;
  }
}
