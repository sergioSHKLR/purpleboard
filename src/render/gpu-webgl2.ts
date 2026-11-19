// WebGL2 backend: draws the same frame as the WebGPU one (backend.ts) for browsers and GPUs
// without WebGPU. The shaders are GLSL ES 3.00 ports of shaders.ts; keep the two in step.
//
// Differences handled here: the projection maps depth to 0..1 (WebGPU), so the vertex shaders
// remap it to WebGL's -1..1; WebGL2 has no "first instance" for a draw, so each draw points the
// instance attributes at its own offset in the buffer instead.
import { CLEAR_RGB, GLOW_FLOATS, INSTANCE_FLOATS, ZONE_FLOATS, type Frame, type GpuBackend } from './backend';
import type { PackedMeshes } from './meshes';

const HEAD = `#version 300 es
precision highp float;
uniform mat4 viewProj;
uniform vec4 eyePos;
uniform vec4 timeAndFlags; // x = time, y = activeSide (+1 F, -1 B), z = xray (0/1)
// projection gives z in 0..1 (WebGPU); WebGL clips -1..1
vec4 toClip(vec3 wp) { vec4 c = viewProj * vec4(wp, 1.0); c.z = c.z * 2.0 - c.w; return c; }
`;

const SOLID_VS = HEAD + `
layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 norm;
layout(location = 2) in vec4 m0;
layout(location = 3) in vec4 m1;
layout(location = 4) in vec4 m2;
layout(location = 5) in vec4 m3;
layout(location = 6) in vec4 color;
layout(location = 7) in vec4 extra; // x=emissive, y=metallic, z=roughness, w=special (1=cold grain, -1=pulse)
out vec3 vWorldPos;
out vec3 vWorldNorm;
out vec4 vColor;
out vec4 vExtra;
void main() {
  mat4 model = mat4(m0, m1, m2, m3);
  vec4 wp = model * vec4(pos, 1.0);
  mat3 nMat = mat3(m0.xyz, m1.xyz, m2.xyz);
  float sx = max(1e-4, dot(nMat[0], nMat[0]));
  float sy = max(1e-4, dot(nMat[1], nMat[1]));
  float sz = max(1e-4, dot(nMat[2], nMat[2]));
  vWorldNorm = normalize(nMat * (norm / vec3(sx, sy, sz)));
  gl_Position = toClip(wp.xyz);
  vWorldPos = wp.xyz;
  vColor = color;
  vExtra = extra;
}`;

const SOLID_FS = HEAD + `
in vec3 vWorldPos;
in vec3 vWorldNorm;
in vec4 vColor;
in vec4 vExtra;
out vec4 outColor;
float hash3(vec3 p) {
  vec3 q = fract(p * vec3(443.8975, 397.2973, 491.1871));
  float d = dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * d);
}
void main() {
  vec3 N = normalize(vWorldNorm);
  vec3 V = normalize(eyePos.xyz - vWorldPos);
  float sideZ = eyePos.z >= 0.0 ? 1.0 : -1.0;
  vec3 L1 = normalize(vec3(0.42, 0.55, 0.72 * sideZ));
  vec3 L2 = normalize(vec3(-0.55, -0.35, 0.58 * sideZ));
  vec3 H1 = normalize(L1 + V);
  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0) * 0.42;
  vec3 base = vColor.rgb;
  float metallic = vExtra.y;
  float rough = max(0.08, vExtra.z);
  if (vExtra.w > 0.5) {
    float n = hash3(floor(vWorldPos * 14.0));
    base = mix(vec3(0.36, 0.37, 0.40), vec3(0.58, 0.58, 0.55), n);
    metallic = 0.25;
    rough = 0.85;
  }
  float shininess = mix(96.0, 10.0, rough);
  float specPow = pow(max(dot(N, H1), 0.0), shininess) * mix(0.18, 0.95, metallic);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0) * mix(0.04, 0.35, metallic);
  vec3 lit = base * (0.28 + diff1 * 0.78 + diff2) + vec3(1.0, 0.98, 0.94) * (specPow + fresnel);
  lit += base * vExtra.x;
  if (vExtra.w < -0.5) {
    float pulse = 0.55 + 0.45 * sin(timeAndFlags.x * 7.0);
    lit = mix(lit, vec3(0.35, 0.88, 1.0), 0.35 * pulse);
  }
  outColor = vec4(lit, vColor.a);
}`;

