// Procedural indexed unit 3D meshes packed into one GPU vertex+index buffer.
export interface MeshSlice {
  indexOffset: number;
  indexCount: number;
}

export interface PackedMeshes {
  vertices: Float32Array; // stride 6 floats: px, py, pz, nx, ny, nz
  indices: Uint32Array;
  box: MeshSlice;
  cyl: MeshSlice;
  dome: MeshSlice;
  sphere: MeshSlice;
}

export function buildUnitMeshes(): PackedMeshes {
  const verts: number[] = [];
  const inds: number[] = [];

  const pushVert = (px: number, py: number, pz: number, nx: number, ny: number, nz: number) => {
    verts.push(px, py, pz, nx, ny, nz);
    return verts.length / 6 - 1;
  };

  // 1. Unit Box centered at (0,0,0), extent [-0.5..0.5]^3
  const boxStart = inds.length;
  const faces: [number[], number[], number[], number[], number[]][] = [
    [[0, 0, 1], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
    [[0, 0, -1], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
    [[1, 0, 0], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]],
    [[-1, 0, 0], [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]],
    [[0, 1, 0], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]],
    [[0, -1, 0], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]],
  ];
  for (const [n, a, b, c, d] of faces) {
    const i0 = pushVert(a[0], a[1], a[2], n[0], n[1], n[2]);
    const i1 = pushVert(b[0], b[1], b[2], n[0], n[1], n[2]);
    const i2 = pushVert(c[0], c[1], c[2], n[0], n[1], n[2]);
    const i3 = pushVert(d[0], d[1], d[2], n[0], n[1], n[2]);
    inds.push(i0, i1, i2, i0, i2, i3);
  }
  const box: MeshSlice = { indexOffset: boxStart, indexCount: inds.length - boxStart };

  // 2. Unit Cylinder along Z, radius 0.5, z in [-0.5, 0.5]
  const cylStart = inds.length;
  const seg = 24;
  const topCenter = pushVert(0, 0, 0.5, 0, 0, 1);
  const botCenter = pushVert(0, 0, -0.5, 0, 0, -1);
  const topRing: number[] = [];
  const botRing: number[] = [];
  const sideTop: number[] = [];
  const sideBot: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    topRing.push(pushVert(c * 0.5, s * 0.5, 0.5, 0, 0, 1));
    botRing.push(pushVert(c * 0.5, s * 0.5, -0.5, 0, 0, -1));
    sideTop.push(pushVert(c * 0.5, s * 0.5, 0.5, c, s, 0));
    sideBot.push(pushVert(c * 0.5, s * 0.5, -0.5, c, s, 0));
  }
  for (let i = 0; i < seg; i++) {
    inds.push(topCenter, topRing[i], topRing[i + 1]);
    inds.push(botCenter, botRing[i + 1], botRing[i]);
    inds.push(sideBot[i], sideBot[i + 1], sideTop[i + 1], sideBot[i], sideTop[i + 1], sideTop[i]);
  }
  const cyl: MeshSlice = { indexOffset: cylStart, indexCount: inds.length - cylStart };

  // 3. Unit Hemisphere Dome: radius 0.5, z in [0, 0.5]
  const domeStart = inds.length;
  const lat = 8, lon = 20;
  const domeRows: number[][] = [];
  for (let r = 0; r <= lat; r++) {
    const phi = (r / lat) * (Math.PI / 2);
    const z = Math.sin(phi) * 0.5;
    const rad = Math.cos(phi) * 0.5;
    const row: number[] = [];
    for (let c = 0; c <= lon; c++) {
      const th = (c / lon) * Math.PI * 2;
      const nx = Math.cos(th) * Math.cos(phi);
      const ny = Math.sin(th) * Math.cos(phi);
      const nz = Math.sin(phi);
      row.push(pushVert(Math.cos(th) * rad, Math.sin(th) * rad, z, nx, ny, nz));
    }
    domeRows.push(row);
  }
  for (let r = 0; r < lat; r++) {
    for (let c = 0; c < lon; c++) {
      const a = domeRows[r][c], b = domeRows[r][c + 1];
      const d = domeRows[r + 1][c], e = domeRows[r + 1][c + 1];
      inds.push(a, b, e, a, e, d);
    }
  }
  const dome: MeshSlice = { indexOffset: domeStart, indexCount: inds.length - domeStart };

  // 4. Unit Sphere: radius 0.5 centered at 0
  const sphereStart = inds.length;
  const sLat = 10, sLon = 18;
  const sRows: number[][] = [];
  for (let r = 0; r <= sLat; r++) {
    const phi = -Math.PI / 2 + (r / sLat) * Math.PI;
    const z = Math.sin(phi) * 0.5;
    const rad = Math.cos(phi) * 0.5;
    const row: number[] = [];
    for (let c = 0; c <= sLon; c++) {
      const th = (c / sLon) * Math.PI * 2;
      const nx = Math.cos(th) * Math.cos(phi);
      const ny = Math.sin(th) * Math.cos(phi);
      const nz = Math.sin(phi);
      row.push(pushVert(Math.cos(th) * rad, Math.sin(th) * rad, z, nx, ny, nz));
    }
    sRows.push(row);
  }
  for (let r = 0; r < sLat; r++) {
    for (let c = 0; c < sLon; c++) {
      const a = sRows[r][c], b = sRows[r][c + 1];
      const d = sRows[r + 1][c], e = sRows[r + 1][c + 1];
      inds.push(a, b, e, a, e, d);
    }
  }
  const sphere: MeshSlice = { indexOffset: sphereStart, indexCount: inds.length - sphereStart };

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(inds),
    box,
    cyl,
    dome,
    sphere,
  };
}
