// DEADBOARD mods: data-only packages of boards (+ BOMs and schematics) that anyone can make.
//
// A mod is a folder or .zip with a `mod.json` manifest at its root (or in one top-level folder).
// Mods never contain code: boards go through the same importers and normalizers as a dropped
// file, schematics are shown as PDF / image, so a mod from a stranger can't run anything.
// Format reference: docs/MODDING.md (also on the website: modding.html); where this is going:
// docs/MOD_PLATFORM.md.
import type { Objective, Scenario } from '../types';
import { importScenarioOrPcb } from '../io/kicad';
import { applyBom, parseBomCsv } from '../io/bom';
import { cleanPath, isZip, readZip } from './zip';
import { parseVersion, satisfies, validRange } from './semver';
import { itemAddress, parseAddress } from './address';
import { BOARD_FIELDS, type PatchSpec } from './patches';
import { parseKnowledge, type KnowledgePack } from './knowledge';
import { parsePuzzle, type PuzzleSpec } from './puzzles';
import { isOfficialId } from './official';
import { solverOf } from './solvers';
import { DEVICE_FIELDS, deviceItemId, parseDevice } from './devices';
import { OFFICIAL_FAULTS_MOD, parseFaultType, type FaultTypeDef } from './faulttypes';
import { METER_FIELDS, parseMeter, type MeterDef } from './meters';
import { parseRule, type RuleDef } from './rules';
import type { DeviceDef } from '../spice/devicelib';
import { API_VERSION, LATER_PERMISSIONS, NETWORK_ORIGIN, PERMISSIONS, codeProblem } from './api/version';

export { itemAddress, parseAddress };

/** The format the app writes (exports stay /1 so older apps can still open them). */
export const MOD_FORMAT = 'deadboard-mod/1';
/** /2 adds dependencies (`requires`, `conflicts`), mods without boards, and strict semver versions. */
export const MOD_FORMAT_2 = 'deadboard-mod/2';
export type ModFormat = typeof MOD_FORMAT | typeof MOD_FORMAT_2;


/** /2 fields this app reads, and the ones planned for later versions (ignored with a note). */
const KNOWN_KEYS = new Set(['format', 'id', 'name', 'version', 'author', 'license', 'description', 'homepage', 'boards', 'requires', 'conflicts', 'patches', 'knowledge', 'puzzles', 'devices', 'code', 'faultTypes', 'meters', 'rules']);
const FUTURE_KEYS = new Set(['instruments', 'panels', 'languages']);

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
  /** A code mod's solver (address) the board is made for; `solver` is the fallback. */
  modSolver?: string;
  /** Attribution of the board design (defaults: the mod's author / licence / homepage). */
  credits?: string;
  license?: string;
  source?: string;
}

export interface ModManifest {
  format: ModFormat;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** SPDX id of the mod's content, e.g. CC-BY-4.0, CERN-OHL-S-2.0. */
  license: string;
  homepage?: string;
  boards: ModBoardSpec[];
  /** Other mods this one needs: mod id → version range ("^1.2"). */
  requires: Record<string, string>;
  /** Mods this one can't run next to: mod id → version range. */
  conflicts: Record<string, string>;
  /** Changes to other mods' items (board fields so far). */
  patches: PatchSpec[];
  /** Knowledge packs for boards (this mod's or a required mod's). */
  knowledge: KnowledgePack[];
  /** Repair challenges written as recipes on a working board. */
  puzzles: PuzzleSpec[];
  /** Semiconductor models this mod adds to the device library. */
  devices: DeviceDef[];
  /** A code mod: its module, the plug-in API range it was written for, and what it may use. */
  code?: ModCode;
  /** Fault types this mod adds (data, built from primitives). */
  faultTypes: FaultTypeDef[];
  /** Multimeter profiles this mod adds. */
  meters: MeterDef[];
  /** Diagnostic rules this mod adds (the fault-candidate engine, src/mods/rules.ts). */
  rules: RuleDef[];
}

export interface ModCode { entry: string; api: string; permissions: string[] }

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
  /** `<mod-id>/boards/<board-id>`, or `<mod-id>/puzzles/<puzzle-id>` for a puzzle */
  address: string;
  /** A puzzle: the address of the board it is built on. */
  basedOn?: string;
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

/** Validates mod.json. Throws one error listing every problem, so authors can fix them in one go.
 *  Problems that don't stop the mod (fields for a newer app) go to `warnings`. */
