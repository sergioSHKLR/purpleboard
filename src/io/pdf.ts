// Minimal PDF reader for vector schematics: object/xref-free object scan (incl. object
// streams), FlateDecode with PNG predictors, page tree, and a content-stream interpreter
// that emits positioned text runs and straight line segments in page coordinates.
// Inflate is injected so the same code runs in Node (zlib) and in tests.

export type Inflate = (data: Uint8Array) => Uint8Array;

export type PdfValue =
  | number | boolean | null | string
  | { name: string }
  | { ref: [number, number] }
  | PdfValue[]
  | PdfDict
  | PdfStream;
export interface PdfDict { dict: Map<string, PdfValue> }
export interface PdfStream { dict: Map<string, PdfValue>; data: Uint8Array }

export interface TextRun {
  page: number;
  text: string;
  x: number;
  y: number;
  /** Unit direction of the text baseline. */
  dir: [number, number];
  /** Effective glyph height in page units. */
  size: number;
}

export interface Segment { page: number; a: [number, number]; b: [number, number]; w: number }

export interface PdfPage { index: number; width: number; height: number; text: TextRun[]; segments: Segment[] }

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

const isDict = (v: PdfValue | undefined): v is PdfDict => !!v && typeof v === 'object' && 'dict' in v && !('data' in v);
const isStream = (v: PdfValue | undefined): v is PdfStream => !!v && typeof v === 'object' && 'data' in v;
const isRef = (v: PdfValue | undefined): v is { ref: [number, number] } => !!v && typeof v === 'object' && 'ref' in v;
const isName = (v: PdfValue | undefined): v is { name: string } => !!v && typeof v === 'object' && 'name' in v;

/** Tokenising object parser over a byte buffer. */
class Lexer {
  pos = 0;
  constructor(readonly b: Uint8Array, start = 0) { this.pos = start; }

  skipWs() {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWs(c)) this.pos++;
      else if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++; }
      else break;
    }
  }

  word(): string {
    const s = this.pos;
    while (this.pos < this.b.length && !isWs(this.b[this.pos]) && !isDelim(this.b[this.pos])) this.pos++;
    return latin1(this.b, s, this.pos);
  }

  literalString(): string {
    // at '('
    this.pos++;
    let depth = 1;
    let out = '';
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === 0x6e) out += '\n';
        else if (n === 0x72) out += '\r';
        else if (n === 0x74) out += '\t';
        else if (n === 0x62) out += '\b';
        else if (n === 0x66) out += '\f';
        else if (n === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; }
        else if (n === 0x0a) { /* line continuation */ }
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
          out += String.fromCharCode(v & 0xff);
        } else out += String.fromCharCode(n);
      } else if (c === 0x28) { depth++; out += '('; }
      else if (c === 0x29) { if (--depth === 0) break; out += ')'; }
      else out += String.fromCharCode(c);
    }
    return out;
  }

  hexString(): string {
    this.pos++; // '<'
    let hex = '';
    while (this.pos < this.b.length && this.b[this.pos] !== 0x3e) {
      const c = this.b[this.pos++];
      if (!isWs(c)) hex += String.fromCharCode(c);
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  /** Parses one value. Returns undefined at an operator keyword (left in `lastWord`). */
  value(): PdfValue | undefined {
    this.skipWs();
    const b = this.b;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos];
    if (c === 0x2f) { this.pos++; return { name: this.word() }; }
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const dict = new Map<string, PdfValue>();
        for (;;) {
          this.skipWs();
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
          if (this.pos >= b.length) break;
          const k = this.value();
          if (!isName(k)) break;
          const v = this.value();
          if (v !== undefined) dict.set(k.name, v);
        }
        return { dict };
      }
      return this.hexString();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (b[this.pos] === 0x5d) { this.pos++; break; }
        if (this.pos >= b.length) break;
        const v = this.value();
        if (v === undefined) { this.word(); continue; }
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) { this.pos++; return undefined; }
    const save = this.pos;
    const w = this.word();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = parseFloat(w);
      // indirect reference "n g R"
      if (/^\d+$/.test(w)) {
        const p2 = this.pos;
        this.skipWs();
        const g = this.word();
        if (/^\d+$/.test(g)) {
          this.skipWs();
          const r = this.word();
          if (r === 'R') return { ref: [n, parseInt(g, 10)] };
        }
        this.pos = p2;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    this.pos = save;
    return undefined;
  }
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}

