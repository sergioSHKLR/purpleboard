// DEADBOARD mods: data-only packages of boards (+ BOMs and schematics) that anyone can make.
//
// A mod is a folder or .zip with a `mod.json` manifest at its root (or in one top-level folder).
// Mods never contain code: boards go through the same importers and normalizers as a dropped
// file, schematics are shown as PDF / image, so a mod from a stranger can't run anything.
// Format reference: docs/MODDING.md (also on the website: modding.html).
import type { Objective, Scenario } from '../types';
import { importScenarioOrPcb } from '../io/kicad';
import { applyBom, parseBomCsv } from '../io/bom';
import { cleanPath, isZip, readZip } from './zip';

export const MOD_FORMAT = 'deadboard-mod/1';

export interface ModBoardSpec {
  /** Unique within the mod; default: the file name without extension. */
  id: string;
  /** Board file: .pcbfix.json (challenge exported from the Author tab), .kicad_pcb or .brd. */
  file: string;
  title?: string;
  description?: string;
  difficulty?: number;
  hints?: string[];
  /** BOM as CSV / TSV: sets resistor + capacitor values and DNP parts on .kicad_pcb / .brd boards. */
  bom?: string;
  /** Schematic shown next to the board: .pdf, .png, .jpg, .webp or .svg. */
  schematic?: string;
  /** Pass/fail tests for imported boards (same shape as in .pcbfix.json). */
  objectives?: Objective[];
  solver?: 'fast' | 'spice' | 'spice-power';
  /** Attribution of the board design (defaults: the mod's author / licence / homepage). */
  credits?: string;
  license?: string;
  source?: string;
}

export interface ModManifest {
  format: typeof MOD_FORMAT;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** SPDX id of the mod's content, e.g. CC-BY-4.0, CERN-OHL-S-2.0. */
  license: string;
  homepage?: string;
  boards: ModBoardSpec[];
}

/** Where a mod's files come from: a folder (the desktop mods folder) or an unpacked zip. */
export interface ModSource {
  /** Shown in the mod manager: "Mods folder", "Installed". */
  origin: string;
  /** Folder / file name, for messages. */
  name: string;
  /** Every file path in the package, relative to its root, "/"-separated. */
  files: string[];
  read(path: string): Promise<Uint8Array>;
}

export interface ModBoard {
  mod: ModManifest;
  spec: ModBoardSpec;
  /** Listing data; the board itself loads on first open. */
  stub: Scenario;
  load(): Promise<Scenario>;
  schematic?: { path: string; mime: string; read(): Promise<Uint8Array> };
}

export interface LoadedMod {
  manifest: ModManifest;
  source: ModSource;
  boards: ModBoard[];
  warnings: string[];
}

const SCHEMATIC_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
};
const BOARD_EXT = /\.(pcbfix\.json|json|kicad_pcb|brd)$/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

