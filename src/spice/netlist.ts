// SPICE deck reader/writer (SPICE3 / ngspice dialect subset).
import type { Analysis, Circuit, Element, Model, ModelType, Subckt, Waveform } from './types';
import { emptyCircuit } from './types';
import { formatSpiceNumber as fmt, parseSpiceNumber } from './units';

// ---------------- writer ----------------

function waveText(w: Waveform): string {
  switch (w.type) {
    case 'dc': return `DC ${fmt(w.v)}`;
    case 'pulse': return `PULSE(${[w.v1, w.v2, w.td, w.tr, w.tf, w.pw, w.per].map(fmt).join(' ')})`;
    case 'sin': return `SIN(${[w.vo, w.va, w.freq, w.td, w.theta].map(fmt).join(' ')})`;
    case 'pwl': return `PWL(${w.pts.map(([t, v]) => `${fmt(t)} ${fmt(v)}`).join(' ')})`;
  }
}

export function elementCard(e: Element): string {
  const nodes = e.n.join(' ');
  let s: string;
  switch (e.kind) {
    case 'R': s = `${e.name} ${nodes} ${fmt(e.value)}`; break;
    case 'C': case 'L': s = `${e.name} ${nodes} ${fmt(e.value)}${e.ic !== undefined ? ` IC=${fmt(e.ic)}` : ''}`; break;
    case 'V': case 'I': s = `${e.name} ${nodes} ${waveText(e.wave)}`; break;
    case 'D': s = `${e.name} ${nodes} ${e.model}${e.area !== undefined ? ' ' + fmt(e.area) : ''}`; break;
    case 'M': s = `${e.name} ${nodes} ${e.model}${e.w !== undefined ? ` W=${fmt(e.w)}` : ''}${e.l !== undefined ? ` L=${fmt(e.l)}` : ''}`; break;
    case 'Q': s = `${e.name} ${nodes} ${e.model}${e.area !== undefined ? ' ' + fmt(e.area) : ''}`; break;
    case 'S': s = `${e.name} ${nodes} ${e.model}${e.on ? ' ON' : ' OFF'}`; break;
    case 'E': case 'G': s = `${e.name} ${nodes} ${fmt(e.gain)}`; break;
    case 'X': s = `${e.name} ${nodes} ${e.subckt}`; break;
    case 'B': s = `${e.name} ${nodes} ${e.mode}={${e.expr.replace(/\s+/g, ' ')}}`; break;
  }
  return (e.kind === 'B' ? s : wrap(s)) + (e.note ? ` ; ${e.note.replace(/[\r\n]+/g, ' ')}` : '');
}

function wrap(line: string, width = 110): string {
  if (line.length <= width) return line;
  const words = line.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) { out.push(cur); cur = '+ ' + w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out.join('\n');
}

function modelCard(m: Model): string {
  const ps = Object.entries(m.params).map(([k, v]) => `${k.toUpperCase()}=${fmt(v)}`).join(' ');
  return wrap(`.model ${m.name} ${m.type}(${ps})`);
}

function analysisCard(a: Analysis): string {
  switch (a.type) {
    case 'op': return '.op';
    case 'dc': return `.dc ${a.src} ${fmt(a.start)} ${fmt(a.stop)} ${fmt(a.step)}`;
    case 'tran': {
      let s = `.tran ${fmt(a.tstep)} ${fmt(a.tstop)}`;
      if (a.tstart !== undefined || a.tmax !== undefined) s += ` ${fmt(a.tstart ?? 0)}`;
      if (a.tmax !== undefined) s += ` ${fmt(a.tmax)}`;
      if (a.uic) s += ' UIC';
      return s;
    }
  }
}

export function writeSpice(c: Circuit): string {
  const L: string[] = [];
  L.push(`* ${c.title.replace(/[\r\n]+/g, ' ')}`);
  for (const line of c.comments ?? []) L.push(`* ${line}`);
  const opts = Object.entries(c.options);
  if (opts.length) L.push(`.option ${opts.map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`);
  if (c.models.length) { L.push('', '* ---- models ----'); for (const m of c.models) L.push(modelCard(m)); }
  for (const s of c.subckts) {
    L.push('');
    if (s.note) L.push(`* ${s.note}`);
    L.push(wrap(`.subckt ${s.name} ${s.ports.join(' ')}`));
    for (const m of s.models) L.push(modelCard(m));
    for (const e of s.elements) L.push(elementCard(e));
    L.push(`.ends ${s.name}`);
  }
  L.push('', '* ---- netlist ----');
  for (const e of c.elements) L.push(elementCard(e));
  L.push('');
  for (const a of c.analyses) L.push(analysisCard(a));
  L.push('.end', '');
  return L.join('\n');
}

// ---------------- reader ----------------

export class SpiceParseError extends Error {
  constructor(msg: string, readonly line: number) { super(`line ${line}: ${msg}`); }
}

