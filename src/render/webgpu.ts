import type { Board, Component, Side, V2 } from '../types';
import { DEG, triangulate, type V3 } from '../geom';
import { BAND_RGB, GOLD_RGB, LED_INFO, padWorld, resistorBands } from '../model';
import type { Conn } from '../connectivity';
import type { Sim } from '../sim';
import type { PickHit } from '../pick';
import { buildUnitMeshes, type MeshSlice, type PackedMeshes } from './meshes';
import { GLOW_WGSL, SOLID_WGSL, ZONE_WGSL } from './shaders';
import { textStrokes } from './font';
import { BOTH_GAP, type Camera } from './camera';
import { airwiresFor, type Airwire } from '../airwires';
import { EMISSIVITY, apparentTemp } from '../thermal';

export type VizMode = 'realistic' | 'heatmap' | 'thermal' | 'xray';

export interface RenderSceneState {
  board: Board;
  conn: Conn;
  sim: Sim | null;
  powerOn: boolean;
  vizMode: VizMode;
  selectedNet: number;
  selectedCompId: string | null;
  hovered: PickHit | null;
  probeRed: { pos: V2; side: Side } | null;
  probeBlack: { pos: V2; side: Side } | null;
  diodeLitIds?: string[];
  jumperDraft: { a: V2; la: Side; b: V2; lb: Side } | null;
  cursorWorld: V2 | null;
  cursorSide?: Side;
  activeTool: string;
  tutorialTarget?: { pos: V2; side: Side; radius?: number } | null;
  /** Live board thermal model (temperatures, frost / isopropyl film). */
  thermal?: {
    partTemp(id: string): number | undefined;
    partSurface(id: string): { frost: number; wet: number; rosin?: number; melted?: number };
    tempAt(xmm: number, ymm: number): number;
    forEachFilm?(cb: (xmm: number, ymm: number, sizeMm: number, frost: number, wet: number) => void): void;
    /** The board-surface temperature grid (°C per cell, row-major, cell size dx in metres). */
    readonly nx?: number;
    readonly ny?: number;
    readonly dx?: number;
    readonly T?: Float64Array;
  } | null;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  size: number;
  age: number;
  life: number;
}

type MeshKind = 'box' | 'cyl' | 'dome' | 'sphere';

/** Outer copper pour colour in the realistic view. */
const ZONE_RGB: [number, number, number] = [0.12, 0.45, 0.24];

/** X-ray tint per inner copper layer (In1, In2, …): distinct from outer copper green and selection cyan. */
const INNER_RGB: [number, number, number][] = [
  [0.88, 0.55, 0.22], [0.60, 0.45, 0.92], [0.92, 0.40, 0.62], [0.86, 0.80, 0.30], [0.38, 0.50, 0.96], [0.92, 0.36, 0.30],
];

const INSTANCE_FLOATS = 24;
const GLOW_FLOATS = 8;

class InstanceBucket {
  data = new Float32Array(256 * INSTANCE_FLOATS);
  count = 0;

  clear() { this.count = 0; }

  private ensure(n: number) {
    if (n * INSTANCE_FLOATS <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, n * INSTANCE_FLOATS));
    next.set(this.data);
    this.data = next;
  }

  pushMat(
    m0x: number, m0y: number, m0z: number, m0w: number,
    m1x: number, m1y: number, m1z: number, m1w: number,
    m2x: number, m2y: number, m2z: number, m2w: number,
    m3x: number, m3y: number, m3z: number, m3w: number,
    r: number, g: number, b: number, a: number,
    emissive = 0, metallic = 0.2, rough = 0.45, special = 0,
  ) {
    const idx = this.count;
    this.ensure(idx + 1);
    const o = idx * INSTANCE_FLOATS;
    const d = this.data;
    d[o] = m0x; d[o + 1] = m0y; d[o + 2] = m0z; d[o + 3] = m0w;
    d[o + 4] = m1x; d[o + 5] = m1y; d[o + 6] = m1z; d[o + 7] = m1w;
    d[o + 8] = m2x; d[o + 9] = m2y; d[o + 10] = m2z; d[o + 11] = m2w;
    d[o + 12] = m3x; d[o + 13] = m3y; d[o + 14] = m3z; d[o + 15] = m3w;
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = a;
    d[o + 20] = emissive; d[o + 21] = metallic; d[o + 22] = rough; d[o + 23] = special;
    this.count = idx + 1;
  }

  /** Axis-aligned or Z-rotated box/cyl/dome/sphere at (x,y,z) with scale (sx,sy,sz) and rotZ deg. */
  pushTRS(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    rotZDeg: number,
    r: number, g: number, b: number, a: number,
    emissive = 0, metallic = 0.2, rough = 0.45, special = 0,
  ) {
    const rad = rotZDeg * DEG;
    const c = Math.cos(rad), s = Math.sin(rad);
    // A negative sz (bottom-side domes, fillets, blobs) alone is a mirror: it flips triangle winding
    // and back-face culling then discards the outside of the mesh. Mirroring local Y as well makes it
    // a 180° rotation about X instead; every unit mesh is symmetric in Y, so the shape is unchanged.
    if (sz < 0) sy = -sy;
    this.pushMat(
      c * sx, s * sx, 0, 0,
      -s * sy, c * sy, 0, 0,
      0, 0, sz, 0,
      x, y, z, 1,
      r, g, b, a, emissive, metallic, rough, special,
    );
  }

  /** Arbitrary 3D segment aligned along local Z from p0 to p1 with cross-section diameter d. */
  pushSeg3D(
    p0: V3, p1: V3, dx: number, dy: number,
    r: number, g: number, b: number, a: number,
    emissive = 0, metallic = 0.3, rough = 0.4, special = 0,
  ) {
    const vx = p1[0] - p0[0], vy = p1[1] - p0[1], vz = p1[2] - p0[2];
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-5) return;
    const zx = vx / len, zy = vy / len, zz = vz / len;
    // Pick orthogonal reference
    const rx = Math.abs(zz) < 0.9 ? 0 : 1, ry = Math.abs(zz) < 0.9 ? 0 : 0, rz = Math.abs(zz) < 0.9 ? 1 : 0;
    let xx = ry * zz - rz * zy, xy = rz * zx - rx * zz, xz = rx * zy - ry * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const mx = (p0[0] + p1[0]) * 0.5, my = (p0[1] + p1[1]) * 0.5, mz = (p0[2] + p1[2]) * 0.5;
    this.pushMat(
      xx * dx, xy * dx, xz * dx, 0,
      yx * dy, yy * dy, yz * dy, 0,
      zx * len, zy * len, zz * len, 0,
      mx, my, mz, 1,
      r, g, b, a, emissive, metallic, rough, special,
    );
  }
}

function hexToRgb(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!hex) return fallback;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function voltageColor(v: number | null, maxV: number): [number, number, number] {
  if (v === null) return [0.38, 0.41, 0.47];
  const t = Math.max(0, Math.min(1, v / Math.max(1.0, maxV)));
  if (t < 0.25) {
    const k = t / 0.25;
    return [0.14, 0.32 + k * 0.45, 0.92];
  }
  if (t < 0.55) {
    const k = (t - 0.25) / 0.3;
    return [0.14 + k * 0.15, 0.77 + k * 0.13, 0.92 - k * 0.55];
  }
  if (t < 0.8) {
    const k = (t - 0.55) / 0.25;
    return [0.29 + k * 0.68, 0.90 - k * 0.15, 0.37 - k * 0.27];
  }
  const k = (t - 0.8) / 0.2;
  return [0.97, 0.75 - k * 0.52, 0.10];
}

function thermalColor(tempC: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (tempC - 24) / 95));
  if (t < 0.25) {
    const k = t / 0.25;
    return [0.06 + k * 0.34, 0.04 + k * 0.04, 0.22 + k * 0.36];
  }
  if (t < 0.5) {
    const k = (t - 0.25) / 0.25;
    return [0.40 + k * 0.45, 0.08 + k * 0.08, 0.58 - k * 0.22];
  }
  if (t < 0.78) {
    const k = (t - 0.5) / 0.28;
    return [0.85 + k * 0.14, 0.16 + k * 0.42, 0.36 - k * 0.32];
  }
  const k = (t - 0.78) / 0.22;
  return [0.99, 0.58 + k * 0.40, 0.04 + k * 0.88];
}

/** Bright, well-separated colour per net index (golden-ratio hue walk). */
function netHue(net: number): [number, number, number] {
  const h = (net * 0.618033988749895) % 1;
  const f = (n: number) => { const k = (n + h * 6) % 6; return 1 - 0.75 * Math.max(0, Math.min(1, Math.min(k, 4 - k))); };
  return [f(5), f(3), f(1)];
}

/** A label is drawn only when at least this tall on screen (CSS px). */
const LABEL_MIN_PX = 9;

interface Label { at: V2; text: string; size: number; side: Side; rot: number; z: number; rgb: [number, number, number]; prio: number; w: number; h: number }

/** Stroke-font width of `text` at `size` (matches textStrokes: 0.62 glyph + 0.22 gap). */
const textWidth = (text: string, size: number) => (text.length * 0.84 - 0.22) * size;

/**
 * Greedy label placement: highest priority first, a label is kept only if its box (plus a
 * small margin) does not overlap one already kept. Uniform grid keeps it near-linear.
 */
function placeLabels(labels: Label[]): Label[] {
  labels.sort((a, b) => b.prio - a.prio);
  const kept: Label[] = [];
  if (!labels.length) return kept;
  const cell = Math.max(0.5, labels.reduce((m, l) => Math.max(m, Math.min(l.w, l.h)), 0) * 2);
  const grid = new Map<string, Label[]>();
  for (const l of labels) {
    const pad = l.size * 0.25;
    const x0 = l.at[0] - l.w / 2 - pad, x1 = l.at[0] + l.w / 2 + pad, y0 = l.at[1] - l.h / 2 - pad, y1 = l.at[1] + l.h / 2 + pad;
    const i0 = Math.floor(x0 / cell), i1 = Math.floor(x1 / cell), j0 = Math.floor(y0 / cell), j1 = Math.floor(y1 / cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) { kept.push(l); continue; } // huge label (focus at far zoom): just draw
    let hit = false;
    for (let i = i0; i <= i1 && !hit; i++) for (let j = j0; j <= j1 && !hit; j++) {
      for (const o of grid.get(`${i},${j}`) ?? []) {
        if (o.side !== l.side) continue;
        if (Math.abs(o.at[0] - l.at[0]) * 2 < o.w + l.w + 2 * pad && Math.abs(o.at[1] - l.at[1]) * 2 < o.h + l.h + 2 * pad) { hit = true; break; }
      }
    }
    if (hit && l.prio !== Infinity) continue;
    kept.push(l);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      const g = grid.get(k);
      if (g) g.push(l); else grid.set(k, [l]);
    }
  }
  return kept;
}

export class WebGPURenderer {
  private device!: GPUDevice;
  /** WebGPU adapter as reported by the browser (vendor / architecture / device), for bug reports. */
  adapterDescription = 'unknown';
  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private meshes!: PackedMeshes;

  private vbo!: GPUBuffer;
  private ibo!: GPUBuffer;
  private uniformBuf!: GPUBuffer;
  private bindGroup!: GPUBindGroup;

  private instanceBuf!: GPUBuffer;
  private instanceCap = 1024;

  private zoneBuf!: GPUBuffer;
  private zoneCap = 1024;

  private glowBuf!: GPUBuffer;
  private glowCap = 128;

  private solidOpaque!: GPURenderPipeline;
  private solidAlpha!: GPURenderPipeline;
  private zonePipe!: GPURenderPipeline;
  private glowPipe!: GPURenderPipeline;

  private msaaTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private texW = 0;
  private texH = 0;