/** Validates mod.json. Throws one error listing every problem, so authors can fix them in one go. */
export function parseManifest(text: string): ModManifest {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`mod.json is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mod.json must be a JSON object');
  const errs: string[] = [];
  if (raw.format !== MOD_FORMAT) errs.push(`"format" must be "${MOD_FORMAT}"`);
  const id = str(raw.id, 64) ?? '';
  if (!ID_RE.test(id)) errs.push('"id" must be 2-64 characters: lowercase letters, digits, ".", "-" or "_" (e.g. "jane-audio-boards")');
  const name = str(raw.name, 80);
  if (!name) errs.push('"name" is required');
  const license = str(raw.license, 60);
  if (!license) errs.push('"license" is required (an SPDX id such as CC-BY-4.0, CERN-OHL-S-2.0, MIT)');
  const homepage = str(raw.homepage, 300);
  if (homepage && !/^https:\/\//.test(homepage)) errs.push('"homepage" must be an https:// URL');
  if (!Array.isArray(raw.boards) || raw.boards.length === 0) errs.push('"boards" must list at least one board');

  const boards: ModBoardSpec[] = [];
  const ids = new Set<string>();
  (Array.isArray(raw.boards) ? raw.boards : []).slice(0, 500).forEach((b: Record<string, unknown>, i: number) => {
    const at = `boards[${i}]`;
    if (!b || typeof b !== 'object') { errs.push(`${at} must be an object`); return; }
    const file = typeof b.file === 'string' ? cleanPath(b.file) : null;
    if (!file || !BOARD_EXT.test(file)) { errs.push(`${at}.file must be a .pcbfix.json, .kicad_pcb or .brd path inside the mod`); return; }
    const bid = str(b.id, 64) ?? file.split('/').pop()!.replace(BOARD_EXT, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!ID_RE.test(bid)) errs.push(`${at}.id "${bid}" must be 2-64 lowercase letters, digits, ".", "-" or "_"`);
    if (ids.has(bid)) errs.push(`${at}.id "${bid}" is used twice`);
    ids.add(bid);
    const spec: ModBoardSpec = { id: bid, file };
    const title = str(b.title, 120); if (title) spec.title = title;
    const desc = str(b.description, 4000); if (desc) spec.description = desc;
    if (b.difficulty !== undefined) {
      if (typeof b.difficulty !== 'number' || b.difficulty < 1 || b.difficulty > 5) errs.push(`${at}.difficulty must be a number from 1 to 5`);
      else spec.difficulty = Math.round(b.difficulty);
    }
    if (Array.isArray(b.hints)) spec.hints = b.hints.filter((h) => typeof h === 'string').map((h: string) => h.slice(0, 1000)).slice(0, 10);
    for (const key of ['bom', 'schematic'] as const) {
      if (b[key] === undefined) continue;
      const p = typeof b[key] === 'string' ? cleanPath(b[key] as string) : null;
      if (!p) { errs.push(`${at}.${key} must be a path inside the mod`); continue; }
      if (key === 'schematic' && !SCHEMATIC_TYPES[p.split('.').pop()!.toLowerCase()]) errs.push(`${at}.schematic must be .pdf, .png, .jpg, .webp or .svg`);
      spec[key] = p;
    }
    if (Array.isArray(b.objectives)) spec.objectives = (b.objectives as Objective[]).filter((o) => o && (o.type === 'led' || o.type === 'voltage'));
    if (b.solver === 'fast' || b.solver === 'spice' || b.solver === 'spice-power') spec.solver = b.solver;
    const credits = str(b.credits, 400); if (credits) spec.credits = credits;
    const bl = str(b.license, 60); if (bl) spec.license = bl;
    const src = str(b.source, 300);
    if (src) { if (/^https:\/\//.test(src)) spec.source = src; else errs.push(`${at}.source must be an https:// URL`); }
    boards.push(spec);
  });
  if (errs.length) throw new Error(`mod.json: ${errs.join('; ')}`);
  return {
    format: MOD_FORMAT, id, name: name!, license: license!,
    version: str(raw.version, 20) || '1.0.0',
    author: str(raw.author, 80) || 'anonymous',
    description: str(raw.description, 2000) ?? '',
    ...(homepage && { homepage }),
    boards,
  };
}

/** A zip's mod.json may sit in one top-level folder ("my-mod/mod.json"): strip that prefix. */
function rootOf(files: string[]): string | null {
  if (files.includes('mod.json')) return '';
  const nested = files.filter((f) => /^[^/]+\/mod\.json$/.test(f));
  return nested.length === 1 ? nested[0].slice(0, -'mod.json'.length) : null;
}

/** Unpacks a mod .zip into a source. */
export async function zipSource(bytes: Uint8Array, name: string, origin: string): Promise<ModSource> {
  if (!isZip(bytes)) throw new Error(`${name} is not a .zip file`);
  const all = await readZip(bytes);
  const root = rootOf([...all.keys()]);
  if (root === null) throw new Error(`${name} has no mod.json at its root`);
  const files = new Map([...all].filter(([k]) => k.startsWith(root)).map(([k, v]) => [k.slice(root.length), v]));
  return {
    origin, name, files: [...files.keys()],
    read: async (p) => { const f = files.get(p); if (!f) throw new Error(`missing file ${p}`); return f; },
  };
}

