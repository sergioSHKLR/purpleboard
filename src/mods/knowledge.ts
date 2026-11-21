// Knowledge packs: what a repair technician knows about a board that the board file doesn't say:
// its rails, where they come from, in what order they come up, what to expect where. Data only,
// shown next to the board (Overview tab). Every entry says how sure it is (`confidence`):
//   documented: read from a schematic or datasheet · derived: worked out from the board ·
//   estimated: an educated guess.
// A pack names its board by item address. Parts and nets the board doesn't have are kept and shown
// as "not on this board" (a pack made for another revision), never silently dropped.
import type { Board } from '../types';
import { tk } from '../i18n';
import { parseAddress } from './address';

export type Confidence = 'documented' | 'derived' | 'estimated';
export const CONFIDENCE: readonly Confidence[] = ['documented', 'derived', 'estimated'];
/** For the translation extractor: shown with t(confidence). */
export const CONFIDENCE_LABELS = [tk('documented'), tk('derived'), tk('estimated')];

export interface Provenance { confidence: Confidence; kind?: string; where?: string }
export interface RailCheck { at: string; pin?: string; expect: string; readsLowIf?: string }
export interface Rail {
  net: string;
  nominal?: number;
  domain?: string;
  source?: { ref: string; kind?: string };
  checks: RailCheck[];
  notes?: string;
  provenance: Provenance;
}
export interface KnowledgePack {
  id: string;
  /** Item address of the board, e.g. "official-boards/boards/builtin-ghost-short". */
  board: string;
  title?: string;
  rails: Rail[];
  /** Rail nets in the order they come up. */
  powerUp: string[];
  notes: string[];
  provenance: Provenance;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined);

function unknownKeys(o: Raw, known: string[], at: string, warnings: string[]) {
  for (const k of Object.keys(o)) if (!known.includes(k)) warnings.push(`${at}: unknown field "${k}" (ignored)`);
}

function provenance(x: unknown, at: string, errs: string[], fallback: Provenance): Provenance {
  if (x === undefined) return fallback;
  if (!isObj(x)) { errs.push(`${at}.provenance must be an object`); return fallback; }
  const c = x.confidence ?? fallback.confidence;
  if (!CONFIDENCE.includes(c as Confidence)) errs.push(`${at}.provenance.confidence must be "documented", "derived" or "estimated"`);
  return { confidence: CONFIDENCE.includes(c as Confidence) ? c as Confidence : fallback.confidence, ...(text(x.kind, 40) && { kind: text(x.kind, 40) }), ...(text(x.where, 200) && { where: text(x.where, 200) }) };
}