  private buckets: Record<'opaque' | 'alpha', Record<MeshKind, InstanceBucket>> = {
    opaque: { box: new InstanceBucket(), cyl: new InstanceBucket(), dome: new InstanceBucket(), sphere: new InstanceBucket() },
    alpha: { box: new InstanceBucket(), cyl: new InstanceBucket(), dome: new InstanceBucket(), sphere: new InstanceBucket() },
  };
  private glowData = new Float32Array(128 * GLOW_FLOATS);
  private glowCount = 0;
  private zoneData = new Float32Array(1024 * 10);
  private zoneVertCount = 0;
  private particles: Particle[] = [];
  private lastTickTime = performance.now();

  private startTime = performance.now();
  private outlineCache = new WeakMap<Board, { poly: V2[]; tris: number[] }>();

  private constructor(private canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not supported in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Could not acquire a WebGPU adapter.');
    const device = await adapter.requestDevice();
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas context.');

    const r = new WebGPURenderer(canvas);
    const info = adapter.info;
    r.adapterDescription = info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'unknown' : 'unknown';
    r.device = device;
    r.ctx = ctx;
    r.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: r.format, alphaMode: 'premultiplied' });
    r.initResources();
    return r;
  }

  private initResources() {
    const d = this.device;
    this.meshes = buildUnitMeshes();

    this.vbo = d.createBuffer({ size: this.meshes.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.vbo, 0, this.meshes.vertices.buffer);

    this.ibo = d.createBuffer({ size: this.meshes.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.ibo, 0, this.meshes.indices.buffer);

    this.uniformBuf = d.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instanceBuf = d.createBuffer({ size: this.instanceCap * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.zoneBuf = d.createBuffer({ size: this.zoneCap * 10 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.glowBuf = d.createBuffer({ size: this.glowCap * GLOW_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    const bgl = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }] });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });

    const solidMod = d.createShaderModule({ code: SOLID_WGSL });
    const solidVertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 6 * 4,
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      },
      {
        arrayStride: INSTANCE_FLOATS * 4,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 2, offset: 0, format: 'float32x4' },
          { shaderLocation: 3, offset: 16, format: 'float32x4' },
          { shaderLocation: 4, offset: 32, format: 'float32x4' },
          { shaderLocation: 5, offset: 48, format: 'float32x4' },
          { shaderLocation: 6, offset: 64, format: 'float32x4' },
          { shaderLocation: 7, offset: 80, format: 'float32x4' },
        ],
      },
    ];

    this.solidOpaque = d.createRenderPipeline({
      layout,
      vertex: { module: solidMod, entryPoint: 'vs_main', buffers: solidVertexBuffers },
      fragment: { module: solidMod, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });

    this.solidAlpha = d.createRenderPipeline({
      layout,
      vertex: { module: solidMod, entryPoint: 'vs_main', buffers: solidVertexBuffers },
      fragment: {
        module: solidMod,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: 4 },
    });

    const zoneMod = d.createShaderModule({ code: ZONE_WGSL });
    this.zonePipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: zoneMod,
        entryPoint: 'vs_zone',
        buffers: [{
          arrayStride: 10 * 4,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: zoneMod,
        entryPoint: 'fs_zone',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });

    const glowMod = d.createShaderModule({ code: GLOW_WGSL });
    this.glowPipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: glowMod,
        entryPoint: 'vs_glow',
        buffers: [{
          arrayStride: GLOW_FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: glowMod,
        entryPoint: 'fs_glow',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: { count: 4 },
    });
  }

  spawnSmoke(x: number, y: number, side: Side, thickness: number, kind: 'flux' | 'burn' = 'flux') {
    const sgn = side === 'F' ? 1 : -1;
    const z0 = sgn * (thickness / 2 + 0.5);
    const n = kind === 'burn' ? 14 : 7;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.6 + Math.random() * 1.4;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 0.8,
        y: y + (Math.random() - 0.5) * 0.8,
        z: z0,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd + 0.8,
        vz: sgn * (2.5 + Math.random() * 3.5),
        r: kind === 'burn' ? 0.95 : 0.76,
        g: kind === 'burn' ? 0.42 : 0.84,
        b: kind === 'burn' ? 0.15 : 0.94,
        size: kind === 'burn' ? 1.8 : 1.15,
        age: 0,
        life: kind === 'burn' ? 1.1 : 0.75,
      });
    }
  }

  private stepParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.size += dt * 1.6;
      const alpha = (1 - p.age / p.life) * 0.38;
      this.pushGlow(p.x, p.y, p.z, p.size, p.r, p.g, p.b, alpha);
    }
  }

  private ensureAttachments(w: number, h: number) {
    if (this.texW === w && this.texH === h && this.msaaTex && this.depthTex) return;
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.texW = w;
    this.texH = h;
    this.msaaTex = this.device.createTexture({
      size: [w, h], sampleCount: 4, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTex = this.device.createTexture({
      size: [w, h], sampleCount: 4, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private pushGlow(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, a: number) {
    if (this.glowCount * GLOW_FLOATS >= this.glowData.length) {
      const next = new Float32Array(this.glowData.length * 2);
      next.set(this.glowData);
      this.glowData = next;
    }
    const o = this.glowCount * GLOW_FLOATS;
    this.glowData[o] = x; this.glowData[o + 1] = y; this.glowData[o + 2] = z; this.glowData[o + 3] = radius;
    this.glowData[o + 4] = r; this.glowData[o + 5] = g; this.glowData[o + 6] = b; this.glowData[o + 7] = a;
    this.glowCount++;
  }

  private pushZoneTri(
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number, z: number, nz: number,
    r: number, g: number, b: number, a: number,
  ) {
    const need = (this.zoneVertCount + 3) * 10;
    if (need > this.zoneData.length) {
      const next = new Float32Array(Math.max(this.zoneData.length * 2, need));
      next.set(this.zoneData);
      this.zoneData = next;
    }
    const verts: [number, number][] = [[ax, ay], [bx, by], [cx, cy]];
    for (const [vx, vy] of verts) {
      const o = this.zoneVertCount * 10;
      this.zoneData[o] = vx; this.zoneData[o + 1] = vy; this.zoneData[o + 2] = z;
      this.zoneData[o + 3] = 0; this.zoneData[o + 4] = 0; this.zoneData[o + 5] = nz;
      this.zoneData[o + 6] = r; this.zoneData[o + 7] = g; this.zoneData[o + 8] = b; this.zoneData[o + 9] = a;
      this.zoneVertCount++;
    }
  }

  private pushZoneVert(x: number, y: number, z: number, nz: number, r: number, g: number, b: number, a: number) {
    if ((this.zoneVertCount + 1) * 10 > this.zoneData.length) {
      const next = new Float32Array(this.zoneData.length * 2);
      next.set(this.zoneData);
      this.zoneData = next;
    }
    const o = this.zoneVertCount * 10, d = this.zoneData;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = 0; d[o + 4] = 0; d[o + 5] = nz;
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b; d[o + 9] = a;
    this.zoneVertCount++;
  }

  /**
   * IR view of the board surface: the thermal grid as a mesh with one vertex per cell centre,
   * coloured by the temperature an IR camera reads off the mask, interpolated between cells.
   * Cells within a few tenths of a kelvin of ambient are left out (the mask is drawn at ambient)
   * and fade in, so only heat (or evaporative / frost cooling) shows.
   */
  private pushThermalSurface(grid: { nx: number; ny: number; dx: number; T: Float64Array }, faces: { z: number; nz: number; map: (x: number, y: number) => V2 }[]) {
    const { nx, ny, T } = grid;
    const s = grid.dx * 1e3;
    const n = nx * ny;
    if (!this.irCells || this.irCells.length !== n) { this.irCells = new Float32Array(n); this.irAlpha = new Float32Array(n); }
    const tc = this.irCells, al = this.irAlpha!;
    let any = false;
    for (let k = 0; k < n; k++) {
      const t = T[k];
      if (Math.abs(t - 25) < 0.3) { tc[k] = 25; al[k] = 0; continue; }
      const v = apparentTemp(t, EMISSIVITY.mask);
      tc[k] = v;
      al[k] = Math.min(1, Math.max(0, (Math.abs(v - 25.5) - 0.3) / 4)) * 0.92;
      if (al[k] > 0) any = true;
    }
    if (!any) return;
    // the pour shader lights a face-on triangle by ~0.85; undo it so the palette reads true
    const LIFT = 1.18;
    const vert = (k: number, x: number, y: number, f: { z: number; nz: number; map: (x: number, y: number) => V2 }) => {
      const c = thermalColor(tc[k]);
      const p = f.map(x, y);
      this.pushZoneVert(p[0], p[1], f.z, f.nz, Math.min(1, c[0] * LIFT), Math.min(1, c[1] * LIFT), Math.min(1, c[2] * LIFT), al[k]);
    };
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
        if (al[k00] === 0 && al[k10] === 0 && al[k01] === 0 && al[k11] === 0) continue;
        const x0 = (i + 0.5) * s, x1 = x0 + s, y0 = (j + 0.5) * s, y1 = y0 + s;
        for (const f of faces) {
          vert(k00, x0, y0, f); vert(k10, x1, y0, f); vert(k11, x1, y1, f);
          vert(k00, x0, y0, f); vert(k11, x1, y1, f); vert(k01, x0, y1, f);
        }
      }
    }
  }
  private irCells: Float32Array | null = null;
  private irAlpha: Float32Array | null = null;

  private getBoardOutline(board: Board): { poly: V2[]; tris: number[] } | null {
    let cached = this.outlineCache.get(board);
    if (!cached) {
      const fSilk = board.silk.filter((s) => s.side === 'F' && Math.abs(s.w - 0.22) < 0.02);
      const poly = fSilk.map((s) => s.a);
      const tris = poly.length >= 3 ? triangulate(poly) : [];
      cached = { poly, tris };
      this.outlineCache.set(board, cached);
    }
    return cached.tris.length >= 3 ? cached : null;
  }

  private buildScene(scene: RenderSceneState, camera: Camera) {
    for (const pass of ['opaque', 'alpha'] as const) {
      this.buckets[pass].box.clear();
      this.buckets[pass].cyl.clear();
      this.buckets[pass].dome.clear();
      this.buckets[pass].sphere.clear();
    }
    this.glowCount = 0;
    this.zoneVertCount = 0;

    const { board, conn, sim, powerOn, vizMode, selectedNet, selectedCompId, hovered, probeRed, probeBlack, jumperDraft, diodeLitIds } = scene;
    const op = this.buckets.opaque;
    const al = this.buckets.alpha;
    const ht = board.thickness / 2;
    const xray = vizMode === 'xray';
    const thermal = vizMode === 'thermal';
    const dense = board.components.length > 150;
    // dense 2D view shows one side at a time (the other side's copper would only add clutter)
    const is2DBoardview = dense && camera.mode === '2d';
    const both = camera.bothSides;
    const mx = (x: number, side: Side) => (both && side === 'B' ? board.w * 2 + BOTH_GAP - x : x);
    const mpt = (p: V2, side: Side): V2 => [mx(p[0], side), p[1]];
    const effSide = (side: Side): Side => (both ? 'F' : side);
    // Both + X-ray: each panel also shows the opposite face's copper, seen through the board
    // (mirrored as it lies under that face). Faint, just above the panel's own pours (which write
    // depth and often cover the whole face) and below the inner layers.
    const ghost = both && xray;
    const otherSide = (s: Side): Side => (s === 'F' ? 'B' : 'F');
    const GHOST_Z = ht + 0.0124;

    // Determine max battery voltage for heatmap & hot nets for thermal IR
    let maxV = 5;
    const netPower = new Map<number, number>();
    if (sim?.source) {
      for (const c of board.components) {
        if (c.kind === 'battery' && c.value > maxV) maxV = c.value;
        const cs = sim.comps.get(c.id);
        if (!cs) continue;
        // Estimate heat contribution onto connected nets (especially shorts!)
        const heat = cs.p + (c.kind === 'battery' && cs.i > 0.04 ? cs.i * 18 : 0);
        if (heat > 0.01) {
          const indices = conn.padItem.get(c) ?? [];
          for (const idx of indices) {
            const n = conn.net[idx];
            if (n >= 0) netPower.set(n, Math.max(netPower.get(n) ?? 0, heat));
          }
        }
      }
    }

    // Net temperature from the thermal model: mean board temperature under the net's copper.
    const netTempCache = new Map<number, number>();
    const netTemp = (net: number): number => {
      let t = netTempCache.get(net);
      if (t !== undefined) return t;
      const items = conn.netItems[net] ?? [];
      const step = Math.max(1, Math.floor(items.length / 12));
      let sum = 0, n = 0;
      for (let k = 0; k < items.length; k += step) {
        const bb = conn.items[items[k]].shape.bb;
        sum += this.curThermal!.tempAt((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2); n++;
      }
      t = n ? sum / n : 25;
      netTempCache.set(net, t);
      return t;
    };
    const netTint = (net: number, defaultRgb: [number, number, number], eps: number = EMISSIVITY.mask): { rgb: [number, number, number]; emissive: number; special: number } => {
      const isSelected = selectedNet >= 0 && net === selectedNet;
      if (thermal) {
        const w = net >= 0 ? (netPower.get(net) ?? 0) : 0;
        const temp = this.curThermal && net >= 0 ? netTemp(net) : 25 + Math.min(115, w * 42);
        // the camera sees radiated heat: low-emissivity metal reads cold (apparent temperature)
        return { rgb: thermalColor(apparentTemp(temp, eps)), emissive: w > 0.2 ? 0.35 : 0.05, special: isSelected ? -1 : 0 };
      }
      if (vizMode === 'heatmap' && sim?.source) {
        const ni = net >= 0 ? sim.nodeOfNet.get(net) : undefined;
        const v = ni !== undefined ? sim.V[ni] : null;
        return { rgb: voltageColor(v, maxV), emissive: isSelected ? 0.35 : 0.14, special: isSelected ? -1 : 0 };
      }
      if (isSelected) return { rgb: [0.28, 0.90, 1.0], emissive: 0.35, special: -1 };
      return { rgb: defaultRgb, emissive: 0, special: 0 };
    };

    // 1. PCB Substrate (FR-4 core + solder mask faces, or notched polygon on dense boards)
    const maskRgb: [number, number, number] = thermal ? thermalColor(25.5) : hexToRgb(board.color, [0.06, 0.31, 0.16]);
    const outline = dense ? this.getBoardOutline(board) : null;
    if (outline) {
      const sr = Math.min(1, maskRgb[0] * 1.15);
      const sg = Math.min(1, maskRgb[1] * 1.15);
      const sb = Math.min(1, maskRgb[2] * 1.15);
      const sa = xray ? 0.32 : 1.0;
      const pushPolySubstrate = (side: Side) => {
        const pushFace = (zz: number, nz: number) => {
          for (let i = 0; i + 2 < outline.tris.length; i += 3) {
            const a = mpt(outline.poly[outline.tris[i]], side);
            const b = mpt(outline.poly[outline.tris[i + 1]], side);
            const c = mpt(outline.poly[outline.tris[i + 2]], side);
            this.pushZoneTri(a[0], a[1], b[0], b[1], c[0], c[1], zz, nz, sr, sg, sb, sa);
          }
        };
        if (camera.mode === '3d') {
          pushFace(ht - 0.01, 1);
          pushFace(-ht + 0.01, -1);
          if (!xray) {
            const edgeH = Math.max(0.2, board.thickness - 0.02);
            for (let i = 0; i < outline.poly.length; i++) {
              const pa = mpt(outline.poly[i], side);
              const pb = mpt(outline.poly[(i + 1) % outline.poly.length], side);
              const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
              const len = Math.hypot(dx, dy);
              if (len < 0.05) continue;
              const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
              op.box.pushTRS((pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, 0, len, 0.24, edgeH, ang, 0.16, 0.28, 0.34, 1, 0, 0.1, 0.65);
            }
          }
        } else {
          const dSide = effSide(side);
          const zz = dSide === 'F' ? ht - 0.01 : -ht + 0.01;
          const nz = dSide === 'F' ? 1 : -1;
          pushFace(zz, nz);
        }
      };
      if (both) {
        pushPolySubstrate('F');
        pushPolySubstrate('B');
      } else {
        pushPolySubstrate(camera.side);
      }
    } else {
      const pushSubstrate = (cx: number) => {
        if (xray) {
          al.box.pushTRS(cx, board.h / 2, 0, board.w, board.h, board.thickness, 0, maskRgb[0], maskRgb[1], maskRgb[2], 0.32, 0, 0.08, 0.65);
        } else {
          // Inner FR-4 core slightly inset in Z so top/bottom solder mask caps show crisp color
          op.box.pushTRS(cx, board.h / 2, 0, board.w, board.h, Math.max(0.2, board.thickness - 0.12), 0, thermal ? 0.08 : 0.42, thermal ? 0.05 : 0.37, thermal ? 0.24 : 0.24, 1, 0, 0.05, 0.7);
          op.box.pushTRS(cx, board.h / 2, ht - 0.03, board.w, board.h, 0.06, 0, maskRgb[0], maskRgb[1], maskRgb[2], 1, 0, 0.12, 0.42);
          op.box.pushTRS(cx, board.h / 2, -ht + 0.03, board.w, board.h, 0.06, 0, maskRgb[0], maskRgb[1], maskRgb[2], 1, 0, 0.12, 0.42);
        }
      };
      pushSubstrate(board.w / 2);
      if (both) pushSubstrate(board.w * 1.5 + BOTH_GAP);
    }

    // 2. Copper Zones
    for (const z of board.zones) {
      if (z.poly.length < 3) continue;
      let tris = this.zoneTris.get(z.poly);
      if (!tris) this.zoneTris.set(z.poly, (tris = triangulate(z.poly))); // once per pour, not per frame
      const dSide = effSide(z.layer);
      const zz = dSide === 'F' ? ht + 0.012 : -ht - 0.012;
      const nz = dSide === 'F' ? 1 : -1;
      // pours take their net's colour in the IR / voltage views, like tracks
      const zt = thermal || vizMode === 'heatmap' || selectedNet >= 0
        ? netTint(z.net !== undefined ? this.netIndexOf(conn).get(z.net) ?? -1 : -1, ZONE_RGB).rgb : ZONE_RGB;
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const a = mpt(z.poly[tris[i]], z.layer);
        const b = mpt(z.poly[tris[i + 1]], z.layer);
        const c = mpt(z.poly[tris[i + 2]], z.layer);
        if (both && z.layer === 'B') {
          this.pushZoneTri(a[0], a[1], c[0], c[1], b[0], b[1], zz, nz, zt[0], zt[1], zt[2], xray ? 0.35 : 0.85);
        } else {
          this.pushZoneTri(a[0], a[1], b[0], b[1], c[0], c[1], zz, nz, zt[0], zt[1], zt[2], xray ? 0.35 : 0.85);
        }
        if (ghost) {
          const o = otherSide(z.layer);
          const ga = mpt(z.poly[tris[i]], o), gb = mpt(z.poly[tris[i + 1]], o), gc = mpt(z.poly[tris[i + 2]], o);
          this.pushZoneTri(ga[0], ga[1], gb[0], gb[1], gc[0], gc[1], GHOST_Z, 1, zt[0], zt[1], zt[2], 0.18);
        }
      }
    }

    // Helper: draw 2D copper trace capsule on layer
    const pushTraceSeg = (a: V2, b: V2, w: number, z: number, thick: number, r: number, g: number, bl: number, alpha: number, em: number, met: number, rough: number, spec: number) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      const bucket = alpha < 0.99 ? al : op;
      if (len > 1e-4) {
        bucket.box.pushTRS((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, z, len, w, thick, ang, r, g, bl, alpha, em, met, rough, spec);
      }
      bucket.cyl.pushTRS(a[0], a[1], z, w, w, thick, 0, r, g, bl, alpha, em, met, rough, spec);
      bucket.cyl.pushTRS(b[0], b[1], z, w, w, thick, 0, r, g, bl, alpha, em, met, rough, spec);
    };

    // 3. Copper Traces
    const cuDefault: [number, number, number] = [0.22, 0.68, 0.38];
    const cuHover: [number, number, number] = [0.95, 0.76, 0.28];
    for (let ti = 0; ti < board.traces.length; ti++) {
      const tr = board.traces[ti];
      const itemIdx = conn.traceItem.get(tr);
      const net = itemIdx !== undefined ? conn.net[itemIdx] : -1;
      if (both ? false : (is2DBoardview && !xray && tr.layer !== camera.side && net !== selectedNet)) continue;
      const isHov = hovered?.kind === 'trace' && hovered.trace === tr;
      const tint = netTint(net, isHov ? cuHover : cuDefault);
      const z = effSide(tr.layer) === 'F' ? ht + 0.032 : -ht - 0.032;
      pushTraceSeg(
        mpt(tr.a, tr.layer), mpt(tr.b, tr.layer), tr.w, z, 0.055,
        tint.rgb[0], tint.rgb[1], tint.rgb[2], xray ? 0.85 : 1,
        isHov ? 0.35 : tint.emissive, 0.65, 0.28, isHov ? -1 : tint.special,
      );
      if (ghost) {
        const o = otherSide(tr.layer);
        pushTraceSeg(mpt(tr.a, o), mpt(tr.b, o), tr.w, GHOST_Z, 0.001,
          tint.rgb[0] * 0.85, tint.rgb[1] * 0.85, tint.rgb[2] * 0.85, 0.42, tint.emissive * 0.5, 0.3, 0.6, tint.special);
      }
    }

    // 3b. Inner-layer copper (display only). X-ray shows every inner layer at its depth in the
    // core; otherwise the selected net's inner copper is overlaid on the viewed face, so a rail
    // that lives on a plane or inner tracks reads as one connected shape instead of stubs.
    if (board.inner) {
      const nIn = this.innerLayerCount(board);
      const selName = selectedNet >= 0 ? conn.netNames[selectedNet] : undefined;
      const netIdx = this.netIndexOf(conn);
      const layerRgb = (l: number): [number, number, number] => INNER_RGB[(l - 1) % INNER_RGB.length];
      // each pass: which copper, at what height, how opaque
      const passes: { z: (layer: number, track: boolean) => number; nz: number; side: Side; only?: string; alpha: number; thick: number }[] = [];
      if (xray) {
        // a thin stack over the outer pours (which write depth and usually cover the whole face)
        // and under the outer tracks: inner pours, then inner tracks (planes like GND would
        // otherwise blanket the tracks of deeper layers), nearest layer on top within each
        for (const s of (both ? ['F', 'B'] : [camera.side]) as Side[]) {
          const top = effSide(s) === 'F';
          const zOf = (l: number, track: boolean) => { const d = 0.013 + (track ? 0.006 : 0) + 0.0008 * (top ? nIn + 1 - l : l); return top ? ht + d : -ht - d; };
          passes.push({ z: zOf, nz: top ? 1 : -1, side: s, alpha: 0.28, thick: 0.001 });
        }
      } else if (selName !== undefined && board.hiddenCopperNets?.includes(selName)) {
        const face = (s: Side) => (effSide(s) === 'F' ? ht + 0.07 : -ht - 0.07);
        const sides: Side[] = both ? ['F', 'B'] : [camera.side];
        for (const s of sides) passes.push({ z: () => face(s), nz: effSide(s) === 'F' ? 1 : -1, side: s, only: selName, alpha: 0.5, thick: 0.03 });
      }
      for (const ps of passes) {
        for (const z of board.inner.zones) {
          if (ps.only !== undefined && z.net !== ps.only) continue;
          let tris = this.zoneTris.get(z.poly);
          if (!tris) this.zoneTris.set(z.poly, (tris = triangulate(z.poly)));
          const tint = netTint(z.net !== undefined ? netIdx.get(z.net) ?? -1 : -1, layerRgb(z.layer));
          const zz = ps.z(z.layer, false);
          for (let i = 0; i + 2 < tris.length; i += 3) {
            const a = mpt(z.poly[tris[i]], ps.side), b = mpt(z.poly[tris[i + 1]], ps.side), c = mpt(z.poly[tris[i + 2]], ps.side);
            this.pushZoneTri(a[0], a[1], b[0], b[1], c[0], c[1], zz, ps.nz, tint.rgb[0], tint.rgb[1], tint.rgb[2], ps.alpha);
          }
        }
        for (const t of board.inner.traces) {
          if (ps.only !== undefined && t.net !== ps.only) continue;
          const tint = netTint(t.net !== undefined ? netIdx.get(t.net) ?? -1 : -1, layerRgb(t.layer));
          pushTraceSeg(mpt(t.a, ps.side), mpt(t.b, ps.side), t.w, ps.z(t.layer, true), ps.thick,
            tint.rgb[0], tint.rgb[1], tint.rgb[2], Math.min(0.9, ps.alpha + 0.4), tint.emissive, 0.5, 0.35, tint.special);
        }
      }
    }

    // 4. Vias & ICT test points
    for (const v of board.vias) {
      const itemIdx = conn.viaItem.get(v);
      const net = itemIdx !== undefined ? conn.net[itemIdx] : -1;
      if (v.side && !both && is2DBoardview && !xray && v.side !== camera.side && net !== selectedNet) continue;
      const isHov = hovered?.kind === 'via' && hovered.via === v;
      const defaultViaRgb: [number, number, number] = [0.85, 0.64, 0.28];
      const tint = netTint(net, isHov ? [1, 0.85, 0.35] : defaultViaRgb, EMISSIVITY.via);
      if (v.side) {
        const p = mpt(v.at, v.side);
        const vz = effSide(v.side) === 'F' ? ht + 0.034 : -ht - 0.034;
        op.cyl.pushTRS(p[0], p[1], vz, v.d, v.d, 0.05, 0, tint.rgb[0], tint.rgb[1], tint.rgb[2], 1, isHov ? 0.35 : tint.emissive, 0.85, 0.24, isHov ? -1 : tint.special);
      } else {
        const pushThruVia = (pos: V2) => {
          op.cyl.pushTRS(pos[0], pos[1], 0, v.d, v.d, board.thickness + 0.08, 0, tint.rgb[0], tint.rgb[1], tint.rgb[2], 1, tint.emissive, 0.85, 0.24, isHov ? -1 : tint.special);
          op.cyl.pushTRS(pos[0], pos[1], 0, v.drill, v.drill, board.thickness + 0.12, 0, 0.04, 0.05, 0.07, 1, 0, 0.1, 0.9);
        };
        pushThruVia(v.at);
        if (both) pushThruVia(mpt(v.at, 'B'));
      }
    }

    // 5. Solder Blobs
    for (const b of board.blobs) {
      const itemIdx = conn.blobItem.get(b);
      const net = itemIdx !== undefined ? conn.net[itemIdx] : -1;
      const isHov = hovered?.kind === 'blob' && hovered.blob === b;
      const dSide = effSide(b.layer);
      const z = dSide === 'F' ? ht + 0.04 : -ht - 0.04;
      const sz = dSide === 'F' ? b.r * 0.95 : -b.r * 0.95;
      const pos = mpt(b.at, b.layer);
      const tint = netTint(net, [0.84, 0.86, 0.90], EMISSIVITY.metal);
      op.dome.pushTRS(pos[0], pos[1], z, b.r * 2, b.r * 2, sz, 0, tint.rgb[0], tint.rgb[1], tint.rgb[2], 1, isHov ? 0.35 : tint.emissive, 0.92, 0.16, isHov ? -1 : tint.special);
      if (ghost) {
        const g = mpt(b.at, otherSide(b.layer));
        al.cyl.pushTRS(g[0], g[1], GHOST_Z, b.r * 2, b.r * 2, 0.001, 0, tint.rgb[0], tint.rgb[1], tint.rgb[2], 0.45, 0, 0.3, 0.6, tint.special);
      }
    }

    // 5b. Frost / isopropyl film on the board surface, one tile per thermal grid cell. Each cell
    // evaporates at its own temperature, so the patch dries from the hot spots outward. (The IR
    // view shows the same thing as temperature, so the film is left out there.)
    if (!thermal && this.curThermal?.forEachFilm) {
      const faces: Side[] = both ? ['F', 'B'] : [camera.side];
      this.curThermal.forEachFilm((x, y, s, frost, wet) => {
        for (const f of faces) {
          const p = mpt([x, y], f);
          const z = effSide(f) === 'F' ? ht + 0.09 : -ht - 0.09;
          if (frost > 0.02) al.box.pushTRS(p[0], p[1], z, s, s, 0.04, 0, 0.93, 0.96, 1.0, 0.3 + 0.5 * frost, 0.2, 0.0, 0.9);
          else if (wet > 0.02) al.box.pushTRS(p[0], p[1], z, s, s, 0.02, 0, 0.74, 0.86, 0.97, 0.07 + 0.2 * wet, 0.04, 0.0, 0.04);
        }
      });
    }

    // 5c. IR view: board surface temperature from the thermal grid (replaces per-part halo discs)
    const th = this.curThermal;
    if (thermal && th && th.T && th.nx && th.ny && th.dx) {
      const faces = (both ? ['F', 'B'] : [camera.side] as Side[]).map((f) => ({
        z: effSide(f as Side) === 'F' ? ht + 0.075 : -ht - 0.075,
        nz: effSide(f as Side) === 'F' ? 1 : -1,
        map: (x: number, y: number) => mpt([x, y], f as Side),
      }));
      this.pushThermalSurface({ nx: th.nx, ny: th.ny, dx: th.dx, T: th.T }, faces);
    }

    // 6. Jumper Wires
    for (const j of board.jumpers) {
      const isHov = hovered?.kind === 'jumper' && hovered.jumper === j;
      const pa = mpt(j.a, j.la), pb = mpt(j.b, j.lb);
      const la = effSide(j.la), lb = effSide(j.lb);
      const za = la === 'F' ? ht + 0.12 : -ht - 0.12;
      const zb = lb === 'F' ? ht + 0.12 : -ht - 0.12;
      const col: [number, number, number] = isHov ? [1, 0.78, 0.22] : [0.95, 0.36, 0.14];
      // Solder joints at endpoints
      op.sphere.pushTRS(pa[0], pa[1], za, 0.8, 0.8, 0.55, 0, 0.86, 0.88, 0.92, 1, 0, 0.92, 0.15);
      op.sphere.pushTRS(pb[0], pb[1], zb, 0.8, 0.8, 0.55, 0, 0.86, 0.88, 0.92, 1, 0, 0.92, 0.15);

      if (la === lb) {
        const sgn = la === 'F' ? 1 : -1;
        const mid: V3 = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, za + sgn * 2.2];
        op.cyl.pushSeg3D([pa[0], pa[1], za], mid, 0.42, 0.42, col[0], col[1], col[2], 1, isHov ? 0.3 : 0, 0.15, 0.45);
        op.cyl.pushSeg3D(mid, [pb[0], pb[1], zb], 0.42, 0.42, col[0], col[1], col[2], 1, isHov ? 0.3 : 0, 0.15, 0.45);
      } else {
        // Cross-board jumper routes via nearest board edge
        const edgeX = (pa[0] + pb[0]) * 0.5 < board.w * 0.5 ? -1.4 : board.w + 1.4;
        const p1: V3 = [edgeX, pa[1], za + (la === 'F' ? 1.2 : -1.2)];
        const p2: V3 = [edgeX, pb[1], zb + (lb === 'F' ? 1.2 : -1.2)];
        op.cyl.pushSeg3D([pa[0], pa[1], za], p1, 0.42, 0.42, col[0], col[1], col[2], 1, 0, 0.15, 0.45);
        op.cyl.pushSeg3D(p1, p2, 0.42, 0.42, col[0], col[1], col[2], 1, 0, 0.15, 0.45);
        op.cyl.pushSeg3D(p2, [pb[0], pb[1], zb], 0.42, 0.42, col[0], col[1], col[2], 1, 0, 0.15, 0.45);
      }
    }

    // 7. Silkscreen Lines & Texts
    const pushSilkSeg = (
      a: V2, b: V2, w: number, side: Side,
      rgb: [number, number, number] = [0.92, 0.94, 0.90],
      zOff = 0.045,
    ) => {
      const z = side === 'F' ? ht + zOff : -ht - zOff;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) return;
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      op.box.pushTRS((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, z, len, w, 0.025, ang, rgb[0], rgb[1], rgb[2], 1, 0.05, 0.05, 0.6);
    };

    const pushSilkText = (
      at: V2, text: string, size: number, side: Side, rotDeg = 0,
      rgb: [number, number, number] = [0.92, 0.94, 0.90],
      zOff = 0.045,
    ) => {
      const segs = textStrokes(text, size);
      const rad = rotDeg * DEG;
      const cs = Math.cos(rad), sn = Math.sin(rad);
      const mirX = side === 'B' ? -1 : 1;
      for (const s of segs) {
        const x0 = s.x0 * mirX, y0 = s.y0;
        const x1 = s.x1 * mirX, y1 = s.y1;
        const p0: V2 = [at[0] + x0 * cs - y0 * sn, at[1] + x0 * sn + y0 * cs];
        const p1: V2 = [at[0] + x1 * cs - y1 * sn, at[1] + x1 * sn + y1 * cs];
        pushSilkSeg(p0, p1, Math.max(0.02, size * 0.11), side, rgb, zOff);
      }
    };

    const boardSilkCol: [number, number, number] = [0.92, 0.94, 0.90];
    for (const s of board.silk) {
      if (!both && is2DBoardview && !xray && s.side !== camera.side) continue;
      pushSilkSeg(mpt(s.a, s.side), mpt(s.b, s.side), s.w, effSide(s.side), boardSilkCol);
    }
    // Labels on dense boards are placed after all parts are known: only where readable on
    // screen, never overlapping (see placeLabels below).
    const cssW = Math.max(1, this.canvas.clientWidth), cssH = Math.max(1, this.canvas.clientHeight);
    const pxPerMm = camera.pxPerMm(cssH);
    const minLabelMm = LABEL_MIN_PX / pxPerMm;
    const viewSlack = camera.mode === '3d' ? 2.2 : 1.15; // perspective shows more than the target plane
    const inView = (p: V2) => Math.abs(p[0] - camera.tx) < (cssW / 2 / pxPerMm) * viewSlack && Math.abs(p[1] - camera.ty) < (cssH / 2 / pxPerMm) * viewSlack;
    const labels: Label[] = [];
    for (const t of board.texts) {
      if (!both && is2DBoardview && !xray && t.side !== camera.side) continue;
      const at = mpt(t.at, t.side);
      if (!dense) { pushSilkText(at, t.text, t.size, effSide(t.side), t.rot ?? 0); continue; }
      if (t.size < minLabelMm || !inView(at)) continue;
      const vert = Math.abs(Math.sin((t.rot ?? 0) * DEG)) > 0.7;
      const tw = textWidth(t.text, t.size);
      labels.push({ at, text: t.text, size: t.size, side: effSide(t.side), rot: t.rot ?? 0, z: 0.045, rgb: boardSilkCol, prio: t.size, w: vert ? t.size : tw, h: vert ? tw : t.size });
    }

    // 8. Components, Pads, Solder Joints, and Silkscreen Courtyards
    for (const c of board.components) {
      if (!both && is2DBoardview && !xray && c.side !== camera.side && !c.pads.some((p) => p.layers === 'FB')) continue;
      const cSim = powerOn && sim ? sim.comps.get(c.id) : undefined;
      const isSelected = selectedCompId === c.id;
      const isCompHov = (hovered?.kind === 'comp' && hovered.comp === c) || (hovered?.kind === 'pad' && hovered.comp === c);
      const padIndices = conn.padItem.get(c) ?? [];
      const dSide = effSide(c.side);
      const sgn = dSide === 'F' ? 1 : -1;
      const dispRot = both && c.side === 'B' ? -c.rot : c.rot;

      // Component Pads + Solder Joints
      for (let pi = 0; pi < c.pads.length; pi++) {
        const p = c.pads[pi];
        const pw = padWorld(c, p);
        const itemIdx = padIndices[pi];
        const net = itemIdx !== undefined ? conn.net[itemIdx] : -1;
        const isPadHov = hovered?.kind === 'pad' && hovered.comp === c && hovered.padIndex === pi;
        const basePadRgb: [number, number, number] = [0.85, 0.67, 0.32];
        const tint = netTint(net, isPadHov ? [1, 0.88, 0.35] : basePadRgb, EMISSIVITY.metal);
        const isCold = c.state.populated && c.state.cold.includes(pi);

        const padSide: Side = both ? c.side : p.layers === 'B' ? 'B' : 'F';
        const dPadSide: Side = both ? 'F' : p.layers === 'FB' ? 'FB' as unknown as Side : padSide;
        const hasF = p.layers === 'F' || p.layers === 'FB';
        const hasB = p.layers === 'B' || p.layers === 'FB';
        const zOff = is2DBoardview ? 0.038 : 0.036;
        const zCenter = (!both && p.layers === 'FB') ? 0 : dPadSide === 'F' ? ht + zOff : -ht - zOff;
        const padH = (!both && p.layers === 'FB') ? board.thickness + 0.08 : 0.05;
        const padPos = mpt(pw.at, c.side);
        const padRot = both && c.side === 'B' ? -pw.rot : pw.rot;

        const mesh = p.shape === 'circle' || p.shape === 'oval' ? op.cyl : op.box;
        mesh.pushTRS(
          padPos[0], padPos[1], zCenter, p.size[0], p.size[1], padH, padRot,
          tint.rgb[0], tint.rgb[1], tint.rgb[2], 1,
          isPadHov ? 0.35 : tint.emissive, 0.88, 0.22, isPadHov ? -1 : tint.special,
        );

        // Drill hole
        if (p.drill && p.drill > 0) {
          op.cyl.pushTRS(padPos[0], padPos[1], both ? zCenter : 0, p.drill, p.drill, both ? 0.07 : board.thickness + 0.13, 0, 0.03, 0.04, 0.06, 1, 0, 0.1, 0.9);
        }

        // Side by side, a through-hole pad also shows on the other face's panel (mirrored there),
        // as it does in the single-side Top / Bottom views.
        if (both && p.layers === 'FB') {
          const other: Side = c.side === 'F' ? 'B' : 'F';
          const op2 = mpt(pw.at, other);
          const rot2 = other === 'B' ? -pw.rot : pw.rot;
          mesh.pushTRS(
            op2[0], op2[1], zCenter, p.size[0], p.size[1], padH, rot2,
            tint.rgb[0], tint.rgb[1], tint.rgb[2], 1,
            isPadHov ? 0.35 : tint.emissive, 0.88, 0.22, isPadHov ? -1 : tint.special,
          );
          if (p.drill && p.drill > 0) {
            op.cyl.pushTRS(op2[0], op2[1], zCenter, p.drill, p.drill, 0.07, 0, 0.03, 0.04, 0.06, 1, 0, 0.1, 0.9);
          }
        } else if (ghost) {
          // a single-side (SMD) pad, seen through the board on the other face's panel
          const other: Side = c.side === 'F' ? 'B' : 'F';
          const gp = mpt(pw.at, other);
          (mesh === op.cyl ? al.cyl : al.box).pushTRS(
            gp[0], gp[1], GHOST_Z, p.size[0], p.size[1], 0.001, other === 'B' ? -pw.rot : pw.rot,
            tint.rgb[0], tint.rgb[1], tint.rgb[2], 0.4, 0, 0.3, 0.6, tint.special,
          );
        }

        // Solder fillet + clipped lead tip on populated THT pins
        if (!both && c.state.populated && p.drill) {
          const d = Math.min(p.size[0], p.size[1]) * 0.82;
          if (isCold) {
            // Cold joint: dull matte grainy grey ball
            if (hasB) op.sphere.pushTRS(padPos[0], padPos[1], -ht - 0.22, d * 1.05, d * 1.05, 0.68, 0, 0.48, 0.49, 0.50, 1, 0, 0.2, 0.9, 1.0);
            if (hasF) op.sphere.pushTRS(padPos[0], padPos[1], ht + 0.18, d * 0.85, d * 0.85, 0.5, 0, 0.48, 0.49, 0.50, 1, 0, 0.2, 0.9, 1.0);
          } else {
            if (hasB) op.dome.pushTRS(padPos[0], padPos[1], -ht - 0.04, d, d, -0.58, 0, 0.85, 0.87, 0.91, 1, 0, 0.94, 0.14);
            if (hasF) op.dome.pushTRS(padPos[0], padPos[1], ht + 0.04, d * 0.85, d * 0.85, 0.42, 0, 0.85, 0.87, 0.91, 1, 0, 0.94, 0.14);
          }
          // Clipped component lead protruding slightly on opposite side of board
          const leadZ = c.side === 'F' ? -ht - 0.42 : ht + 0.42;
          op.cyl.pushTRS(padPos[0], padPos[1], leadZ, Math.min(0.55, p.drill * 0.65), Math.min(0.55, p.drill * 0.65), 0.72, 0, 0.82, 0.84, 0.88, 1, 0, 0.95, 0.2);
        }
      }

      // Silkscreen reference + polarity indicator
      const rad = c.rot * DEG;
      const cs = Math.cos(rad), sn = Math.sin(rad);
      const localToWorld = (lx: number, ly: number): V2 => mpt([c.at[0] + lx * cs - ly * sn, c.at[1] + lx * sn + ly * cs], c.side);

      // Courtyard outline: every part on small boards; on dense boards only the part in focus
      // (thousands of outlines are noise, the bodies already show where parts are)
      const focus = isSelected || isCompHov;
      const margin = dense ? 0.06 : 0.4;
      const hw = c.body.w * 0.5 + margin, hh = c.body.h * 0.5 + margin;
      if (!dense || focus) {
        const c0 = localToWorld(-hw, -hh), c1 = localToWorld(hw, -hh), c2 = localToWorld(hw, hh), c3 = localToWorld(-hw, hh);
        const outlineCol: [number, number, number] = dense ? [0.98, 0.85, 0.30] : [0.92, 0.94, 0.90];
        const outlineW = dense ? 0.09 : 0.12;
        const outlineZ = dense ? 0.062 : 0.045;
        pushSilkSeg(c0, c1, outlineW, dSide, outlineCol, outlineZ);
        pushSilkSeg(c1, c2, outlineW, dSide, outlineCol, outlineZ);
        pushSilkSeg(c2, c3, outlineW, dSide, outlineCol, outlineZ);
        pushSilkSeg(c3, c0, outlineW, dSide, outlineCol, outlineZ);
      }

      const dispPos = mpt(c.at, c.side);
      if (dense) {
        // Fit the reference inside the body (screen-aligned extent), turned 90° on tall parts.
        if (focus || inView(dispPos)) {
          const r = c.rot * DEG;
          const ex = Math.abs(c.body.w * Math.cos(r)) + Math.abs(c.body.h * Math.sin(r));
          const ey = Math.abs(c.body.w * Math.sin(r)) + Math.abs(c.body.h * Math.cos(r));
          const per = textWidth(c.ref, 1);
          const fit = c.body.shape === 'box' && c.pads.length === 2 ? 0.62 : 0.95; // between the end caps
          const hSize = Math.min(2.4, ey * 0.6, (ex * fit) / per);
          const vSize = Math.min(2.4, ex * 0.6, (ey * fit) / per);
          const vert = vSize > hSize * 1.15;
          let size = vert ? vSize : hSize;
          if (focus) size = Math.max(size, Math.min(minLabelMm * 1.1, 3)); // the part in focus is always named
          if (focus || size >= minLabelMm) {
            const tw = per * size;
            const z = c.state.populated ? c.body.z + 0.05 : 0.085;
            labels.push({ at: dispPos, text: c.ref, size, side: dSide, rot: vert ? 90 : 0, z, rgb: focus ? [1, 0.9, 0.4] : [0.95, 0.97, 1.0], prio: focus ? Infinity : ex * ey, w: vert ? size : tw, h: vert ? tw : size });
          }
        }
      } else {
        const refOff = c.body.shape === 'coin' ? -c.body.h * 0.5 - 1.6 : c.body.h * 0.5 + 1.3;
        pushSilkText(localToWorld(0, refOff), c.ref, 1.25, dSide, 0);

        // Polarity mark on silkscreen (fixed to footprint, does NOT rotate when reversed!)
        if ((c.kind === 'led' || c.kind === 'diode')) {
          const kPos = localToWorld(-c.body.w * 0.5 - 0.8, 0);
          pushSilkText(kPos, 'K', 0.95, dSide, 0);
          const aPos = localToWorld(c.body.w * 0.5 + 0.8, 0);
          pushSilkText(aPos, '+', 0.95, dSide, 0);
          // Cathode bar on silkscreen
          const kb0 = localToWorld(-hw - 0.25, -hh * 0.7), kb1 = localToWorld(-hw - 0.25, hh * 0.7);
          pushSilkSeg(kb0, kb1, 0.22, dSide);
        } else if (c.kind === 'battery') {
          const p1 = c.pads.find((p) => p.name === c.pins['+']);
          if (p1) {
            const pPos = localToWorld(p1.at[0], p1.at[1] - 2.1);
            pushSilkText(pPos, '+', 1.3, dSide, 0);
          }
        }
      }

      // Visible damage: scorched laminate under a part that burned, liquid-damage crust at its pins
      if (!thermal) {
        if (c.state.burnt && c.state.populated) {
          const d = Math.max(c.body.w, c.body.h) * 1.5 + 0.6;
          op.cyl.pushTRS(dispPos[0], dispPos[1], sgn * (ht + 0.014), d, d * 0.85, 0.004, dispRot, 0.11, 0.075, 0.045, 1, 0, 0, 0.95);
        }
        const res = c.state.residue;
        if (res) {
          let seed = 0;
          for (let i = 0; i < c.ref.length; i++) seed = (seed * 31 + c.ref.charCodeAt(i)) >>> 0;
          const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
          const scale = Math.sqrt(res.amount);
          for (const pi of res.pads ?? c.pads.map((_, k) => k)) {
            const p = c.pads[pi];
            if (!p) continue;
            const at = mpt(padWorld(c, p).at, c.side);
            const ps = Math.max(0.15, Math.min(p.size[0], p.size[1]));
            for (let k = 0; k < 5; k++) {
              const ang = rnd() * Math.PI * 2, rr = ps * (0.35 + 0.6 * rnd());
              const sz = ps * (0.35 + 0.45 * rnd()) * scale;
              const g = rnd(); // salts (white) … copper corrosion (verdigris)
              const col: [number, number, number] = [0.86 - 0.56 * g, 0.88 - 0.28 * g, 0.80 - 0.30 * g];
              op.sphere.pushTRS(at[0] + Math.cos(ang) * rr, at[1] + Math.sin(ang) * rr, sgn * (ht + 0.06), sz, sz * (0.7 + 0.3 * rnd()), 0.06, rnd() * 180, col[0], col[1], col[2], 1, 0, 0, 0.95);
            }
          }
        }
      }

      // 3D Component Body
      const diodeGlow = !!diodeLitIds?.includes(c.id);
      this.pushComponentBody(c, sgn, ht, cSim, isSelected || isCompHov, op, al, thermal, diodeGlow, dispPos, dispRot, this.occluders(board).has(c.id));
    }

    for (const l of placeLabels(labels)) pushSilkText(l.at, l.text, l.size, l.side, l.rot, l.rgb, l.z);

    // 8b. Airwires of the selected part: which pins each of its nets reaches. Straight lines by
    // convention — they show what connects, not the (unknown) copper route. One colour per net.
    const selComp = selectedCompId ? board.components.find((x) => x.id === selectedCompId) : undefined;
    if (selComp) {
      if (!this.airCache || this.airCache.conn !== conn || this.airCache.comp !== selComp) {
        this.airCache = { conn, comp: selComp, wires: airwiresFor(board, conn, selComp) };
      }
      const flat = camera.mode === '2d';
      const lift = flat ? 4 : 0.12; // 2D: above every body so the lines stay visible
      const zOf = (side: Side) => {
        const s = flat ? (both ? 'F' : camera.side) : effSide(side);
        return s === 'F' ? ht + lift : -ht - lift;
      };
      const w = Math.max(0.03, 1.6 / pxPerMm);
      for (const aw of this.airCache.wires) {
        const pa = mpt(aw.a, aw.sa), pb = mpt(aw.b, aw.sb);
        const [r, g, b] = netHue(aw.net);
        al.cyl.pushSeg3D([pa[0], pa[1], zOf(aw.sa)], [pb[0], pb[1], zOf(aw.sb)], w, w, r, g, b, 0.9, 0.6, 0, 0.8);
      }
    }

    // 9. Multimeter Probes
    const pushProbe = (probe: { pos: V2; side: Side } | null, r: number, g: number, b: number) => {
      if (!probe) return;
      const p = mpt(probe.pos, probe.side);
      const sgn = effSide(probe.side) === 'F' ? 1 : -1;
      const tipZ = sgn * (ht + 0.08);
      const topZ = sgn * (ht + 10.5);
      // Gold sharp tip
      op.cyl.pushSeg3D([p[0], p[1], tipZ], [p[0], p[1], tipZ + sgn * 2.2], 0.32, 0.32, 0.95, 0.80, 0.28, 1, 0.1, 0.95, 0.18);
      // Colored insulated handle angled slightly outward
      op.cyl.pushSeg3D([p[0], p[1], tipZ + sgn * 2.1], [p[0] + 2.4, p[1] - 2.4, topZ], 1.15, 1.15, r, g, b, 1, 0.12, 0.1, 0.45);
      this.pushGlow(p[0], p[1], tipZ + sgn * 0.2, 1.4, r, g, b, 0.55);
    };
    pushProbe(probeRed, 0.96, 0.22, 0.22);
    pushProbe(probeBlack, 0.20, 0.24, 0.30);

    // 10. Jumper Wire Draft Preview
    if (jumperDraft) {
      const da = mpt(jumperDraft.a, jumperDraft.la);
      const db = mpt(jumperDraft.b, jumperDraft.lb);
      const la = effSide(jumperDraft.la), lb = effSide(jumperDraft.lb);
      const za = la === 'F' ? ht + 0.3 : -ht - 0.3;
      const zb = lb === 'F' ? ht + 0.3 : -ht - 0.3;
      const mid: V3 = [(da[0] + db[0]) * 0.5, (da[1] + db[1]) * 0.5, za + (la === 'F' ? 2.4 : -2.4)];
      al.cyl.pushSeg3D([da[0], da[1], za], mid, 0.45, 0.45, 0.25, 0.90, 1.0, 0.85, 0.4, 0.2, 0.3);
      al.cyl.pushSeg3D(mid, [db[0], db[1], zb], 0.45, 0.45, 0.25, 0.90, 1.0, 0.85, 0.4, 0.2, 0.3);
    }

    // 11. Hover Reticle on board when using Knife / Iron / Jumper
    if (scene.cursorWorld && (scene.activeTool === 'knife' || scene.activeTool === 'iron' || scene.activeTool === 'jumper')) {
      const cSide = scene.cursorSide ?? camera.side;
      const cp = mpt(scene.cursorWorld, cSide);
      const sgn = effSide(cSide) === 'F' ? 1 : -1;
      const cz = sgn * (ht + 0.09);
      const col: [number, number, number] = scene.activeTool === 'knife' ? [1.0, 0.35, 0.30] : scene.activeTool === 'iron' ? [1.0, 0.72, 0.20] : [0.25, 0.85, 1.0];
      this.pushGlow(cp[0], cp[1], cz, 1.25, col[0], col[1], col[2], 0.45);
    }

    // 12. Tutorial Target Beacon
    if (scene.tutorialTarget) {
      const { pos: rawPos, side, radius = 3.2 } = scene.tutorialTarget;
      const pos = mpt(rawPos, side);
      const tSec = (performance.now() - this.startTime) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(tSec * 4.5);
      const r = radius * (0.94 + pulse * 0.14);
      const z = (effSide(side) === 'F' ? 1 : -1) * (ht + 0.11);
      const segs = 12;
      const segLen = (2 * Math.PI * r) / segs * 0.58;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2 + tSec * 0.8;
        const cx = pos[0] + Math.cos(a) * r;
        const cy = pos[1] + Math.sin(a) * r;
        const angDeg = (a * 180) / Math.PI + 90;
        al.box.pushTRS(cx, cy, z, segLen, 0.28, 0.05, angDeg, 0.23, 0.51, 0.96, 0.75 + pulse * 0.2, 0.45 + pulse * 0.25, 0.05, 0.4);
      }
      this.pushGlow(pos[0], pos[1], z, r * 1.35, 0.23, 0.55, 0.98, 0.28 + pulse * 0.18);
    }
  }

  private pushComponentBody(
    c: Component,
    sgn: number,
    ht: number,
    cSim: { i: number; v: number; p: number; on: boolean; bright: number; over: boolean } | undefined,
    highlighted: boolean,
    op: Record<MeshKind, InstanceBucket>,
    al: Record<MeshKind, InstanceBucket>,
    thermal = false,
    diodeGlow = false,
    displayAt: V2 = c.at,
    displayRot: number = c.rot,
    ghost = false,
  ) {
    const baseZ = sgn * ht;
    const effRot = displayRot + (c.state.reversed ? 180 : 0);
    const rad = effRot * DEG;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    // body outline may sit off the footprint origin (asymmetric connectors, modules)
    const [ox, oy] = c.body.off ?? [0, 0];
    const toW = (lx: number, ly: number, lz: number): V3 => [
      displayAt[0] + (lx + ox) * cs - (ly + oy) * sn,
      displayAt[1] + (lx + ox) * sn + (ly + oy) * cs,
      baseZ + sgn * lz,
    ];
    const padRad = displayRot * DEG;
    const pcs = Math.cos(padRad), psn = Math.sin(padRad);
    const toPadW = (lx: number, ly: number, lz = 0): V3 => [
      displayAt[0] + lx * pcs - ly * psn,
      displayAt[1] + lx * psn + ly * pcs,
      baseZ + sgn * lz,
    ];
    const spec = highlighted ? -1 : 0;
    const compTemp = this.curThermal?.partTemp(c.id)
      ?? 25 + (cSim ? cSim.p * (c.kind === 'resistor' ? 185 : c.kind === 'fuse' ? 240 : 130) + (c.kind === 'battery' && cSim.i > 0.2 ? cSim.i * 4 : 0) : 0);
    // Freeze-spray frost / isopropyl film: translucent layer over the part (any view mode)
    const surf = this.curThermal?.partSurface(c.id);
    if (surf && (surf.frost > 0.02 || surf.wet > 0.02) && c.state.populated) {
      const pz = toW(0, 0, Math.max(0.05, c.body.z) + 0.04);
      if (surf.frost > 0.02) al.box.pushTRS(pz[0], pz[1], pz[2], c.body.w * 1.25, c.body.h * 1.25, 0.08, effRot, 0.93, 0.96, 1.0, 0.35 + 0.55 * surf.frost, 0.25, 0.0, 0.9, spec);
      else al.box.pushTRS(pz[0], pz[1], pz[2], c.body.w * 1.3, c.body.h * 1.3, 0.03, effRot, 0.55, 0.7, 0.85, 0.18 + 0.3 * surf.wet, 0.05, 0.0, 0.05, spec);
    }
    // Rosin method: white matte film; where the part ran hot it has melted to a clear amber gloss
    if (surf && ((surf.rosin ?? 0) > 0.02 || (surf.melted ?? 0) > 0.02) && c.state.populated && !thermal) {
      const pz = toW(0, 0, Math.max(0.05, c.body.z) + 0.03);
      // (no selection highlight on the film: it must read as rosin, not as the selected part)
      if ((surf.rosin ?? 0) > 0.02) al.box.pushTRS(pz[0], pz[1], pz[2], c.body.w * 1.2, c.body.h * 1.2, 0.05, effRot, 1.0, 0.99, 0.95, 0.45 + 0.45 * surf.rosin!, 0.45, 0, 0.95, 0);
      else al.box.pushTRS(pz[0], pz[1], pz[2], c.body.w * 1.2, c.body.h * 1.2, 0.02, effRot, 0.85, 0.62, 0.25, 0.22, 0.1, 0.0, 0.08, 0);
    }
    const thermCol = thermal ? thermalColor(apparentTemp(compTemp, c.kind === 'connector' ? EMISSIVITY.shell : EMISSIVITY.package)) : null;
    const thermEm = thermal && compTemp > 40 ? Math.min(0.75, (compTemp - 40) / 80) : 0;
    // Bare tin terminations / leads: low emissivity, so an IR camera reads them near ambient
    const thermMetal = thermal ? thermalColor(apparentTemp(compTemp, EMISSIVITY.metal)) : null;
    // Ghost outline when unpopulated
    if (!c.state.populated) {
      const p = toW(0, 0, Math.min(0.8, c.body.z * 0.3));
      al.box.pushTRS(p[0], p[1], p[2], c.body.w, c.body.h, 0.5, effRot, 0.45, 0.78, 0.95, 0.26, 0.15, 0.1, 0.6, spec);
      return;
    }

    const burnt = c.state.burnt;
    const shape = c.body.shape;

    // A large body that covers other parts (module socket, shield frame) is drawn as an open
    // frame with a light tint: what sits under it stays visible and clickable.
    if (ghost) {
      const hw = c.body.w / 2, hh = c.body.h / 2, fz = Math.min(c.body.z, 1.2), t = Math.min(0.6, Math.max(0.25, Math.min(hw, hh) * 0.06));
      const col: [number, number, number] = thermCol ?? [0.30, 0.33, 0.38];
      for (const [cx, cy, w, h] of [[0, hh - t / 2, c.body.w, t], [0, -hh + t / 2, c.body.w, t], [hw - t / 2, 0, t, c.body.h], [-hw + t / 2, 0, t, c.body.h]] as const) {
        const q = toW(cx, cy, fz / 2);
        op.box.pushTRS(q[0], q[1], q[2], w, h, fz, effRot, col[0], col[1], col[2], 1, thermEm, 0.2, 0.6, spec);
      }
      const q = toW(0, 0, fz);
      al.box.pushTRS(q[0], q[1], q[2], c.body.w, c.body.h, 0.02, effRot, col[0], col[1], col[2], 0.12, 0, 0, 0.8, spec);
      return;
    }

    if (shape === 'axial') {
      // Bent metal leads to pads
      if (c.pads.length >= 2) {
        const p0 = toPadW(c.pads[0].at[0], c.pads[0].at[1], 0);
        const p1 = toPadW(c.pads[1].at[0], c.pads[1].at[1], 0);
        const l0 = toW(-c.body.w * 0.48, 0, c.body.z * 0.55);
        const l1 = toW(c.body.w * 0.48, 0, c.body.z * 0.55);
        op.cyl.pushSeg3D(p0, l0, 0.35, 0.35, 0.82, 0.84, 0.88, 1, 0, 0.92, 0.2);
        op.cyl.pushSeg3D(p1, l1, 0.35, 0.35, 0.82, 0.84, 0.88, 1, 0, 0.92, 0.2);
      }
      const cz = c.body.z * 0.55;
      const isDiode = c.kind === 'diode';
      const defaultBody: [number, number, number] = isDiode ? [0.13, 0.14, 0.16] : [0.85, 0.72, 0.50];
      const bodyCol: [number, number, number] = thermCol ?? (burnt ? [0.11, 0.10, 0.10] : defaultBody);
      const a = toW(-c.body.w * 0.5, 0, cz), b = toW(c.body.w * 0.5, 0, cz);
      op.cyl.pushSeg3D(a, b, c.body.h * 0.88, c.body.h * 0.88, bodyCol[0], bodyCol[1], bodyCol[2], 1, thermEm || (burnt ? 0 : 0.04), 0.1, 0.55, spec);
      if (!isDiode) {
        op.sphere.pushTRS(a[0], a[1], a[2], c.body.h * 0.96, c.body.h * 0.96, c.body.h * 0.96, 0, bodyCol[0], bodyCol[1], bodyCol[2], 1, thermEm, 0.1, 0.55, spec);
        op.sphere.pushTRS(b[0], b[1], b[2], c.body.h * 0.96, c.body.h * 0.96, c.body.h * 0.96, 0, bodyCol[0], bodyCol[1], bodyCol[2], 1, thermEm, 0.1, 0.55, spec);
      }

      if (!burnt && !thermal && isDiode) {
        // Silver cathode band near -X (pad 1 = K)
        const k0 = toW(-c.body.w * 0.36, 0, cz);
        const k1 = toW(-c.body.w * 0.20, 0, cz);
        op.cyl.pushSeg3D(k0, k1, c.body.h * 0.92, c.body.h * 0.92, 0.88, 0.90, 0.94, 1, 0.05, 0.6, 0.25);
      } else if (!burnt && !thermal && c.kind === 'resistor') {
        const [d1, d2, mul] = resistorBands(c.value);
        const bandCols = [
          BAND_RGB[d1],
          BAND_RGB[d2],
          mul < 0 ? GOLD_RGB : BAND_RGB[Math.min(9, mul)],
          GOLD_RGB,
        ];
        const offsets = [-0.28, -0.10, 0.08, 0.28];
        for (let bi = 0; bi < 4; bi++) {
          const p0 = toW(c.body.w * (offsets[bi] - 0.045), 0, cz);
          const p1 = toW(c.body.w * (offsets[bi] + 0.045), 0, cz);
          const col = bandCols[bi];
          op.cyl.pushSeg3D(p0, p1, c.body.h * 0.94, c.body.h * 0.94, col[0], col[1], col[2], 1, 0.05, 0.15, 0.4);
        }
      }
      if (cSim?.over) {
        const mp = toW(0, 0, cz + 1.0);
        this.pushGlow(mp[0], mp[1], mp[2], 4.5, 1.0, 0.35, 0.05, 0.75);
      }
      return;
    }

    if (shape === 'led') {
      const info = LED_INFO[c.color ?? 'red'];
      const lit = (!!cSim?.on || diodeGlow) && !burnt;
      const bright = cSim?.on ? cSim.bright : diodeGlow ? 0.25 : 0;
      const col: [number, number, number] = thermCol ?? (burnt ? [0.15, 0.14, 0.14] : info.rgb);
      const dia = Math.min(c.body.w, c.body.h);
      const cylH = c.body.z * 0.62;
      const pBase = toW(0, 0, cylH * 0.5);
      const pDome = toW(0, 0, cylH);
      // Cathode flat notch indicator on rim (local -X in LED footprint before 180 reversal)
      const pRim = toW(0, 0, 0.5);
      op.cyl.pushTRS(pRim[0], pRim[1], pRim[2], dia * 1.12, dia * 1.12, 1.0, effRot, col[0] * 0.75, col[1] * 0.75, col[2] * 0.75, 1, lit ? 0.5 * bright : thermEm, 0.1, 0.3, spec);
      // Flat cathode side indicator box on -X (pad 1 = K)
      const pFlat = toW(-dia * 0.48, 0, 0.52);
      op.box.pushTRS(pFlat[0], pFlat[1], pFlat[2], 0.6, dia * 0.72, 1.05, effRot, 0.85, 0.85, 0.85, 1, 0, 0.2, 0.4);

      if (burnt) {
        op.cyl.pushTRS(pBase[0], pBase[1], pBase[2], dia, dia, cylH, effRot, 0.12, 0.11, 0.11, 1, 0, 0.05, 0.9, spec);
        op.dome.pushTRS(pDome[0], pDome[1], pDome[2], dia, dia, sgn * dia, effRot, 0.12, 0.11, 0.11, 1, 0, 0.05, 0.9, spec);
      } else {
        // Real internal LED lead frame: larger Cathode anvil flag (-X) and smaller Anode post (+X)
        const pAnvil = toW(-dia * 0.16, 0, cylH * 0.52);
        const pPost = toW(dia * 0.22, 0, cylH * 0.44);
        op.box.pushTRS(pAnvil[0], pAnvil[1], pAnvil[2], dia * 0.32, dia * 0.18, cylH * 0.72, effRot, lit ? 1 : 0.75, lit ? 0.95 : 0.78, lit ? 0.85 : 0.82, 1, lit ? 1.8 * bright : 0, 0.9, 0.2);
        op.box.pushTRS(pPost[0], pPost[1], pPost[2], dia * 0.14, dia * 0.14, cylH * 0.62, effRot, 0.78, 0.80, 0.84, 1, lit ? 0.8 * bright : 0, 0.9, 0.2);
        // Translucent epoxy dome
        al.cyl.pushTRS(pBase[0], pBase[1], pBase[2], dia, dia, cylH, effRot, col[0], col[1], col[2], lit ? 0.88 : 0.52, lit ? 1.4 * bright : 0.08 + thermEm, 0.05, 0.15, spec);
        al.dome.pushTRS(pDome[0], pDome[1], pDome[2], dia, dia, sgn * dia, effRot, col[0], col[1], col[2], lit ? 0.9 : 0.55, lit ? 1.6 * bright : 0.08 + thermEm, 0.05, 0.15, spec);
        if (lit) {
          this.pushGlow(pDome[0], pDome[1], pDome[2] + sgn * 0.8, dia * (1.8 + bright * 1.4), info.rgb[0], info.rgb[1], info.rgb[2], 0.65 * bright);
        }
      }
      if (cSim?.over) {
        this.pushGlow(pDome[0], pDome[1], pDome[2], 6.0, 1.0, 0.25, 0.05, 0.85);
      }
      return;
    }

    if (shape === 'coin') {
      const pHolder = toW(0, 0, c.body.z * 0.45);
      const pCell = toW(0, 0, c.body.z * 0.65);
      const pClip = toW(-c.body.w * 0.45, 0, c.body.z * 1.05);
      const hc = thermCol ?? [0.14, 0.15, 0.17];
      const cc = thermCol ?? [0.82, 0.84, 0.88];
      op.cyl.pushTRS(pHolder[0], pHolder[1], pHolder[2], c.body.w + 1.4, c.body.h + 1.4, c.body.z * 0.9, effRot, hc[0], hc[1], hc[2], 1, thermEm, 0.08, 0.7, spec);
      op.cyl.pushTRS(pCell[0], pCell[1], pCell[2], c.body.w * 0.92, c.body.h * 0.92, c.body.z * 0.75, effRot, cc[0], cc[1], cc[2], 1, thermEm, 0.95, 0.18, spec);
      op.box.pushTRS(pClip[0], pClip[1], pClip[2], c.body.w * 0.25, 4.2, 0.35, effRot, 0.86, 0.88, 0.92, 1, 0, 0.95, 0.2);
      return;
    }

    if (shape === 'header') {
      const pBox = toW(0, 0, c.body.z * 0.32);
      const hc = thermCol ?? [0.12, 0.13, 0.16];
      op.box.pushTRS(pBox[0], pBox[1], pBox[2], c.body.w, c.body.h, c.body.z * 0.64, effRot, hc[0], hc[1], hc[2], 1, thermEm, 0.05, 0.65, spec);
      for (const p of c.pads) {
        const pw = toPadW(p.at[0], p.at[1], c.body.z * 0.55);
        op.box.pushTRS(pw[0], pw[1], pw[2], 0.64, 0.64, c.body.z * 0.95, effRot, 0.92, 0.74, 0.24, 1, 0, 0.95, 0.2);
      }
      return;
    }

    if (shape === 'tactile') {
      const pBody = toW(0, 0, c.body.z * 0.34);
      const pTop = toW(0, 0, c.body.z * 0.66);
      const pressed = !!c.state.closed;
      const btnH = pressed ? c.body.z * 0.18 : c.body.z * 0.34;
      const pBtn = toW(0, 0, c.body.z * 0.66 + btnH * 0.5);
      const bc = thermCol ?? [0.16, 0.17, 0.20];
      op.box.pushTRS(pBody[0], pBody[1], pBody[2], c.body.w, c.body.h, c.body.z * 0.68, effRot, bc[0], bc[1], bc[2], 1, thermEm, 0.1, 0.6, spec);
      op.box.pushTRS(pTop[0], pTop[1], pTop[2], c.body.w * 0.86, c.body.h * 0.86, 0.3, effRot, 0.76, 0.78, 0.82, 1, 0, 0.9, 0.25, spec);
      op.cyl.pushTRS(pBtn[0], pBtn[1], pBtn[2], c.body.w * 0.52, c.body.h * 0.52, btnH, effRot, pressed ? 0.22 : 0.12, pressed ? 0.75 : 0.13, pressed ? 0.45 : 0.16, 1, pressed ? 0.2 : 0, 0.1, 0.45, spec);
      return;
    }

    if (shape === 'fuse') {
      const cz = c.body.z * 0.55;
      if (c.pads.length >= 2) {
        const p0 = toPadW(c.pads[0].at[0], c.pads[0].at[1], 0);
        const p1 = toPadW(c.pads[1].at[0], c.pads[1].at[1], 0);
        op.cyl.pushSeg3D(p0, toW(-c.body.w * 0.48, 0, cz), 0.38, 0.38, 0.82, 0.84, 0.88, 1, 0, 0.92, 0.2);
        op.cyl.pushSeg3D(p1, toW(c.body.w * 0.48, 0, cz), 0.38, 0.38, 0.82, 0.84, 0.88, 1, 0, 0.92, 0.2);
      }
      const cap0a = toW(-c.body.w * 0.5, 0, cz), cap0b = toW(-c.body.w * 0.32, 0, cz);
      const cap1a = toW(c.body.w * 0.32, 0, cz), cap1b = toW(c.body.w * 0.5, 0, cz);
      const capC = thermCol ?? [0.86, 0.88, 0.92];
      op.cyl.pushSeg3D(cap0a, cap0b, c.body.h, c.body.h, capC[0], capC[1], capC[2], 1, thermEm, 0.95, 0.18, spec);
      op.cyl.pushSeg3D(cap1a, cap1b, c.body.h, c.body.h, capC[0], capC[1], capC[2], 1, thermEm, 0.95, 0.18, spec);
      if (burnt) {
        op.cyl.pushSeg3D(cap0b, cap1a, c.body.h * 0.92, c.body.h * 0.92, 0.12, 0.11, 0.12, 1, 0, 0.1, 0.85, spec);
      } else {
        const filHot = cSim ? Math.min(1, Math.abs(cSim.i) / Math.max(0.1, c.value)) : 0;
        op.cyl.pushSeg3D(cap0b, cap1a, 0.14, 0.14, 0.92 + filHot * 0.08, 0.85 - filHot * 0.4, 0.45 - filHot * 0.35, 1, 0.15 + filHot * 0.9, 0.95, 0.2);
        const gl = thermCol ?? [0.85, 0.93, 0.98];
        al.cyl.pushSeg3D(cap0b, cap1a, c.body.h * 0.92, c.body.h * 0.92, gl[0], gl[1], gl[2], thermal ? 0.72 : 0.35, thermEm, 0.1, 0.1, spec);
      }
      if (cSim?.over) {
        const mp = toW(0, 0, cz);
        this.pushGlow(mp[0], mp[1], mp[2], 5.0, 1.0, 0.55, 0.1, 0.85);
      }
      return;
    }

    if (shape === 'pin') {
      const pPin = toW(0, 0, c.body.z * 0.45);
      const pLoop = toW(0, 0, c.body.z * 0.9);
      const pc = thermCol ?? [0.92, 0.74, 0.24];
      op.cyl.pushTRS(pPin[0], pPin[1], pPin[2], 0.55, 0.55, c.body.z * 0.9, effRot, pc[0], pc[1], pc[2], 1, thermEm, 0.95, 0.2, spec);
      op.sphere.pushTRS(pLoop[0], pLoop[1], pLoop[2], c.body.w, c.body.h, c.body.w, effRot, pc[0], pc[1], pc[2], 1, 0.05 + thermEm, 0.95, 0.18, spec);
      return;
    }

    if (shape === 'radial') {
      const pCyl = toW(0, 0, c.body.z * 0.48);
      const pTop = toW(0, 0, c.body.z * 0.96);
      const d = Math.min(c.body.w, c.body.h);
      const rc: [number, number, number] = thermCol ?? (burnt ? [0.12, 0.11, 0.11] : [0.14, 0.24, 0.45]);
      op.cyl.pushTRS(pCyl[0], pCyl[1], pCyl[2], d, d, c.body.z * 0.96, effRot, rc[0], rc[1], rc[2], 1, thermEm, 0.2, 0.45, spec);
      op.cyl.pushTRS(pTop[0], pTop[1], pTop[2], d * 0.86, d * 0.86, 0.1, effRot, 0.82, 0.84, 0.88, 1, 0, 0.92, 0.2);
      return;
    }

    // Two-terminal chip part (0402 resistor, MLCC, SMD diode…): body between two metallised
    // end terminations that sit on the pads, so the probe points stay visible from above.
    if (shape === 'box' && c.pads.length === 2 && c.kind !== 'connector') {
      const [a, b] = c.pads;
      const ax = b.at[0] - a.at[0], ay = b.at[1] - a.at[1];
      const L = Math.hypot(ax, ay);
      if (L > 1e-3) {
        const alongX = Math.abs(ax) >= Math.abs(ay);
        const across = Math.max(0.1, Math.min(alongX ? c.body.h : c.body.w, Math.max(alongX ? a.size[1] : a.size[0], 0.2) * 1.05));
        const padAlong = Math.max(0.1, alongX ? a.size[0] : a.size[1]);
        const term = Math.min(padAlong * 0.75, L * 0.42);
        const bodyLen = Math.max(0.05, L - term * 0.9);
        const ang = effRot + (Math.atan2(ay, ax) * 180) / Math.PI;
        const z = c.body.z;
        const bodyCol: [number, number, number] = thermCol ?? (burnt ? [0.10, 0.09, 0.09]
          : c.kind === 'capacitor' ? [0.60, 0.48, 0.34]
            : c.kind === 'resistor' && c.label === 'Inductor' ? [0.22, 0.23, 0.25]
              : [0.09, 0.09, 0.10]);
        const mid = toPadW((a.at[0] + b.at[0]) / 2, (a.at[1] + b.at[1]) / 2, z * 0.5);
        op.box.pushTRS(mid[0], mid[1], mid[2], bodyLen, across * 0.96, z * 0.96, ang, bodyCol[0], bodyCol[1], bodyCol[2], 1, thermEm, 0.1, 0.6, spec);
        for (const p of [a, b]) {
          const t = toPadW(p.at[0], p.at[1], z * 0.5);
          const tc = thermMetal ?? [0.80, 0.81, 0.83];
          op.box.pushTRS(t[0], t[1], t[2], term, across, z, ang, tc[0], tc[1], tc[2], 1, thermal ? 0 : thermEm * 0.5, thermal ? 0.1 : 0.9, 0.25, spec);
        }
        return;
      }
    }

    // Default 'box' / 'chip'
    const pBox = toW(0, 0, c.body.z * 0.5);
    const col: [number, number, number] = thermCol ?? (burnt ? [0.10, 0.09, 0.09] : shape === 'chip' ? [0.13, 0.14, 0.16] : [0.35, 0.38, 0.44]);
    op.box.pushTRS(pBox[0], pBox[1], pBox[2], c.body.w, c.body.h, c.body.z, effRot, col[0], col[1], col[2], 1, thermEm, 0.1, 0.65, spec);
  }

  private curThermal: RenderSceneState['thermal'] = null;
  private airCache: { conn: Conn; comp: Component; wires: Airwire[] } | null = null;
  /** Parts whose body covers other parts on the same side (drawn as open frames), per board. */
  private occluderCache = new WeakMap<Board, { n: number; ids: Set<string> }>();
  private occluders(board: Board): Set<string> {
    const hit = this.occluderCache.get(board);
    if (hit && hit.n === board.components.length) return hit.ids;
    const ids = new Set<string>();
    for (const c of board.components) {
      if (c.body.w * c.body.h < 40) continue; // only large bodies can hide parts
      const a = (-c.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const [ox, oy] = c.body.off ?? [0, 0];
      let inside = 0;
      for (const o of board.components) {
        if (o === c || o.side !== c.side) continue;
        const dx = o.at[0] - c.at[0], dy = o.at[1] - c.at[1];
        const lx = dx * ca - dy * sa - ox, ly = dx * sa + dy * ca - oy;
        if (Math.abs(lx) < c.body.w / 2 && Math.abs(ly) < c.body.h / 2 && ++inside >= 2) break;
      }
      if (inside >= 2) ids.add(c.id);
    }
    this.occluderCache.set(board, { n: board.components.length, ids });
    return ids;
  }

  /** Copper-pour triangulations, keyed by the polygon (a pour can have ~50 000 points). */
  private zoneTris = new WeakMap<V2[], number[]>();
  private netIdxCache = new WeakMap<Conn, Map<string, number>>();
  private netIndexOf(conn: Conn): Map<string, number> {
    let m = this.netIdxCache.get(conn);
    if (!m) {
      m = new Map();
      conn.netNames.forEach((n, i) => { if (n && !m!.has(n)) m!.set(n, i); });
      this.netIdxCache.set(conn, m);
    }
    return m;
  }
  private innerCount = new WeakMap<Board, number>();
  private innerLayerCount(board: Board): number {
    let n = this.innerCount.get(board);
    if (n === undefined) {
      n = 0;
      for (const t of board.inner?.traces ?? []) n = Math.max(n, t.layer);
      for (const z of board.inner?.zones ?? []) n = Math.max(n, z.layer);
      this.innerCount.set(board, n);
    }
    return n;
  }

  render(camera: Camera, scene: RenderSceneState) {
    this.curThermal = scene.thermal ?? null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ensureAttachments(w, h);
    this.buildScene(scene, camera);
    const nowMs = performance.now();
    const dtPart = Math.min(0.05, (nowMs - this.lastTickTime) / 1000);
    this.lastTickTime = nowMs;
    this.stepParticles(dtPart);

    const { viewProj, eye } = camera.matrices(w, h);
    const tSec = (performance.now() - this.startTime) / 1000;
    const u = new Float32Array(24);
    u.set(viewProj, 0);
    u[16] = eye[0]; u[17] = eye[1]; u[18] = eye[2]; u[19] = 1;
    u[20] = tSec; u[21] = camera.bothSides ? 1 : camera.side === 'F' ? 1 : -1; u[22] = scene.vizMode === 'xray' ? 1 : 0; u[23] = 0;
    this.device.queue.writeBuffer(this.uniformBuf, 0, u.buffer);

    // Count total instances across all buckets and resize GPU buffer if needed
    const order: { pass: 'opaque' | 'alpha'; kind: MeshKind; slice: MeshSlice }[] = [
      { pass: 'opaque', kind: 'box', slice: this.meshes.box },
      { pass: 'opaque', kind: 'cyl', slice: this.meshes.cyl },
      { pass: 'opaque', kind: 'dome', slice: this.meshes.dome },
      { pass: 'opaque', kind: 'sphere', slice: this.meshes.sphere },
      { pass: 'alpha', kind: 'box', slice: this.meshes.box },
      { pass: 'alpha', kind: 'cyl', slice: this.meshes.cyl },
      { pass: 'alpha', kind: 'dome', slice: this.meshes.dome },
      { pass: 'alpha', kind: 'sphere', slice: this.meshes.sphere },
    ];
    let totalInst = 0;
    for (const o of order) totalInst += this.buckets[o.pass][o.kind].count;
    if (totalInst > this.instanceCap) {
      this.instanceCap = Math.max(this.instanceCap * 2, totalInst);
      this.instanceBuf.destroy();
      this.instanceBuf = this.device.createBuffer({
        size: this.instanceCap * INSTANCE_FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    let instOffset = 0;
    const drawRanges: { pass: 'opaque' | 'alpha'; slice: MeshSlice; firstInstance: number; instanceCount: number }[] = [];
    for (const o of order) {
      const b = this.buckets[o.pass][o.kind];
      if (b.count === 0) continue;
      this.device.queue.writeBuffer(
        this.instanceBuf,
        instOffset * INSTANCE_FLOATS * 4,
        b.data.buffer,
        0,
        b.count * INSTANCE_FLOATS * 4,
      );
      drawRanges.push({ pass: o.pass, slice: o.slice, firstInstance: instOffset, instanceCount: b.count });
      instOffset += b.count;
    }

    if (this.zoneVertCount > this.zoneCap) {
      this.zoneCap = Math.max(this.zoneCap * 2, this.zoneVertCount);
      this.zoneBuf.destroy();
      this.zoneBuf = this.device.createBuffer({ size: this.zoneCap * 10 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (this.zoneVertCount > 0) {
      this.device.queue.writeBuffer(this.zoneBuf, 0, this.zoneData.buffer, 0, this.zoneVertCount * 10 * 4);
    }

    if (this.glowCount > this.glowCap) {
      this.glowCap = Math.max(this.glowCap * 2, this.glowCount);
      this.glowBuf.destroy();
      this.glowBuf = this.device.createBuffer({ size: this.glowCap * GLOW_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (this.glowCount > 0) {
      this.device.queue.writeBuffer(this.glowBuf, 0, this.glowData.buffer, 0, this.glowCount * GLOW_FLOATS * 4);
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTex!.createView(),
        resolveTarget: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.043, g: 0.047, b: 0.055, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: this.depthTex!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    pass.setBindGroup(0, this.bindGroup);

    // 1. Opaque Instanced Meshes
    pass.setPipeline(this.solidOpaque);
    pass.setVertexBuffer(0, this.vbo);
    pass.setVertexBuffer(1, this.instanceBuf);
    pass.setIndexBuffer(this.ibo, 'uint32');
    for (const dr of drawRanges) {
      if (dr.pass !== 'opaque') continue;
      pass.drawIndexed(dr.slice.indexCount, dr.instanceCount, dr.slice.indexOffset, 0, dr.firstInstance);
    }

    // 2. Copper Zones
    if (this.zoneVertCount > 0) {
      pass.setPipeline(this.zonePipe);
      pass.setVertexBuffer(0, this.zoneBuf);
      pass.draw(this.zoneVertCount);
    }

    // 3. Translucent Meshes (LED epoxy, fuse glass, ghost outlines, xray substrate)
    pass.setPipeline(this.solidAlpha);
    pass.setVertexBuffer(0, this.vbo);
    pass.setVertexBuffer(1, this.instanceBuf);
    pass.setIndexBuffer(this.ibo, 'uint32');
    for (const dr of drawRanges) {
      if (dr.pass !== 'alpha') continue;
      pass.drawIndexed(dr.slice.indexCount, dr.instanceCount, dr.slice.indexOffset, 0, dr.firstInstance);
    }

    // 4. Additive Glow (lit LEDs, probes, overloads)
    if (this.glowCount > 0) {
      pass.setPipeline(this.glowPipe);
      pass.setVertexBuffer(0, this.glowBuf);
      pass.draw(6, this.glowCount, 0, 0);
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.vbo?.destroy();
    this.ibo?.destroy();
    this.uniformBuf?.destroy();
    this.instanceBuf?.destroy();
    this.zoneBuf?.destroy();
    this.glowBuf?.destroy();
  }
}