const ZONE_VS = HEAD + `
layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 norm;
layout(location = 2) in vec4 color;
out vec4 vColor;
out vec3 vNorm;
void main() { gl_Position = toClip(pos); vColor = color; vNorm = norm; }`;

const ZONE_FS = HEAD + `
in vec4 vColor;
in vec3 vNorm;
out vec4 outColor;
void main() {
  float sideZ = eyePos.z >= 0.0 ? 1.0 : -1.0;
  vec3 L1 = normalize(vec3(0.42, 0.55, 0.72 * sideZ));
  float diff = max(dot(normalize(vNorm), L1), 0.0);
  outColor = vec4(vColor.rgb * (0.45 + 0.55 * diff), vColor.a);
}`;

const GLOW_VS = HEAD + `
layout(location = 0) in vec4 posAndRadius; // xyz world pos, w = radius mm
layout(location = 1) in vec4 colorAndAlpha;
out vec2 vUv;
out vec4 vColor;
const vec2 QUAD[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
void main() {
  vec2 uv = QUAD[gl_VertexID];
  vec3 toEye = normalize(eyePos.xyz - posAndRadius.xyz);
  vec3 upRef = abs(toEye.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(upRef, toEye));
  vec3 up = cross(toEye, right);
  gl_Position = toClip(posAndRadius.xyz + (right * uv.x + up * uv.y) * posAndRadius.w);
  vUv = uv;
  vColor = colorAndAlpha;
}`;

const GLOW_FS = HEAD + `
in vec2 vUv;
in vec4 vColor;
out vec4 outColor;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float falloff = pow(1.0 - r, 2.2);
  outColor = vec4(vColor.rgb * falloff * vColor.a, falloff * vColor.a);
}`;

interface Prog { p: WebGLProgram; viewProj: WebGLUniformLocation | null; eyePos: WebGLUniformLocation | null; timeAndFlags: WebGLUniformLocation | null }

export class WebGL2Backend implements GpuBackend {
  description = 'WebGL2';
  private solid!: Prog;
  private zone!: Prog;
  private glowProg!: Prog;
  private meshVao!: WebGLVertexArrayObject;
  private zoneVao!: WebGLVertexArrayObject;
  private glowVao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private ibo!: WebGLBuffer;
  private instanceBuf!: WebGLBuffer;
  private zoneBuf!: WebGLBuffer;
  private glowBuf!: WebGLBuffer;
  private instanceBytes = 0;
  private lost = false;

  private constructor(private gl: WebGL2RenderingContext) {}