/** Reads one entry of a mod's `knowledge` list; problems go to errs / warnings. */
export function parseKnowledge(raw: unknown, at: string, errs: string[], warnings: string[]): KnowledgePack | null {
  if (!isObj(raw)) { errs.push(`${at} must be an object`); return null; }
  unknownKeys(raw, ['id', 'board', 'title', 'rails', 'powerUp', 'notes', 'provenance'], at, warnings);
  const id = text(raw.id, 64) ?? '';
  if (!ID_RE.test(id)) errs.push(`${at}.id must be 2-64 lowercase letters, digits, ".", "-" or "_"`);
  const board = text(raw.board, 200) ?? '';
  const addr = parseAddress(board);
  if (!addr || addr.type !== 'boards') errs.push(`${at}.board must be a board address like "official-boards/boards/builtin-first-light"`);
  const packProv = provenance(raw.provenance, at, errs, { confidence: 'estimated' });

  const rails: Rail[] = [];
  if (raw.rails !== undefined && !Array.isArray(raw.rails)) errs.push(`${at}.rails must be a list`);
  (Array.isArray(raw.rails) ? raw.rails : []).slice(0, 200).forEach((r: unknown, i: number) => {
    const ra = `${at}.rails[${i}]`;
    if (!isObj(r)) { errs.push(`${ra} must be an object`); return; }
    unknownKeys(r, ['net', 'nominal', 'domain', 'source', 'checks', 'notes', 'provenance'], ra, warnings);
    const net = text(r.net, 80);
    if (!net) { errs.push(`${ra}.net is required (the rail's net name)`); return; }
    if (r.nominal !== undefined && (typeof r.nominal !== 'number' || !Number.isFinite(r.nominal))) errs.push(`${ra}.nominal must be a number of volts`);
    let source: Rail['source'];
    if (r.source !== undefined) {
      const ref = isObj(r.source) ? text(r.source.ref, 40) : undefined;
      if (!ref) errs.push(`${ra}.source needs "ref" (the part that makes the rail)`);
      else source = { ref, ...(isObj(r.source) && text(r.source.kind, 40) && { kind: text(r.source.kind, 40) }) };
    }
    const checks: RailCheck[] = [];
    if (r.checks !== undefined && !Array.isArray(r.checks)) errs.push(`${ra}.checks must be a list`);
    (Array.isArray(r.checks) ? r.checks : []).slice(0, 50).forEach((c: unknown, j: number) => {
      const ca = `${ra}.checks[${j}]`;
      const atRef = isObj(c) ? text(c.at, 40) : undefined;
      const expect = isObj(c) ? text(c.expect, 80) : undefined;
      if (!atRef || !expect) { errs.push(`${ca} needs "at" (a part ref) and "expect" (e.g. "3.2–3.4 V")`); return; }
      const cc = c as Raw;
      checks.push({ at: atRef, expect, ...(text(cc.pin, 20) && { pin: text(cc.pin, 20) }), ...(text(cc.readsLowIf, 300) && { readsLowIf: text(cc.readsLowIf, 300) }) });
    });
    rails.push({
      net, checks,
      ...(typeof r.nominal === 'number' && Number.isFinite(r.nominal) && { nominal: r.nominal }),
      ...(text(r.domain, 40) && { domain: text(r.domain, 40) }),
      ...(source && { source }),
      ...(text(r.notes, 1000) && { notes: text(r.notes, 1000) }),
      provenance: provenance(r.provenance, ra, errs, packProv),
    });
  });

  const powerUp = Array.isArray(raw.powerUp) ? raw.powerUp.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim().slice(0, 80)).slice(0, 50) : [];
  if (raw.powerUp !== undefined && !Array.isArray(raw.powerUp)) errs.push(`${at}.powerUp must be a list of rail nets`);
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim().slice(0, 1000)).slice(0, 20) : [];
  if (!rails.length && !powerUp.length && !notes.length) warnings.push(`${at}: empty pack (no rails, powerUp or notes)`);
  return { id, board, rails, powerUp, notes, provenance: packProv, ...(text(raw.title, 120) && { title: text(raw.title, 120) }) };
}

/**
 * Net names a board has: on pads, traces, vias or zones, wherever its file keeps them (an imported
 * design names pads; a board drawn in DEADBOARD names its copper). The names connectivity uses.
 */
export function boardNetNames(board: Board): Set<string> {
  const out = new Set<string>();
  const add = (n: string | undefined) => { if (n) out.add(n); };
  for (const c of board.components) for (const p of c.pads) add(p.net);
  for (const t of board.traces) add(t.net);
  for (const v of board.vias) add(v.net);
  for (const z of board.zones ?? []) add(z.net);
  return out;
}

/** Part refs and net names the pack mentions that this board doesn't have. */
export function staleEntries(pack: KnowledgePack, board: Board): { refs: string[]; nets: string[] } {
  const refs = new Set(board.components.map((c) => c.ref));
  const nets = boardNetNames(board);
  const badRefs = new Set<string>(), badNets = new Set<string>();
  for (const r of pack.rails) {
    if (!nets.has(r.net)) badNets.add(r.net);
    if (r.source && !refs.has(r.source.ref)) badRefs.add(r.source.ref);
    for (const c of r.checks) if (!refs.has(c.at)) badRefs.add(c.at);
  }
  for (const n of pack.powerUp) if (!nets.has(n)) badNets.add(n);
  return { refs: [...badRefs], nets: [...badNets] };
}