interface Card { text: string; line: number }

function cards(text: string, hasTitle: boolean): { title: string; cards: Card[] } {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  let title = 'untitled';
  let start = 0;
  if (hasTitle && raw.length) { title = raw[0].replace(/^\*\s?/, '').trim() || 'untitled'; start = 1; }
  const out: Card[] = [];
  for (let i = start; i < raw.length; i++) {
    let s = raw[i];
    const semi = s.indexOf(';');
    if (semi >= 0) s = s.slice(0, semi);
    s = s.replace(/\s\$\s.*$/, '');
    s = s.trim();
    if (!s || s.startsWith('*')) continue;
    if (s.startsWith('+')) {
      if (out.length) out[out.length - 1].text += ' ' + s.slice(1).trim();
      continue;
    }
    out.push({ text: s, line: i + 1 });
  }
  return { title, cards: out };
}

function tokenize(s: string): string[] {
  return s
    .replace(/\s*=\s*/g, '=')
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const num = (t: string | undefined, line: number, what: string): number => {
  const v = t === undefined ? NaN : parseSpiceNumber(t);
  if (!isFinite(v)) throw new SpiceParseError(`expected number for ${what}, got "${t ?? ''}"`, line);
  return v;
};

function parseKV(tokens: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const v = parseSpiceNumber(t.slice(eq + 1));
    if (isFinite(v)) out[t.slice(0, eq).toLowerCase()] = v;
  }
  return out;
}

function parseWave(tok: string[], line: number): Waveform {
  // tok: tokens after the two nodes
  let i = 0;
  let dc = 0;
  let wave: Waveform | null = null;
  while (i < tok.length) {
    const t = tok[i].toLowerCase();
    if (t === 'dc') { dc = num(tok[i + 1], line, 'DC value'); i += 2; }
    else if (t === 'ac') { i += 2; while (i < tok.length && isFinite(parseSpiceNumber(tok[i]))) i++; }
    else if (t === 'pulse' || t === 'sin' || t === 'pwl') {
      const vals: number[] = [];
      i++;
      while (i < tok.length && isFinite(parseSpiceNumber(tok[i]))) vals.push(parseSpiceNumber(tok[i++]));
      if (t === 'pulse') {
        const [v1 = 0, v2 = 0, td = 0, tr = 0, tf = 0, pw = 0, per = 0] = vals;
        wave = { type: 'pulse', v1, v2, td, tr, tf, pw, per };
      } else if (t === 'sin') {
        const [vo = 0, va = 0, freq = 0, td = 0, theta = 0] = vals;
        wave = { type: 'sin', vo, va, freq, td, theta };
      } else {
        const pts: [number, number][] = [];
        for (let k = 0; k + 1 < vals.length; k += 2) pts.push([vals[k], vals[k + 1]]);
        wave = { type: 'pwl', pts };
      }
    } else if (isFinite(parseSpiceNumber(tok[i]))) { dc = parseSpiceNumber(tok[i]); i++; }
    else i++;
  }
  return wave ?? { type: 'dc', v: dc };
}

const MODEL_TYPES: Record<string, ModelType> = { d: 'D', nmos: 'NMOS', pmos: 'PMOS', npn: 'NPN', pnp: 'PNP', sw: 'SW' };