  static async create(canvas: HTMLCanvasElement, meshes: PackedMeshes): Promise<WebGL2Backend> {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    const b = new WebGL2Backend(gl);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    b.description = `WebGL2: ${String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))}`;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); b.lost = true; });
    b.init(meshes);
    return b;
  }

  private program(vs: string, fs: string): Prog {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`WebGL2 shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`WebGL2 program: ${gl.getProgramInfoLog(p)}`);
    return { p, viewProj: gl.getUniformLocation(p, 'viewProj'), eyePos: gl.getUniformLocation(p, 'eyePos'), timeAndFlags: gl.getUniformLocation(p, 'timeAndFlags') };
  }

  private init(meshes: PackedMeshes) {
    const gl = this.gl;
    this.solid = this.program(SOLID_VS, SOLID_FS);
    this.zone = this.program(ZONE_VS, ZONE_FS);
    this.glowProg = this.program(GLOW_VS, GLOW_FS);

    this.meshVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, meshes.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, meshes.indices, gl.STATIC_DRAW);
    this.instanceBuf = gl.createBuffer()!;
    for (let i = 0; i < 6; i++) {
      gl.enableVertexAttribArray(2 + i);
      gl.vertexAttribDivisor(2 + i, 1);
    }

    this.zoneVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.zoneVao);
    this.zoneBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zoneBuf);
    const zs = ZONE_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, zs, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, zs, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, zs, 24);

    this.glowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.glowVao);
    this.glowBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
    const gs = GLOW_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, gs, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, gs, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  private use(prog: Prog, u: Float32Array) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.viewProj, false, u.subarray(0, 16));
    gl.uniform4fv(prog.eyePos, u.subarray(16, 20));
    gl.uniform4fv(prog.timeAndFlags, u.subarray(20, 24));
  }

  draw(f: Frame) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    gl.viewport(0, 0, f.width, f.height);
    gl.clearColor(CLEAR_RGB[0], CLEAR_RGB[1], CLEAR_RGB[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // instances: every draw's block, back to back
    let total = 0;
    for (const dr of f.draws) total += dr.count;
    const bytes = total * INSTANCE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    if (bytes > this.instanceBytes) {
      this.instanceBytes = Math.max(bytes, this.instanceBytes * 2, 1024 * INSTANCE_FLOATS * 4);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceBytes, gl.DYNAMIC_DRAW);
    }
    const first: number[] = [];
    let at = 0;
    for (const dr of f.draws) {
      if (dr.count) gl.bufferSubData(gl.ARRAY_BUFFER, at * INSTANCE_FLOATS * 4, dr.data, 0, dr.count * INSTANCE_FLOATS);
      first.push(at);
      at += dr.count;
    }

    const meshes = (which: 'opaque' | 'alpha') => {
      this.use(this.solid, f.uniforms);
      gl.bindVertexArray(this.meshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      const stride = INSTANCE_FLOATS * 4;
      f.draws.forEach((dr, i) => {
        if (dr.pass !== which || !dr.count) return;
        const base = first[i] * stride;
        for (let k = 0; k < 6; k++) gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, stride, base + 16 * k);
        gl.drawElementsInstanced(gl.TRIANGLES, dr.slice.indexCount, gl.UNSIGNED_INT, dr.slice.indexOffset * 4, dr.count);
      });
    };
    const over = () => { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); };

    // 1. opaque meshes
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    meshes('opaque');

    // 2. copper zones
    gl.disable(gl.CULL_FACE);
    if (f.zoneVerts > 0) {
      over();
      this.use(this.zone, f.uniforms);
      gl.bindVertexArray(this.zoneVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.zoneBuf);
      gl.bufferData(gl.ARRAY_BUFFER, f.zones.subarray(0, f.zoneVerts * ZONE_FLOATS), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, f.zoneVerts);
    }

    // 3. translucent meshes
    over();
    gl.depthMask(false);
    meshes('alpha');

    // 4. additive glow
    if (f.glowCount > 0) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
      gl.depthFunc(gl.LEQUAL);
      this.use(this.glowProg, f.uniforms);
      gl.bindVertexArray(this.glowVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
      gl.bufferData(gl.ARRAY_BUFFER, f.glow.subarray(0, f.glowCount * GLOW_FLOATS), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, f.glowCount);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  destroy() {
    const gl = this.gl;
    for (const b of [this.vbo, this.ibo, this.instanceBuf, this.zoneBuf, this.glowBuf]) gl.deleteBuffer(b);
    for (const v of [this.meshVao, this.zoneVao, this.glowVao]) gl.deleteVertexArray(v);
    for (const p of [this.solid, this.zone, this.glowProg]) gl.deleteProgram(p.p);
  }
}
