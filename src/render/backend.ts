// The part of the renderer that talks to the GPU. The scene (src/render/renderer.ts) is built on
// the CPU into plain float arrays; a backend uploads them and draws four passes: opaque instanced
// meshes, copper zones, translucent instanced meshes, additive glow sprites. WebGPU is the main
// backend; WebGL2 (gpu-webgl2.ts) draws the same frame where WebGPU is missing or blocked.
import type { MeshSlice, PackedMeshes } from './meshes';

/** Per instance: model matrix (16), rgba (4), emissive / metallic / roughness / special (4). */
export const INSTANCE_FLOATS = 24;
/** Per glow sprite: xyz + radius, rgba. */
export const GLOW_FLOATS = 8;
/** Per zone vertex: xyz, normal, rgba. */
export const ZONE_FLOATS = 10;
/** Background colour of the bench. */
export const CLEAR_RGB: [number, number, number] = [0.043, 0.047, 0.055];

export interface InstanceDraw {
  pass: 'opaque' | 'alpha';
  slice: MeshSlice;
  /** Instances packed INSTANCE_FLOATS apart; only the first `count` are used. */
  data: Float32Array;
  count: number;
}

export interface Frame {
  width: number;
  height: number;
  /** viewProj (16, column-major, clip z in 0..1), eye xyz + 1, time / active side / xray / 0. */
  uniforms: Float32Array;
  draws: InstanceDraw[];
  zones: Float32Array;
  zoneVerts: number;
  glow: Float32Array;
  glowCount: number;
}

export interface GpuBackend {
  /** e.g. "WebGPU" or "WebGL2", plus the GPU, for bug reports. */
  readonly description: string;
  draw(frame: Frame): void;
  destroy(): void;
}

export type BackendFactory = (canvas: HTMLCanvasElement, meshes: PackedMeshes) => Promise<GpuBackend>;