/** Reads and checks a mod: manifest, referenced files, and the first board of each listing. */
export async function loadMod(src: ModSource, takenIds: (id: string) => boolean = () => false): Promise<LoadedMod> {
  if (!src.files.includes('mod.json')) throw new Error(`${src.name}: no mod.json`);
  const manifest = parseManifest(new TextDecoder().decode(await src.read('mod.json')));
  const warnings: string[] = [];
  const boards: ModBoard[] = [];
  const have = new Set(src.files);
  const lower = new Map(src.files.map((f) => [f.toLowerCase(), f]));
  const missing = (p: string) => {
    if (have.has(p)) return false;
    const alt = lower.get(p.toLowerCase());
    warnings.push(alt ? `${p} not found (did you mean ${alt}? names are case-sensitive)` : `${p} not found`);
    return true;
  };

  for (const spec of manifest.boards) {
    if (missing(spec.file)) continue;
    if (spec.bom && missing(spec.bom)) delete spec.bom;
    if (spec.schematic && missing(spec.schematic)) delete spec.schematic;

    const build = async (): Promise<Scenario> => {
      const bytes = await src.read(spec.file);
      const sc = importScenarioOrPcb(spec.file.split('/').pop()!, bytes);
      const isChallenge = /\.json$/i.test(spec.file);
      // a .pcbfix.json keeps its own id: its flag lock is derived from it
      if (!isChallenge) sc.id = `mod-${manifest.id}-${spec.id}`;
      if (spec.bom) {
        const rep = applyBom(sc.board, parseBomCsv(new TextDecoder().decode(await src.read(spec.bom))));
        if (rep.matched === 0) throw new Error(`${spec.bom}: no designator matches a part on ${spec.file}`);
      }
      const m = sc.meta;
      if (spec.title) m.title = spec.title;
      if (spec.description) m.description = spec.description;
      if (spec.difficulty) m.difficulty = spec.difficulty;
      if (spec.hints) m.hints = spec.hints;
      if (!isChallenge || m.author === 'anonymous') m.author = manifest.author;
      m.credits = spec.credits ?? m.credits ?? `From the mod "${manifest.name}" v${manifest.version} by ${manifest.author}.`;
      m.license = spec.license ?? m.license ?? manifest.license;
      m.source = spec.source ?? m.source ?? manifest.homepage;
      if (spec.objectives?.length) sc.objectives = spec.objectives;
      if (spec.solver) sc.solver = spec.solver;
      return sc;
    };

    // an imported board with a title in mod.json is listed without parsing it (large boards load
    // on first open); a .pcbfix.json is read now, because its own id (flag lock, progress) is inside
    let first: Scenario | null = null;
    if (!spec.title || /\.json$/i.test(spec.file)) {
      try { first = await build(); } catch (e) { warnings.push(`${spec.file}: ${e instanceof Error ? e.message : e}`); continue; }
    }
    const id = first?.id ?? `mod-${manifest.id}-${spec.id}`;
    if (takenIds(id)) { warnings.push(`${spec.file}: a board with id "${id}" is already loaded (skipped)`); continue; }
    const stub: Scenario = first ?? {
      format: 'pcbfix/1', id, objectives: [], ...(spec.solver && { solver: spec.solver }),
      meta: {
        title: spec.title!, author: manifest.author, difficulty: spec.difficulty ?? 2, description: spec.description ?? '', hints: [],
        license: spec.license ?? manifest.license, credits: spec.credits, source: spec.source ?? manifest.homepage,
      },
      board: { w: 10, h: 10, thickness: 1.6, components: [], traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 },
    };
    let cached = first;
    boards.push({
      mod: manifest, spec, stub,
      load: async () => cached ?? (cached = await build()),
      ...(spec.schematic && {
        schematic: { path: spec.schematic, mime: SCHEMATIC_TYPES[spec.schematic.split('.').pop()!.toLowerCase()], read: () => src.read(spec.schematic!) },
      }),
    });
  }
  if (!boards.length) throw new Error(`${manifest.name}: none of its boards could be loaded${warnings.length ? ` (${warnings.join('; ')})` : ''}`);
  return { manifest, source: src, boards, warnings };
}