function indexOf(b: Uint8Array, pat: string, from: number): number {
  const p0 = pat.charCodeAt(0);
  outer: for (let i = from; i <= b.length - pat.length; i++) {
    if (b[i] !== p0) continue;
    for (let k = 1; k < pat.length; k++) if (b[i + k] !== pat.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

function unpredict(data: Uint8Array, parms: Map<string, PdfValue> | undefined): Uint8Array {
  const pred = (parms?.get('Predictor') as number) ?? 1;
  if (pred < 10) return data;
  const colors = (parms?.get('Colors') as number) ?? 1;
  const bpc = (parms?.get('BitsPerComponent') as number) ?? 8;
  const cols = (parms?.get('Columns') as number) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((cols * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 0xff;
    }
    prev.set(cur);
  }
  return out;
}

export class PdfDocument {
  private readonly objects = new Map<number, PdfValue>();
  private readonly rawStreams = new Map<number, { dict: Map<string, PdfValue>; start: number; end: number }>();

  constructor(readonly bytes: Uint8Array, readonly inflate: Inflate) {
    this.scanObjects();
    this.expandObjectStreams();
  }

  private scanObjects() {
    const b = this.bytes;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const text = latin1(b, 0, b.length);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const num = parseInt(m[1], 10);
      const lx = new Lexer(b, m.index + m[0].length);
      const v = lx.value();
      if (v === undefined) continue;
      lx.skipWs();
      if (isDict(v) && text.startsWith('stream', lx.pos)) {
        let s = lx.pos + 6;
        if (b[s] === 0x0d) s++;
        if (b[s] === 0x0a) s++;
        let len = v.dict.get('Length');
        let end = -1;
        if (typeof len === 'number' && s + len <= b.length && latin1(b, s + len, Math.min(b.length, s + len + 12)).includes('endstream')) end = s + len;
        else {
          len = undefined;
          end = indexOf(b, 'endstream', s);
          while (end > s && (b[end - 1] === 0x0a || b[end - 1] === 0x0d)) end--;
        }
        this.rawStreams.set(num, { dict: v.dict, start: s, end });
        re.lastIndex = Math.max(re.lastIndex, end);
      } else {
        this.objects.set(num, v);
      }
    }
  }

  private expandObjectStreams() {
    for (const [num, rs] of this.rawStreams) {
      const type = rs.dict.get('Type');
      if (!isName(type) || type.name !== 'ObjStm') continue;
      const data = this.decode(num);
      const n = rs.dict.get('N') as number, first = rs.dict.get('First') as number;
      const lx = new Lexer(data);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) pairs.push([lx.value() as number, lx.value() as number]);
      for (const [onum, off] of pairs) {
        if (this.objects.has(onum) || this.rawStreams.has(onum)) continue;
        const v = new Lexer(data, first + off).value();
        if (v !== undefined) this.objects.set(onum, v);
      }
    }
  }

  /** Decoded stream bytes of object `num`. */
  decode(num: number): Uint8Array {
    const rs = this.rawStreams.get(num);
    if (!rs) return new Uint8Array(0);
    let data = this.bytes.subarray(rs.start, rs.end);
    const f = rs.dict.get('Filter');
    const filters = Array.isArray(f) ? f : f ? [f] : [];
    const p = rs.dict.get('DecodeParms');
    const parms = Array.isArray(p) ? p : [p];
    filters.forEach((flt, i) => {
      if (!isName(flt)) return;
      if (flt.name === 'FlateDecode') {
        data = this.inflate(data);
        const pr = parms[i] ?? parms[0];
        data = unpredict(data, isDict(pr) ? pr.dict : undefined);
      } else throw new Error(`Unsupported PDF filter ${flt.name}`);
    });
    return data;
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    for (let k = 0; k < 32 && isRef(v); k++) {
      const n = v.ref[0];
      if (this.rawStreams.has(n)) return { dict: this.rawStreams.get(n)!.dict, data: this.decode(n) };
      v = this.objects.get(n);
    }
    return v;
  }

  private get(d: PdfDict | PdfStream | undefined, key: string): PdfValue | undefined {
    return d ? this.resolve(d.dict.get(key)) : undefined;
  }

  pages(): PdfPage[] {
    const root = [...this.objects.values()].find((v) => isDict(v) && isName(v.dict.get('Type')) && (v.dict.get('Type') as { name: string }).name === 'Catalog') as PdfDict | undefined;
    if (!root) throw new Error('PDF has no catalog');
    const out: PdfPage[] = [];
    const walk = (node: PdfValue | undefined, inherited: { box?: number[] }) => {
      const n = this.resolve(node);
      if (!isDict(n)) return;
      const type = n.dict.get('Type') as { name: string } | undefined;
      const box = (this.get(n, 'MediaBox') as number[] | undefined) ?? inherited.box;
      if (type?.name === 'Pages') {
        for (const kid of (this.get(n, 'Kids') as PdfValue[]) ?? []) walk(kid, { box });
        return;
      }
      const contents = this.get(n, 'Contents');
      const parts = Array.isArray(contents) ? contents.map((c) => this.resolve(c)) : [contents];
      const chunks = parts.filter(isStream).map((s) => s.data);
      const total = chunks.reduce((s, c) => s + c.length + 1, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.length; buf[o++] = 0x0a; }
      const idx = out.length + 1;
      const [x0, y0, x1, y1] = box ?? [0, 0, 612, 792];
      const page: PdfPage = { index: idx, width: x1 - x0, height: y1 - y0, text: [], segments: [] };
      interpret(buf, page);
      out.push(page);
    };
    walk(root.dict.get('Pages'), {});
    return out;
  }
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Content-stream interpreter: text-showing and path operators only. */
function interpret(buf: Uint8Array, page: PdfPage) {
  const lx = new Lexer(buf);
  const stack: { ctm: M; lw: number }[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  let tm: M = [1, 0, 0, 1, 0, 0], tlm: M = [1, 0, 0, 1, 0, 0];
  let fontSize = 1, leading = 0, hscale = 1;
  const ops: PdfValue[] = [];
  let pathStart: [number, number] | null = null, cur: [number, number] | null = null;
  let pending: [[number, number], [number, number]][] = [];

  const show = (s: string) => {
    if (!s) return;
    const trm = mul([fontSize * hscale, 0, 0, fontSize, 0, 0], mul(tm, ctm));
    const [x, y] = apply(trm, 0, 0);
    const vx = trm[0], vy = trm[1];
    const vl = Math.hypot(vx, vy) || 1;
    page.text.push({ page: page.index, text: s, x, y, dir: [vx / vl, vy / vl], size: Math.hypot(trm[2], trm[3]) });
    // advance roughly (monospace-ish 0.6 em) so consecutive Tj on one line don't stack
    tm = mul([1, 0, 0, 1, s.length * 0.6 * fontSize * hscale, 0], tm);
  };
  const moveText = (tx: number, ty: number) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };

  for (;;) {
    lx.skipWs();
    if (lx.pos >= buf.length) break;
    const v = lx.value();
    if (v !== undefined) { ops.push(v); continue; }
    const c = buf[lx.pos];
    if (isDelim(c)) { lx.pos++; continue; }
    const op = lx.word();
    if (!op) { lx.pos++; continue; }
    const n = (i: number) => (typeof ops[i] === 'number' ? (ops[i] as number) : 0);
    switch (op) {
      case 'q': stack.push({ ctm, lw }); break;
      case 'Q': { const s = stack.pop(); if (s) { ctm = s.ctm; lw = s.lw; } break; }
      case 'cm': ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm); break;
      case 'w': lw = n(0); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': fontSize = n(1); break;
      case 'Tz': hscale = n(0) / 100; break;
      case 'TL': leading = n(0); break;
      case 'Tm': tm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tlm = tm; break;
      case 'Td': moveText(n(0), n(1)); break;
      case 'TD': leading = -n(1); moveText(n(0), n(1)); break;
      case 'T*': moveText(0, -leading); break;
      case 'Tj': if (typeof ops[0] === 'string') show(ops[0]); break;
      case "'": moveText(0, -leading); if (typeof ops[0] === 'string') show(ops[0]); break;
      case '"': moveText(0, -leading); if (typeof ops[2] === 'string') show(ops[2]); break;
      case 'TJ': {
        const arr = Array.isArray(ops[0]) ? ops[0] : [];
        let s = '';
        for (const it of arr) {
          if (typeof it === 'string') s += it;
          else if (typeof it === 'number' && it < -250) s += ' ';
        }
        show(s);
        break;
      }
      case 'm': cur = pathStart = apply(ctm, n(0), n(1)); break;
      case 'l': { const p = apply(ctm, n(0), n(1)); if (cur) pending.push([cur, p]); cur = p; break; }
      case 'h': if (cur && pathStart) pending.push([cur, pathStart]); cur = pathStart; break;
      case 're': {
        const x = n(0), y = n(1), w = n(2), h = n(3);
        const p = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
        for (let k = 0; k < 4; k++) pending.push([p[k], p[(k + 1) % 4]]);
        break;
      }
      case 'S': case 's': case 'B': case 'b': case 'B*': case 'b*': {
        const width = lw * Math.hypot(ctm[0], ctm[1]);
        for (const [a, b] of pending) page.segments.push({ page: page.index, a, b, w: width });
        pending = []; cur = pathStart = null;
        break;
      }
      case 'f': case 'F': case 'f*': case 'n': pending = []; cur = pathStart = null; break;
      case 'c': case 'v': case 'y': { const k = op === 'c' ? 4 : 2; cur = apply(ctm, n(k), n(k + 1)); break; }
      case 'ET': break;
      default: break;
    }
    ops.length = 0;
  }
}
