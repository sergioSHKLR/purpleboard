// Minimal ZIP reader / writer for mod packages (no dependency: deflate goes through the
// platform's DecompressionStream / CompressionStream, present in every WebGPU browser and Node 18+).
//
// Reads what common tools produce (Windows "Send to zip", macOS Archive Utility, 7-Zip, `zip`):
// stored and deflated entries, UTF-8 or CP437 names. Rejects encrypted entries and ZIP64, and caps
// entry count and unpacked size, since mods come from strangers (zip bombs).

export const ZIP_LIMITS = {
  entries: 4000,
  /** Total unpacked bytes. */
  total: 512 * 1024 * 1024,
  /** Unpacked bytes per file. */
  file: 256 * 1024 * 1024,
};

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

/** Path inside a package: forward slashes, no leading "./" or "/", no "..". Returns null when unsafe. */
export function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..' || s.includes('\0')) || /^[a-z]:$/i.test(parts[0] ?? '')) return null;
  return parts.join('/');
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > expected) { await reader.cancel(); throw new Error('entry is larger than its header says'); }
    out.set(value, n);
    n += value.length;
  }
  if (n !== expected) throw new Error('entry is shorter than its header says');
  return out;
}

/** Unpacks a ZIP archive into path → bytes (directories omitted, macOS "__MACOSX" metadata skipped). */
export async function readZip(b: Uint8Array): Promise<Map<string, Uint8Array>> {
  // end of central directory: last 22..(22 + 65535) bytes
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no central directory)');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported: re-pack the mod with a standard zip tool');
  if (count > ZIP_LIMITS.entries) throw new Error(`Too many files in the archive (${count}, max ${ZIP_LIMITS.entries})`);

  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('Damaged ZIP central directory');
    const flags = u16(b, p + 8), method = u16(b, p + 10);
    const csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const rawName = b.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? new TextDecoder().decode(rawName) : String.fromCharCode(...rawName);
    p += 46 + nlen + xlen + clen;

    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    const path = cleanPath(name);
    if (!path) throw new Error(`Unsafe path in archive: ${name}`);
    if (flags & 1) throw new Error(`Encrypted entries are not supported (${path})`);
    if (usize > ZIP_LIMITS.file) throw new Error(`${path} is too large (${Math.round(usize / 1048576)} MB unpacked)`);
    total += usize;
    if (total > ZIP_LIMITS.total) throw new Error(`Archive unpacks to more than ${ZIP_LIMITS.total / 1048576} MB`);

    if (local + 30 > b.length || u32(b, local) !== 0x04034b50) throw new Error(`Damaged ZIP entry: ${path}`);
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const data = b.subarray(start, start + csize);
    if (data.length !== csize) throw new Error(`Truncated ZIP entry: ${path}`);
    if (method === 0) {
      if (csize !== usize) throw new Error(`Damaged stored entry: ${path}`);
      out.set(path, data.slice());
    } else if (method === 8) {
      try { out.set(path, await inflateRaw(data, usize)); } catch (e) { throw new Error(`Could not unpack ${path}: ${e instanceof Error ? e.message : e}`); }
    } else {
      throw new Error(`${path} uses an unsupported compression method (${method}); use deflate or store`);
    }
  }
  return out;
}

let crcTable: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return new Uint8Array(buf);
}

/** Packs path → bytes into a ZIP (deflated when that is smaller, UTF-8 names). */
export async function writeZip(files: Map<string, Uint8Array> | [string, Uint8Array][]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const entries = files instanceof Map ? [...files] : files;
  for (const [path, data] of entries) {
    const name = enc.encode(path);
    const packed = await deflateRaw(data);
    const deflate = packed.length < data.length;
    const body = deflate ? packed : data;
    const crc = crc32(data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(8, deflate ? 8 : 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); // 1980-01-01
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    head.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(10, deflate ? 8 : 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    cd.set(name, 46);
    chunks.push(head, body);
    central.push(cd);
    offset += head.length + body.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}