export function parseManifest(text: string, warnings: string[] = []): ModManifest {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`mod.json is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mod.json must be a JSON object');
  const errs: string[] = [];
  const v2 = raw.format === MOD_FORMAT_2;
  if (raw.format !== MOD_FORMAT && !v2) errs.push(`"format" must be "${MOD_FORMAT}" or "${MOD_FORMAT_2}"`);
  const id = str(raw.id, 64) ?? '';
  if (!ID_RE.test(id)) errs.push('"id" must be 2-64 characters: lowercase letters, digits, ".", "-" or "_" (e.g. "jane-audio-boards")');
  else if (isOfficialId(id)) errs.push('"id": names starting with "official-" are reserved for the mods that ship with PurpleBoard');
  const name = str(raw.name, 80);
  if (!name) errs.push('"name" is required');
  const license = str(raw.license, 60);
  if (!license) errs.push('"license" is required (an SPDX id such as CC-BY-4.0, CERN-OHL-S-2.0, MIT)');
  const homepage = str(raw.homepage, 300);
  if (homepage && !/^https:\/\//.test(homepage)) errs.push('"homepage" must be an https:// URL');
  const version = str(raw.version, 20) || '1.0.0';
  if (v2 && !parseVersion(version)) errs.push(`"version" must look like 1.2.0 (MAJOR.MINOR.PATCH), not "${version}"`);

  const deps = (key: 'requires' | 'conflicts'): Record<string, string> => {
    const out: Record<string, string> = {};
    const val = raw[key];
    if (val === undefined) return out;
    if (!v2) { warnings.push(`"${key}" needs "format": "${MOD_FORMAT_2}" (ignored)`); return out; }
    if (!val || typeof val !== 'object' || Array.isArray(val)) { errs.push(`"${key}" must be an object like { "other-mod": "^1.0" }`); return out; }
    for (const [dep, range] of Object.entries(val as Record<string, unknown>).slice(0, 100)) {
      if (!ID_RE.test(dep)) { errs.push(`"${key}": "${dep}" is not a mod id`); continue; }
      if (dep === id) { errs.push(`"${key}": a mod can't list itself`); continue; }
      if (typeof range !== 'string' || !validRange(range)) { errs.push(`"${key}"."${dep}" must be a version range such as "^1.0", "~1.2.3", ">=1.0" or "*"`); continue; }
      out[dep] = range.trim();
    }
    return out;
  };
  const requires = deps('requires');
  const conflicts = deps('conflicts');
  for (const dep of Object.keys(conflicts)) if (requires[dep]) errs.push(`"${dep}" is both required and a conflict`);

  // /2 items that point at other mods' items: patches, knowledge packs, puzzles
  const reach = (addr: string, at: string): boolean => {
    const a = parseAddress(addr);
    if (!a || a.mod === id || requires[a.mod]) return true;
    errs.push(`${at}: "${a.mod}" must be listed in "requires" to use its items (e.g. "requires": { "${a.mod}": "^1.0" })`);
    return false;
  };
  const list = (key: string): unknown[] => {
    const val = raw[key];
    if (val === undefined || !v2) return [];
    if (!Array.isArray(val)) { errs.push(`"${key}" must be a list`); return []; }
    if (val.length > 500) warnings.push(`"${key}": only the first 500 entries are used`);
    return val.slice(0, 500);
  };
  if (!v2) for (const key of ['patches', 'knowledge', 'puzzles', 'devices', 'code', 'faultTypes', 'meters', 'rules']) if (raw[key] !== undefined) warnings.push(`"${key}" needs "format": "${MOD_FORMAT_2}" (ignored)`);
  const patches: PatchSpec[] = [];
  list('patches').forEach((p: unknown, i: number) => {
    const at = `patches[${i}]`;
    const r = p as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`${at} must be an object`); return; }
    const target = typeof r.target === 'string' ? r.target.trim() : '';
    const a = parseAddress(target);
    if (!a) { errs.push(`${at}.target must be an item address like "official-boards/boards/builtin-first-light"`); return; }
    if (a.mod === id) { errs.push(`${at}: a mod doesn't patch its own items (change them directly)`); return; }
    if (!reach(target, at)) return;
    const fields: readonly string[] | null = a.type === 'boards' ? BOARD_FIELDS : a.type === 'devices' ? DEVICE_FIELDS
      : a.type === 'faultTypes' ? (a.mod === OFFICIAL_FAULTS_MOD ? ['range'] : ['name', 'description', 'applies', 'effects'])
        : a.type === 'meters' ? METER_FIELDS
          : a.type === 'rules' ? ['when', 'suspect', 'weight', 'confirm', 'why'] : null;
    if (!fields) { warnings.push(`${at}: patching "${a.type}" needs a newer version of PurpleBoard (ignored)`); return; }
    if (!r.set || typeof r.set !== 'object' || Array.isArray(r.set)) { errs.push(`${at}.set must be an object of fields to change`); return; }
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.set as Record<string, unknown>)) {
      if (fields.includes(k)) set[k] = k === 'solver' ? solverOf(v) ?? v : v;
      else warnings.push(`${at}.set: ${a.type} can't change "${k}" (only ${fields.join(', ')}); ignored`);
    }
    if (!Object.keys(set).length) return;
    const why = str(r.why, 500);
    patches.push({ target, set, ...(why && { why }) });
  });
  const knowledge: KnowledgePack[] = [];
  list('knowledge').forEach((k, i) => {
    const pack = parseKnowledge(k, `knowledge[${i}]`, errs, warnings);
    if (pack && reach(pack.board, `knowledge[${i}]`)) knowledge.push(pack);
  });
  const faultTypes: FaultTypeDef[] = [];
  list('faultTypes').forEach((f, i) => {
    const ft = parseFaultType(f, `faultTypes[${i}]`, errs, warnings);
    if (!ft) return;
    if (faultTypes.some((x) => x.id === ft.id)) errs.push(`faultTypes[${i}]: id "${ft.id}" is used twice`);
    else faultTypes.push(ft);
  });
  const rules: RuleDef[] = [];
  list('rules').forEach((r, i) => {
    const rd = parseRule(r, `rules[${i}]`, errs, warnings);
    if (!rd) return;
    if (rules.some((x) => x.id === rd.id)) errs.push(`rules[${i}]: id "${rd.id}" is used twice`);
    else rules.push(rd);
  });
  const meters: MeterDef[] = [];
  list('meters').forEach((m, i) => {
    const md = parseMeter(m, `meters[${i}]`, errs, warnings);
    if (!md) return;
    if (meters.some((x) => x.id === md.id)) errs.push(`meters[${i}]: id "${md.id}" is used twice`);
    else meters.push(md);
  });
  const devices: DeviceDef[] = [];
  list('devices').forEach((d, i) => {
    const dev = parseDevice(d, `devices[${i}]`, errs, warnings);
    if (!dev) return;
    if (devices.some((x) => deviceItemId(x.mpn) === deviceItemId(dev.mpn))) errs.push(`devices[${i}]: "${dev.mpn}" is listed twice`);
    else devices.push(dev);
  });
  let code: ModCode | undefined;
  if (raw.code !== undefined && v2) {
    const c = raw.code as Record<string, unknown>;
    if (!c || typeof c !== 'object' || Array.isArray(c)) errs.push('"code" must be an object: { "entry": "main.js", "api": "^1", "permissions": [] }');
    else {
      const entry = typeof c.entry === 'string' ? cleanPath(c.entry) : null;
      if (!entry || !/\.m?js$/i.test(entry)) errs.push('"code.entry" must be the path of a .js or .mjs file inside the mod');
      const api = typeof c.api === 'string' ? c.api.trim() : '';
      if (!validRange(api)) errs.push('"code.api" must be the plug-in API range the mod was written for, e.g. "^1"');
      else if (!satisfies(parseVersion(API_VERSION)!, api)) errs.push(`"code.api" asks for ${api}, but this version of PurpleBoard has plug-in API ${API_VERSION}: update PurpleBoard, or the mod`);
      const permissions: string[] = [];
      if (c.permissions !== undefined && !Array.isArray(c.permissions)) errs.push('"code.permissions" must be a list');
      for (const p of Array.isArray(c.permissions) ? c.permissions : []) {
        if (p === PERMISSIONS.localhost || p === PERMISSIONS.panel || p === PERMISSIONS.storage || (typeof p === 'string' && NETWORK_ORIGIN.test(p))) { if (!permissions.includes(p)) permissions.push(p); }
        else if (LATER_PERMISSIONS.includes(p as string)) warnings.push(`"code.permissions": "${p}" comes in a later version of PurpleBoard (not granted)`);
        else errs.push(`"code.permissions": unknown permission ${JSON.stringify(p)} (known: "${PERMISSIONS.localhost}", "network:https://host", "panel", "storage")`);
      }
      for (const k of Object.keys(c)) if (!['entry', 'api', 'permissions'].includes(k)) warnings.push(`"code": unknown field "${k}" (ignored)`);
      if (entry && validRange(api)) code = { entry, api, permissions };
    }
  }
  const puzzles: PuzzleSpec[] = [];
  list('puzzles').forEach((p, i) => {
    const pz = parsePuzzle(p, `puzzles[${i}]`, errs, warnings);
    if (!pz || !reach(pz.board, `puzzles[${i}]`)) return;
    // a fault named by address: another mod's fault type (or this mod's own)
    for (const f of pz.faults) {
      const fa = parseAddress(String(f.fault));
      if (fa && !reach(String(f.fault), `puzzles[${i}]`)) return;
      if (fa && fa.mod === id && !faultTypes.some((x) => x.id === fa.item)) errs.push(`puzzles[${i}]: this mod has no fault type "${fa.item}"`);
    }
    puzzles.push(pz);
  });
  for (const [key, items] of [['knowledge', knowledge], ['puzzles', puzzles]] as const) {
    const seen = new Set<string>();
    for (const it of items) { if (seen.has(it.id)) errs.push(`"${key}": id "${it.id}" is used twice`); seen.add(it.id); }
  }

  // a mod needs boards, unless (/2) it brings other items or is a pack that only lists mods
  const hasBoards = Array.isArray(raw.boards) && raw.boards.length > 0;
  const noBoards = raw.boards === undefined || (Array.isArray(raw.boards) && raw.boards.length === 0);
  const hasItems = patches.length + knowledge.length + puzzles.length + devices.length + faultTypes.length + meters.length + rules.length > 0 || !!code;
  if (!hasBoards && !(v2 && (Object.keys(requires).length || hasItems) && noBoards)) {
    errs.push(v2 ? '"boards" must list at least one board (or leave "boards" out and list mods in "requires", or add patches, knowledge or puzzles)' : '"boards" must list at least one board');
  }
  if (v2) {
    for (const k of Object.keys(raw)) {
      if (KNOWN_KEYS.has(k)) continue;
      warnings.push(FUTURE_KEYS.has(k) ? `"${k}" needs a newer version of PurpleBoard (ignored)` : `unknown field "${k}" (ignored)`);
    }
  }

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
    if (b.solver !== undefined) {
      const sv = solverOf(b.solver);
      const mv = v2 && typeof b.solver === 'string' ? parseAddress(b.solver) : null;
      if (sv) spec.solver = sv;
      else if (mv && mv.type === 'solvers' && (mv.mod === id || requires[mv.mod])) { spec.modSolver = b.solver as string; spec.solver = 'spice'; }
      else if (mv && mv.type === 'solvers') errs.push(`${at}.solver: "${mv.mod}" must be listed in "requires" to use its solver`);
      else (v2 ? errs : warnings).push(`${at}.solver must be "fast", "spice", "spice-power" or an address like "official-solvers/solvers/spice-power"${v2 ? '' : ' (ignored)'}`);
    }
    const credits = str(b.credits, 400); if (credits) spec.credits = credits;
    const bl = str(b.license, 60); if (bl) spec.license = bl;
    const src = str(b.source, 300);
    if (src) { if (/^https:\/\//.test(src)) spec.source = src; else errs.push(`${at}.source must be an https:// URL`); }
    boards.push(spec);
  });
  for (const pz of puzzles) {
    const clash = boards.find((b) => b.id === pz.id);
    if (clash) errs.push(`puzzles: id "${pz.id}" is also a board id in this mod (use another)`);
  }
  if (errs.length) throw new Error(`mod.json: ${errs.join('; ')}`);
  return {
    format: v2 ? MOD_FORMAT_2 : MOD_FORMAT, id, name: name!, license: license!,
    version,
    author: str(raw.author, 80) || 'anonymous',
    description: str(raw.description, 2000) ?? '',
    ...(homepage && { homepage }),
    boards, requires, conflicts, patches, knowledge, puzzles, devices, faultTypes, meters, rules,
    ...(code && { code }),
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
  const warnings: string[] = [];
  const manifest = parseManifest(new TextDecoder().decode(await src.read('mod.json')), warnings);
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
      if (spec.modSolver) sc.modSolver = spec.modSolver;
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
      mod: manifest, spec, stub, address: itemAddress(manifest.id, 'boards', spec.id),
      load: async () => cached ?? (cached = await build()),
      ...(spec.schematic && {
        schematic: { path: spec.schematic, mime: SCHEMATIC_TYPES[spec.schematic.split('.').pop()!.toLowerCase()], read: () => src.read(spec.schematic!) },
      }),
    });
  }
  if (manifest.code && missing(manifest.code.entry)) throw new Error(`${manifest.name}: its code file ${manifest.code.entry} is missing`);
  if (manifest.code) {
    const problem = codeProblem(new TextDecoder().decode(await src.read(manifest.code.entry)));
    if (problem) throw new Error(`${manifest.code.entry}: ${problem}`);
  }
  // knowledge / puzzles aimed at this mod's own boards: say early when the board isn't there
  const own = new Set(manifest.boards.map((b) => itemAddress(manifest.id, 'boards', b.id)));
  for (const it of [...manifest.knowledge, ...manifest.puzzles]) {
    if (parseAddress(it.board)?.mod === manifest.id && !own.has(it.board)) warnings.push(`"${it.id}": this mod has no board ${it.board}`);
  }
  if (!boards.length && manifest.boards.length) throw new Error(`${manifest.name}: none of its boards could be loaded${warnings.length ? ` (${warnings.join('; ')})` : ''}`);
  return { manifest, source: src, boards, warnings };
}
