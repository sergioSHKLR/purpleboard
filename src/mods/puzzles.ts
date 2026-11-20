// Puzzles: a repair challenge written as a recipe instead of a board file. It names a working board
// (by item address), the faults to plant (from the fault catalogue in src/faults.ts, with
// severities inside the catalogue's ranges) and the story. The physics comes from the simulator,
// so a recipe can't describe something the bench wouldn't show.
//
//   { "id": "flicker", "board": "starter-kit/boards/night-light", "title": "Flicker",
//     "faults": [ { "ref": "R1", "fault": "cold-joint", "pad": "2", "severity": 5e4 } ],
//     "flag": "PCB{...}" }
//
// The board must be a known-good reference: a board without a flag (a sandbox or imported design)
// or a shipped challenge whose repaired state the app knows. The flag (optional) is locked to the
// reference's topology, so only a real repair unlocks it.
import type { Board, Objective, Scenario } from '../types';
import type { ModManifest } from './mods';
import { parseAddress } from './address';
import { objectiveProblem } from './patches';
import { buildConnectivity } from '../connectivity';
import { lockFlag, topology } from '../crypto';
import { applicableFaults, injectFault, needsSpice, rng, seedOf, severityHint, type FaultClass } from '../faults';
import { faultTypeFits, injectFaultType, type FaultTypeDef } from './faulttypes';
import { setReference } from '../scenarios/reference';

export const FAULT_CLASSES: readonly FaultClass[] = [
  'mlcc-dead-short', 'cap-partial-short', 'liquid-leakage', 'resistor-drift', 'cap-capacitance-loss', 'cold-joint',
  'open-part', 'ic-rail-short', 'net-break', 'thermal-open-joint', 'thermal-leak', 'flex-open-joint', 'flex-close-joint',
];

/** `fault`: a class from the catalogue, or a mod fault type's address ("jane-faults/faultTypes/salt-water"). */
export interface PuzzleFault { ref: string; fault: FaultClass | string; severity?: number; pad?: string }
export interface PuzzleSpec {
  id: string;
  board: string;
  title: string;
  description: string;
  difficulty: number;
  hints: string[];
  /** The board's own objectives when left out. */
  objectives?: Objective[];
  faults: PuzzleFault[];
  flag?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined);

/** Reads one entry of a mod's `puzzles` list; problems go to errs / warnings. */
export function parsePuzzle(raw: unknown, at: string, errs: string[], warnings: string[]): PuzzleSpec | null {
  if (!isObj(raw)) { errs.push(`${at} must be an object`); return null; }
  for (const k of Object.keys(raw)) {
    if (!['id', 'board', 'title', 'description', 'difficulty', 'hints', 'objectives', 'faults', 'flag'].includes(k)) warnings.push(`${at}: unknown field "${k}" (ignored)`);
  }
  const id = text(raw.id, 64) ?? '';
  if (!ID_RE.test(id)) errs.push(`${at}.id must be 2-64 lowercase letters, digits, ".", "-" or "_"`);
  const board = text(raw.board, 200) ?? '';
  const addr = parseAddress(board);
  if (!addr || addr.type !== 'boards') errs.push(`${at}.board must be a board address like "starter-kit/boards/night-light"`);
  const title = text(raw.title, 120);
  if (!title) errs.push(`${at}.title is required`);
  let difficulty = 2;
  if (raw.difficulty !== undefined) {
    if (typeof raw.difficulty !== 'number' || raw.difficulty < 1 || raw.difficulty > 5) errs.push(`${at}.difficulty must be a number from 1 to 5`);
    else difficulty = Math.round(raw.difficulty);
  }
  let objectives: Objective[] | undefined;
  if (raw.objectives !== undefined) {
    if (!Array.isArray(raw.objectives)) errs.push(`${at}.objectives must be a list`);
    else {
      raw.objectives.forEach((o, i) => { const e = objectiveProblem(o); if (e) errs.push(`${at}.objectives[${i}]: ${e}`); });
      objectives = raw.objectives as Objective[];
    }
  }
  const faults: PuzzleFault[] = [];
  if (!Array.isArray(raw.faults) || !raw.faults.length) errs.push(`${at}.faults must list at least one fault`);
  (Array.isArray(raw.faults) ? raw.faults : []).slice(0, 10).forEach((f: unknown, i: number) => {
    const fa = `${at}.faults[${i}]`;
    if (!isObj(f)) { errs.push(`${fa} must be an object`); return; }
    const ref = text(f.ref, 40);
    if (!ref) { errs.push(`${fa}.ref is required (the part)`); return; }
    const byAddress = typeof f.fault === 'string' && parseAddress(f.fault)?.type === 'faultTypes';
    if (!byAddress && !FAULT_CLASSES.includes(f.fault as FaultClass)) { errs.push(`${fa}.fault must be one of: ${FAULT_CLASSES.join(', ')}, or a fault type's address`); return; }
    const cls = f.fault as FaultClass;
    const out: PuzzleFault = { ref, fault: f.fault as string };
    if (byAddress) {
      if (f.severity !== undefined) { if (typeof f.severity === 'number' && f.severity > 0) out.severity = f.severity; else errs.push(`${fa}.severity must be a positive number`); }
    } else if (f.severity !== undefined) {
      const h = severityHint(cls);
      if (!h) errs.push(`${fa}: "${cls}" has no severity`);
      else if (typeof f.severity !== 'number' || f.severity < h.min || f.severity > h.max) errs.push(`${fa}.severity must be a number from ${h.min} to ${h.max} (${h.unit})`);
      else out.severity = f.severity;
    }
    if (f.pad !== undefined) {
      if (typeof f.pad !== 'string' && typeof f.pad !== 'number') errs.push(`${fa}.pad must be a pad name, e.g. "2"`);
      else out.pad = String(f.pad);
    }
    faults.push(out);
  });
  if (Array.isArray(raw.faults) && raw.faults.length > 10) warnings.push(`${at}: only the first 10 faults are used`);
  const flag = text(raw.flag, 200);
  return {
    id, board, title: title ?? '', difficulty, faults,
    description: text(raw.description, 4000) ?? '',
    hints: Array.isArray(raw.hints) ? raw.hints.filter((h): h is string => typeof h === 'string').map((h) => h.slice(0, 1000)).slice(0, 10) : [],
    ...(objectives && { objectives }),
    ...(flag && { flag }),
  };
}

