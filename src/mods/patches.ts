// Patches: a mod changes one item of another mod without copying it (docs/MOD_PLATFORM.md).
//
//   { "target": "official-boards/boards/builtin-first-light", "set": { "hints": ["…"] }, "why": "…" }
//
// `set` is a JSON merge patch (RFC 7396): objects merge, arrays and plain values replace, null
// deletes. Patches apply in load order (dependencies first); when two mods set the same field the
// later one wins and the conflict is reported. After each patch the item is checked again; a patch
// that would break it is skipped with a note and the item keeps its previous state.
//
// Patchable types: boards (text, tests and solver only: the board, its parts and its flag can't be
// patched, so a mod can't make a board easier to cheat) and devices (src/mods/devices.ts).
import type { Objective, Scenario } from '../types';

export interface PatchSpec { target: string; set: Record<string, unknown>; why?: string }

/** RFC 7396 JSON merge patch. Returns a new value; `target` is not modified. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const base: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

// ---------------- boards ----------------

export const BOARD_FIELDS = ['title', 'description', 'difficulty', 'hints', 'objectives', 'solver'] as const;
export type BoardField = (typeof BOARD_FIELDS)[number];

/** The patchable part of a board. */
export interface BoardView {
  title: string;
  description: string;
  difficulty: number;
  hints: string[];
  objectives: Objective[];
  solver?: Scenario['solver'];
}

export const boardView = (sc: Scenario): BoardView => structuredClone({
  title: sc.meta.title, description: sc.meta.description, difficulty: sc.meta.difficulty, hints: sc.meta.hints,
  objectives: sc.objectives, ...(sc.solver && { solver: sc.solver }),
});

export function writeBoardView(sc: Scenario, v: BoardView) {
  sc.meta.title = v.title;
  sc.meta.description = v.description;
  sc.meta.difficulty = v.difficulty;
  sc.meta.hints = [...v.hints];
  sc.objectives = structuredClone(v.objectives);
  if (v.solver) sc.solver = v.solver; else delete sc.solver;
}

const isSwitches = (s: unknown) => s === undefined || (!!s && typeof s === 'object' && !Array.isArray(s) && Object.values(s).every((x) => typeof x === 'boolean'));
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);

/** Problems with one objective, in words an author can act on (empty = fine). */
export function objectiveProblem(o: unknown): string | null {
  if (!o || typeof o !== 'object') return 'an objective must be an object';
  const r = o as Record<string, unknown>;
  if (!isSwitches(r.switches)) return '"switches" must map switch refs to true / false';
  if (r.type === 'led') return typeof r.ref === 'string' && r.ref && typeof r.on === 'boolean' ? null : 'a "led" objective needs "ref" and "on": true / false';
  if (r.type === 'voltage') {
    if (typeof r.a !== 'string' || !r.a || (r.b !== undefined && typeof r.b !== 'string')) return 'a "voltage" objective needs "a" (and optionally "b") part refs';
    return num(r.min) && num(r.max) && (r.min as number) <= (r.max as number) ? null : 'a "voltage" objective needs numbers "min" ≤ "max"';
  }
  return 'objective "type" must be "led" or "voltage"';
}

/** Problems with a patched board view (empty = valid). */
export function boardViewProblems(v: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 120) p.push('"title" must be text (1–120 characters)');
  if (typeof v.description !== 'string' || v.description.length > 4000) p.push('"description" must be text (up to 4000 characters)');
  if (!num(v.difficulty) || (v.difficulty as number) < 1 || (v.difficulty as number) > 5) p.push('"difficulty" must be a number from 1 to 5');
  if (!Array.isArray(v.hints) || v.hints.length > 10 || v.hints.some((h) => typeof h !== 'string' || h.length > 1000)) p.push('"hints" must be up to 10 texts');
  if (!Array.isArray(v.objectives) || v.objectives.length > 50) p.push('"objectives" must be a list (up to 50)');
  else v.objectives.forEach((o, i) => { const e = objectiveProblem(o); if (e) p.push(`objectives[${i}]: ${e}`); });
  if (v.solver !== undefined && v.solver !== 'fast' && v.solver !== 'spice' && v.solver !== 'spice-power') p.push('"solver" must be "fast", "spice" or "spice-power"');
  return p;
}

/** One patch to apply, with who made it. */
export interface PatchEntry { modId: string; modName: string; patch: PatchSpec }

export interface FieldChange { modId: string; field: string; before: unknown; after: unknown; why?: string }
export interface PatchConflict { field: string; mods: string[] }
export interface PatchSkip { modId: string; problems: string[] }
export interface PatchResult { changes: FieldChange[]; conflicts: PatchConflict[]; skipped: PatchSkip[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies patches in order to a copy of `base`: each must leave the item valid (`problems` empty,
 * after `fill` restores defaults for deleted fields), else it is skipped. Reports what changed, which
 * fields several mods set (the last wins) and which patches were skipped.
 */
export function applyPatches<T extends object>(
  base: T, entries: PatchEntry[], fields: readonly string[],
  problems: (v: Record<string, unknown>) => string[], fill: (v: Record<string, unknown>) => void = () => {},
): { value: T; result: PatchResult } {
  const res: PatchResult = { changes: [], conflicts: [], skipped: [] };
  let view = structuredClone(base) as Record<string, unknown>;
  const setBy = new Map<string, string[]>();
  for (const e of entries) {
    const next = mergePatch(view, e.patch.set) as Record<string, unknown>;
    fill(next);
    const p = problems(next);
    if (p.length) { res.skipped.push({ modId: e.modId, problems: p }); continue; }
    for (const f of fields) {
      if (!(f in e.patch.set)) continue;
      setBy.set(f, [...(setBy.get(f) ?? []), e.modId]);
      if (!same(view[f], next[f])) res.changes.push({ modId: e.modId, field: f, before: view[f], after: next[f], ...(e.patch.why && { why: e.patch.why }) });
    }
    view = next;
  }
  for (const [field, mods] of setBy) if (new Set(mods).size > 1) res.conflicts.push({ field, mods: [...new Set(mods)] });
  return { value: view as T, result: res };
}

/** Applies board patches in order to `sc` (in place) and reports what changed, clashed or was skipped. */
export function applyBoardPatches(sc: Scenario, entries: PatchEntry[]): PatchResult {
  const { value, result } = applyPatches(boardView(sc), entries, BOARD_FIELDS, boardViewProblems, (v) => {
    if (v.hints === undefined) v.hints = [];
    if (v.objectives === undefined) v.objectives = [];
  });
  writeBoardView(sc, value);
  return result;
}
