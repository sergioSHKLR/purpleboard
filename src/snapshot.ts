// Bench snapshot for bug reports: what the player's bench looked like when they hit "Send",
// compact enough to ride along in the feedback email as one code. The developer pastes the
// email into `npx tsx scripts/repro.ts`, which rebuilds the bench and checks it.
//
// Privacy: only boards that ship with DEADBOARD (built-in lessons, open-hardware demos) are
// described by their changes; a board the player imported (their own, maybe proprietary,
// design) is reduced to its format and counts and never leaves the browser.
import type { Board } from './types';
import { packText, unpackText } from './crypto';

type Keyed = { id: string };
const COLLECTIONS = ['components', 'traces', 'vias', 'blobs', 'jumpers', 'zones'] as const;
type Coll = (typeof COLLECTIONS)[number];

/** Per collection: items that are new or changed (whole item), and ids that are gone. */
export type BoardDiff = Partial<Record<Coll, { set?: Keyed[]; del?: string[] }>>;

export interface BenchSnapshot {
  v: 1;
  build: string;
  at: string;
  scenario: { id: string; title: string; shipped: boolean; format?: string; parts: number; traces: number; vias: number };
  /** The player's changes to a shipped board; absent for imported boards. */
  diff?: BoardDiff;
  bench: {
    power: boolean;
    solver: string;
    ocpAmps: number;
    inject?: { volts: number; amps: number } | null;
    boot?: string;
    view: string;
    tool: string;
    selected?: string;
    dmm: { mode: string; red?: string; black?: string; reading?: string };
  };
  /** What the bench showed the player. */
  seen: { volts: number; amps: number; cc: boolean; lit: string[]; tests?: string };
  /** The last messages the app showed, newest last. */
  toasts: string[];
  /** Uncaught errors and WebGPU problems, newest last. */
  errors: string[];
  moves: number;
}

export function boardDiff(orig: Board, cur: Board): BoardDiff {
  const d: BoardDiff = {};
  for (const k of COLLECTIONS) {
    const before = new Map((orig[k] as Keyed[]).map((x) => [x.id, JSON.stringify(x)]));
    const now = new Set<string>();
    const set: Keyed[] = [];
    for (const x of cur[k] as Keyed[]) {
      now.add(x.id);
      if (before.get(x.id) !== JSON.stringify(x)) set.push(x);
    }
    const del = [...before.keys()].filter((id) => !now.has(id));
    if (set.length || del.length) d[k] = { ...(set.length && { set }), ...(del.length && { del }) };
  }
  return d;
}

/** The original board with the player's changes applied (order: originals, then new items). */
export function applyBoardDiff(orig: Board, d: BoardDiff): Board {
  const b = structuredClone(orig);
  for (const k of COLLECTIONS) {
    const ch = d[k];
    if (!ch) continue;
    const del = new Set(ch.del ?? []);
    const set = new Map((ch.set ?? []).map((x) => [x.id, x]));
    const list = (b[k] as Keyed[]).filter((x) => !del.has(x.id)).map((x) => set.get(x.id) ?? x);
    const have = new Set(list.map((x) => x.id));
    for (const x of ch.set ?? []) if (!have.has(x.id)) list.push(x);
    (b as unknown as Record<Coll, Keyed[]>)[k] = list;
  }
  return b;
}

const TAG = 'DBSNAP1:', END = ':END';
/** Above this the board changes are dropped (FormSubmit emails stay small). */
const MAX_CODE = 60_000;

/** One copy-pastable code: `DBSNAP1:` + compressed JSON + `:END`. */
export async function encodeSnapshot(s: BenchSnapshot): Promise<string> {
  let body = await packText(JSON.stringify(s));
  if (body.length > MAX_CODE && s.diff) body = await packText(JSON.stringify({ ...s, diff: undefined, diffDropped: true }));
  return TAG + body + END;
}

/** Finds and decodes the snapshot code in a pasted email; line breaks inside it are ignored. */
export async function decodeSnapshot(text: string): Promise<BenchSnapshot & { diffDropped?: boolean }> {
  const a = text.indexOf(TAG), b = a < 0 ? -1 : text.indexOf(END, a + TAG.length);
  if (a < 0 || b < 0) throw new Error('no DBSNAP1:…:END code found in the text');
  const body = text.slice(a + TAG.length, b).replace(/[^A-Za-z0-9_-]/g, '');
  return JSON.parse(await unpackText(body));
}