export const puzzleScenarioId = (modId: string, puzzleId: string) => `mod-${modId}-${puzzleId}`;

/**
 * Builds the puzzle: the reference board with the faults planted. `base` is the target board as
 * listed (for its objectives, solver and attribution); `reference` its known-good board.
 * Throws with a plain message when a fault doesn't fit the board.
 */
export async function buildPuzzle(spec: PuzzleSpec, mod: ModManifest, base: Scenario, reference: Board, faultTypes: ReadonlyMap<string, FaultTypeDef> = new Map()): Promise<Scenario> {
  const id = puzzleScenarioId(mod.id, spec.id);
  const b = structuredClone(reference);
  const objectives = structuredClone(spec.objectives ?? base.objectives);
  if (!objectives.length) throw new Error(`puzzle "${spec.id}": the board has no objectives, so add "objectives" to the puzzle`);
  const lock = spec.flag ? await lockFlag(spec.flag, topology(b, buildConnectivity(b), id)) : undefined;
  const seed = seedOf(id);
  spec.faults.forEach((f, i) => {
    const c = b.components.find((x) => x.ref === f.ref);
    if (!c) throw new Error(`puzzle "${spec.id}": no part ${f.ref} on the board`);
    const def = parseAddress(f.fault) ? faultTypes.get(f.fault) : undefined;
    if (parseAddress(f.fault) && !def) throw new Error(`puzzle "${spec.id}": the fault type ${f.fault} isn't available (is its mod on?)`);
    if (def && !faultTypeFits(def, c)) throw new Error(`puzzle "${spec.id}": "${def.name}" doesn't fit ${f.ref}`);
    const fits: string[] = [...applicableFaults(c), 'open-part'];
    if (!def && !fits.includes(f.fault)) throw new Error(`puzzle "${spec.id}": "${f.fault}" doesn't fit ${f.ref} (fits: ${fits.join(', ')})`);
    let pad: number | undefined;
    if (f.pad !== undefined) {
      pad = c.pads.findIndex((p) => p.name === f.pad);
      if (pad < 0) throw new Error(`puzzle "${spec.id}": ${f.ref} has no pad "${f.pad}" (pads: ${[...new Set(c.pads.map((p) => p.name))].join(', ')})`);
    }
    const opts = { ...(f.severity !== undefined && { severity: f.severity }), ...(pad !== undefined && { pad }) };
    if (def) injectFaultType(def, c, rng(seed + i), opts);
    else injectFault(c, f.fault as FaultClass, rng(seed + i), opts);
  });
  const spiceFault = (f: PuzzleFault) => (FAULT_CLASSES.includes(f.fault as FaultClass) ? needsSpice(f.fault as FaultClass) : true);
  const solver = base.solver ?? (spec.faults.some(spiceFault) ? 'spice' : undefined);
  const sc: Scenario = {
    format: 'pcbfix/1', id, objectives, board: b,
    meta: {
      title: spec.title, author: mod.author, difficulty: spec.difficulty, description: spec.description, hints: spec.hints,
      credits: [`Puzzle from the mod "${mod.name}" v${mod.version} by ${mod.author}.`, base.meta.credits].filter(Boolean).join(' '),
      license: base.meta.license ?? mod.license,
      ...(base.meta.source && { source: base.meta.source }),
    },
    ...(lock && { lock }),
    ...(solver && { solver }),
  };
  setReference(sc, structuredClone(reference)); // the working board it was built on («Where to look?», bench check)
  return sc;
}