/** Parses a SPICE deck. The first line is the title unless `hasTitle` is false. */
export function parseSpice(text: string, hasTitle = true): Circuit & { warnings: string[] } {
  const { title, cards: list } = cards(text, hasTitle);
  const c = emptyCircuit(title);
  const warnings: string[] = [];
  const modelNames = new Set<string>();
  for (const cd of list) {
    const t = tokenize(cd.text);
    if (t[0]?.toLowerCase() === '.model' && t[1]) modelNames.add(t[1].toLowerCase());
  }

  let sub: Subckt | null = null;
  const els = () => (sub ? sub.elements : c.elements);
  const models = () => (sub ? sub.models : c.models);

  for (const { text: s, line } of list) {
    if (/^b/i.test(s)) {
      const m = /^(\S+)\s+(\S+)\s+(\S+)\s+([VI])\s*=\s*(.+)$/i.exec(s);
      if (!m) throw new SpiceParseError(`${s.split(/\s/)[0]}: expected "Bname n+ n- V={expr}" or I={expr}`, line);
      let expr = m[5].trim();
      if (expr.startsWith('{') && expr.endsWith('}')) expr = expr.slice(1, -1);
      els().push({ kind: 'B', name: m[1], n: [m[2], m[3]], mode: m[4].toUpperCase() as 'V' | 'I', expr: expr.trim() });
      continue;
    }
    const t = tokenize(s);
    const head = t[0];
    const lower = head.toLowerCase();
    if (lower.startsWith('.')) {
      switch (lower) {
        case '.model': {
          const type = MODEL_TYPES[(t[2] ?? '').toLowerCase()];
          if (!type) { warnings.push(`line ${line}: unsupported model type ${t[2]} (${t[1]})`); break; }
          models().push({ name: t[1], type, params: parseKV(t.slice(3)) });
          break;
        }
        case '.subckt':
          if (sub) throw new SpiceParseError('nested .subckt definitions are not supported', line);
          sub = { name: t[1], ports: t.slice(2).filter((x) => !x.includes('=')), elements: [], models: [] };
          break;
        case '.ends':
          if (!sub) throw new SpiceParseError('.ends without .subckt', line);
          c.subckts.push(sub);
          sub = null;
          break;
        case '.op': c.analyses.push({ type: 'op' }); break;
        case '.dc':
          c.analyses.push({ type: 'dc', src: t[1], start: num(t[2], line, 'start'), stop: num(t[3], line, 'stop'), step: num(t[4], line, 'step') });
          break;
        case '.tran': {
          const pos = t.slice(1).filter((x) => x.toLowerCase() !== 'uic');
          const a: Analysis = { type: 'tran', tstep: num(pos[0], line, 'tstep'), tstop: num(pos[1], line, 'tstop') };
          if (pos[2] !== undefined) a.tstart = num(pos[2], line, 'tstart');
          if (pos[3] !== undefined) a.tmax = num(pos[3], line, 'tmax');
          if (t.some((x) => x.toLowerCase() === 'uic')) a.uic = true;
          c.analyses.push(a);
          break;
        }
        case '.option': case '.options': case '.opt':
          Object.assign(c.options, parseKV(t.slice(1)));
          break;
        case '.end': break;
        case '.control': case '.endc': case '.print': case '.plot': case '.probe': case '.save': case '.title':
          break;
        default:
          warnings.push(`line ${line}: ignored ${head}`);
      }
      continue;
    }

    const name = head;
    const L = name[0].toUpperCase();
    const need = (k: number) => { if (t.length < k) throw new SpiceParseError(`${name}: too few fields`, line); };
    switch (L) {
      case 'R': case 'C': case 'L': {
        need(4);
        const value = num(t[3], line, `${name} value`);
        const kv = parseKV(t.slice(4));
        if (L === 'R') els().push({ kind: 'R', name, n: [t[1], t[2]], value });
        else els().push({ kind: L, name, n: [t[1], t[2]], value, ...(kv.ic !== undefined && { ic: kv.ic }) });
        break;
      }
      case 'V': case 'I':
        need(3);
        els().push({ kind: L, name, n: [t[1], t[2]], wave: parseWave(t.slice(3), line) });
        break;
      case 'D': {
        need(4);
        const area = t[4] && !t[4].includes('=') ? parseSpiceNumber(t[4]) : NaN;
        els().push({ kind: 'D', name, n: [t[1], t[2]], model: t[3], ...(isFinite(area) && { area }) });
        break;
      }
      case 'M': {
        need(6);
        const kv = parseKV(t.slice(6));
        els().push({ kind: 'M', name, n: [t[1], t[2], t[3], t[4]], model: t[5], ...(kv.w !== undefined && { w: kv.w }), ...(kv.l !== undefined && { l: kv.l }) });
        break;
      }
      case 'Q': {
        need(5);
        // Optional substrate node: Q c b e [s] model [area]
        const hasSub = t.length >= 6 && !modelNames.has(t[4].toLowerCase()) && modelNames.has(t[5].toLowerCase());
        const model = hasSub ? t[5] : t[4];
        const at = t[hasSub ? 6 : 5];
        const area = at && !at.includes('=') ? parseSpiceNumber(at) : NaN;
        els().push({ kind: 'Q', name, n: [t[1], t[2], t[3]], model, ...(isFinite(area) && { area }) });
        break;
      }
      case 'S':
        need(6);
        els().push({ kind: 'S', name, n: [t[1], t[2], t[3], t[4]], model: t[5], on: (t[6] ?? '').toLowerCase() === 'on' });
        break;
      case 'E': case 'G':
        need(6);
        els().push({ kind: L, name, n: [t[1], t[2], t[3], t[4]], gain: num(t[5], line, `${name} gain`) });
        break;
      case 'X': {
        const pos = t.slice(1).filter((x) => !x.includes('='));
        if (pos.length < 2) throw new SpiceParseError(`${name}: needs nodes and a subcircuit name`, line);
        els().push({ kind: 'X', name, n: pos.slice(0, -1), subckt: pos[pos.length - 1] });
        break;
      }
      default:
        warnings.push(`line ${line}: unsupported element ${name}`);
    }
  }
  if (sub) throw new SpiceParseError(`.subckt ${sub.name} has no .ends`, list[list.length - 1]?.line ?? 0);
  return Object.assign(c, { warnings });
}
