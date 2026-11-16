export const SOLID_WGSL = /* wgsl */ `
struct FrameUniforms {
  viewProj: mat4x4<f32>,
  eyePos: vec4<f32>,
  timeAndFlags: vec4<f32>, // x = time, y = activeSide (+1 F, -1 B), z = xray (0/1)
};

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct VertIn {
  @location(0) pos: vec3<f32>,
  @location(1) norm: vec3<f32>,
  @location(2) m0: vec4<f32>,
  @location(3) m1: vec4<f32>,
  @location(4) m2: vec4<f32>,
  @location(5) m3: vec4<f32>,
  @location(6) color: vec4<f32>,
  @location(7) extra: vec4<f32>, // x=emissive, y=metallic, z=roughness, w=special (1=cold grain, -1=pulse)
};

struct VertOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNorm: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) extra: vec4<f32>,
};

@vertex
fn vs_main(v: VertIn) -> VertOut {
  let model = mat4x4<f32>(v.m0, v.m1, v.m2, v.m3);
  let wp = model * vec4<f32>(v.pos, 1.0);
  // Inverse-transpose approximation works cleanly for uniform/orthogonal + scaled transforms via cof/length
  let nMat = mat3x3<f32>(v.m0.xyz, v.m1.xyz, v.m2.xyz);
  let sx = max(1e-4, dot(nMat[0], nMat[0]));
  let sy = max(1e-4, dot(nMat[1], nMat[1]));
  let sz = max(1e-4, dot(nMat[2], nMat[2]));
  let wn = normalize(nMat * (v.norm / vec3<f32>(sx, sy, sz)));

  var out: VertOut;
  out.clipPos = frame.viewProj * wp;
  out.worldPos = wp.xyz;
  out.worldNorm = wn;
  out.color = v.color;
  out.extra = v.extra;
  return out;
}

fn hash3(p: vec3<f32>) -> f32 {
  let q = fract(p * vec3<f32>(443.8975, 397.2973, 491.1871));
  let d = dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * d);
}

@fragment
fn fs_main(in: VertOut) -> @location(0) vec4<f32> {
  let N = normalize(in.worldNorm);
  let V = normalize(frame.eyePos.xyz - in.worldPos);

  // Two-sided bench lighting so both top (+Z) and bottom (-Z) look crisp.
  let sideZ = select(-1.0, 1.0, frame.eyePos.z >= 0.0);
  let L1 = normalize(vec3<f32>(0.42, 0.55, 0.72 * sideZ));
  let L2 = normalize(vec3<f32>(-0.55, -0.35, 0.58 * sideZ));
  let H1 = normalize(L1 + V);

  let diff1 = max(dot(N, L1), 0.0);
  let diff2 = max(dot(N, L2), 0.0) * 0.42;

  var base = in.color.rgb;
  var metallic = in.extra.y;
  var rough = max(0.08, in.extra.z);

  // Cold solder joint procedural grainy oxidized texture
  if (in.extra.w > 0.5) {
    let n = hash3(floor(in.worldPos * 14.0));
    base = mix(vec3<f32>(0.36, 0.37, 0.40), vec3<f32>(0.58, 0.58, 0.55), n);
    metallic = 0.25;
    rough = 0.85;
  }

  let shininess = mix(96.0, 10.0, rough);
  let specPow = pow(max(dot(N, H1), 0.0), shininess) * mix(0.18, 0.95, metallic);
  let fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0) * mix(0.04, 0.35, metallic);

  let ambient = 0.28;
  var lit = base * (ambient + diff1 * 0.78 + diff2) + vec3<f32>(1.0, 0.98, 0.94) * (specPow + fresnel);

  // Emissive LED / copper highlight / burnt glow
  lit += base * in.extra.x;

  // Pulsing highlight rim for selected / hovered parts
  if (in.extra.w < -0.5) {
    let pulse = 0.55 + 0.45 * sin(frame.timeAndFlags.x * 7.0);
    lit = mix(lit, vec3<f32>(0.35, 0.88, 1.0), 0.35 * pulse);
  }

  return vec4<f32>(lit, in.color.a);
}
`;

export const ZONE_WGSL = /* wgsl */ `
struct FrameUniforms {
  viewProj: mat4x4<f32>,
  eyePos: vec4<f32>,
  timeAndFlags: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct ZoneVertIn {
  @location(0) pos: vec3<f32>,
  @location(1) norm: vec3<f32>,
  @location(2) color: vec4<f32>,
};
struct ZoneVertOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) norm: vec3<f32>,
};

@vertex
fn vs_zone(v: ZoneVertIn) -> ZoneVertOut {
  var out: ZoneVertOut;
  out.clipPos = frame.viewProj * vec4<f32>(v.pos, 1.0);
  out.color = v.color;
  out.norm = v.norm;
  return out;
}

@fragment
fn fs_zone(in: ZoneVertOut) -> @location(0) vec4<f32> {
  let sideZ = select(-1.0, 1.0, frame.eyePos.z >= 0.0);
  let L1 = normalize(vec3<f32>(0.42, 0.55, 0.72 * sideZ));
  let diff = max(dot(normalize(in.norm), L1), 0.0);
  return vec4<f32>(in.color.rgb * (0.45 + 0.55 * diff), in.color.a);
}
`;

export const GLOW_WGSL = /* wgsl */ `
struct FrameUniforms {
  viewProj: mat4x4<f32>,
  eyePos: vec4<f32>,
  timeAndFlags: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct GlowIn {
  @builtin(vertex_index) vid: u32,
  @location(0) posAndRadius: vec4<f32>, // xyz world pos, w = radius mm
  @location(1) colorAndAlpha: vec4<f32>,
};

struct GlowOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_glow(in: GlowIn) -> GlowOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let uv = quad[in.vid];
  let toEye = normalize(frame.eyePos.xyz - in.posAndRadius.xyz);
  let upRef = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 0.0), abs(toEye.y) < 0.9);
  let right = normalize(cross(upRef, toEye));
  let up = cross(toEye, right);
  let wp = in.posAndRadius.xyz + (right * uv.x + up * uv.y) * in.posAndRadius.w;

  var out: GlowOut;
  out.clipPos = frame.viewProj * vec4<f32>(wp, 1.0);
  out.uv = uv;
  out.color = in.colorAndAlpha;
  return out;
}

@fragment
fn fs_glow(in: GlowOut) -> @location(0) vec4<f32> {
  let r = length(in.uv);
  if (r > 1.0) { discard; }
  let falloff = pow(1.0 - r, 2.2);
  return vec4<f32>(in.color.rgb * falloff * in.color.a, falloff * in.color.a);
}
`;
