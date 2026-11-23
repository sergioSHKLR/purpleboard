// One anonymous attempt record: what DEADBOARD's own collector (collector/) stores about one try
// at one puzzle. Shared by the game (builds and sends it, src/attempts/client.ts) and the collector
// (checks it), so both agree on every field. The rules (handoff: "Analytics direction",
// docs/PRIVACY.md "Puzzle statistics"):
//   - no person, device or install identifier; no free text; nothing the player typed;
//   - coarse values: counts and times as ranges, the level as a number the puzzle already shows;
//   - every string comes from a fixed list (or is a shipped board id, checked by its shape).
// The only token is `attempt`: a random number made for this one attempt, so that the record sent
// when the tab is hidden can be replaced by the final one. It is never stored on the device, and
// the collector erases it a day later.

export const RECORD_VERSION = 1;

/** Ranges for counts and times. Each list is [label, upper bound (exclusive)], the last open-ended. */
export const ACTIVE_RANGES = [['<1m', 60], ['1-2m', 120], ['2-5m', 300], ['5-10m', 600], ['10-20m', 1200], ['20-40m', 2400], ['40m+', Infinity]] as const;
export const COUNT_RANGES = [['0', 1], ['1', 2], ['2', 3], ['3-5', 6], ['6-10', 11], ['11-20', 21], ['21+', Infinity]] as const;
export const ATTEMPT_RANGES = [['1', 2], ['2', 3], ['3-5', 6], ['6+', Infinity]] as const;
export const SOLVED_RANGES = [['0', 1], ['1-2', 3], ['3-5', 6], ['6-10', 11], ['11+', Infinity]] as const;
export const DAY_RANGES = [['0', 1], ['1', 2], ['2-7', 8], ['8-30', 31], ['31+', Infinity]] as const;

type Label<R extends readonly (readonly [string, number])[]> = R[number][0];

export function inRange<R extends readonly (readonly [string, number])[]>(ranges: R, n: number): Label<R> {
  const x = Number.isFinite(n) ? Math.max(0, n) : 0;
  return (ranges.find(([, to]) => x < to) ?? ranges[ranges.length - 1])[0];
}

const labels = (r: readonly (readonly [string, number])[]) => new Set(r.map(([l]) => l));

export const OUTCOMES = ['fixed', 'left', 'switched'] as const;
export const KINDS = ['tutorial', 'challenge', 'real', 'daily', 'generated', 'custom'] as const;
export const VIDEOS = ['none', 'approach', 'solution', 'both'] as const;
export const FIRST_TESTS = ['none', 'pass', 'fail'] as const;
export const LAYOUTS = ['phone', 'desktop'] as const;
export const LANGS = ['en', 'ru', 'other'] as const;
/** The bench's tools (ToolId in src/ui/app.ts, without "inspect"). */
export const TOOL_IDS = ['dmm', 'iron', 'wick', 'flip180', 'jumper', 'knife', 'replace', 'freeze', 'ipa', 'press', 'hotair', 'scope', 'rosin'] as const;

export interface AttemptRecord {
  /** Record format version. */
  v: number;
  /** Random per attempt (see the top of this file); 16-32 hex characters. */
  attempt: string;
  /** App build, e.g. "0.1.0+1b3e2ad". */
  build: string;
  /** A shipped board id; "daily" / "generated" (see `from`); "custom" for imported or mod boards. */
  puzzle: string;
  kind: (typeof KINDS)[number];
  /** For daily and generated puzzles: the shipped board they were made from, else "". */
  from: string;
  /** Short content hash of the puzzle as played (board + faults): tells puzzle versions apart. */
  pv: string;
  /** The level the puzzle shows (0.0-10.0). */
  level: number;
  /** Hidden faults of a daily / generated puzzle (1-9); 0 for the others. */
  faults: number;
  outcome: (typeof OUTCOMES)[number];
  active: Label<typeof ACTIVE_RANGES>;
  moves: Label<typeof COUNT_RANGES>;
  probes: Label<typeof COUNT_RANGES>;
  tests: Label<typeof COUNT_RANGES>;
  firstTest: (typeof FIRST_TESTS)[number];
  /** Notes revealed (0-20). */
  notes: number;
  /** «Where to look?» asked. */
  look: Label<typeof COUNT_RANGES>;
  video: (typeof VIDEOS)[number];
  /** Tools used at least once, sorted. */
  tools: (typeof TOOL_IDS)[number][];
  /** First Light / lesson guide: furthest step shown (0 = none, max 20). */
  tut: number;
  layout: (typeof LAYOUTS)[number];
  lang: (typeof LANGS)[number];
  /** Path context, all ranges: attempt number in this page load, boards solved before, days since first play. */
  nth: Label<typeof ATTEMPT_RANGES>;
  solved: Label<typeof SOLVED_RANGES>;
  days: Label<typeof DAY_RANGES>;
  /** A/B variant ("" while no test runs). */
  ab: string;
}

/** Field order of a stored row (the collector's table has one column per field, see collector/schema.sql). */
export const FIELDS = ['v', 'attempt', 'build', 'puzzle', 'kind', 'from', 'pv', 'level', 'faults', 'outcome', 'active', 'moves', 'probes', 'tests', 'firstTest', 'notes', 'look', 'video', 'tools', 'tut', 'layout', 'lang', 'nth', 'solved', 'days', 'ab'] as const;

const BOARD_ID = /^(builtin|demo)-[a-z0-9-]{1,60}$/;
const HEX = /^[0-9a-f]+$/;
const BUILD = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(\+[0-9a-f]{7,12})?$|^dev$/;
const AB = /^$|^[a-z0-9]{1,8}:[a-z0-9]{1,8}$/;
/** A record is small; anything bigger is refused before parsing. */
export const MAX_BYTES = 1024;

const ACTIVE = labels(ACTIVE_RANGES), COUNT = labels(COUNT_RANGES), NTH = labels(ATTEMPT_RANGES), SOLVED = labels(SOLVED_RANGES), DAYS = labels(DAY_RANGES);
const oneOf = (set: ReadonlySet<string> | readonly string[], x: unknown): x is string =>
  typeof x === 'string' && (Array.isArray(set) ? set.includes(x) : (set as ReadonlySet<string>).has(x));
const int = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

/**
 * The record if `x` is exactly a valid attempt record (every field present and allowed, nothing
 * else), else a short reason. The collector stores nothing that fails here.
 */
export function checkRecord(x: unknown): AttemptRecord | string {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
  const r = x as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) return `unknown field ${extra[0].slice(0, 20)}`;
  for (const f of FIELDS) if (!(f in r)) return `missing ${f}`;
  if (r.v !== RECORD_VERSION) return 'version';
  if (typeof r.attempt !== 'string' || r.attempt.length < 16 || r.attempt.length > 32 || !HEX.test(r.attempt)) return 'attempt';
  if (typeof r.build !== 'string' || !BUILD.test(r.build)) return 'build';
  if (!oneOf(KINDS, r.kind)) return 'kind';
  const shipped = (s: unknown) => typeof s === 'string' && BOARD_ID.test(s);
  if (r.kind === 'daily' || r.kind === 'generated') {
    if (r.puzzle !== r.kind || !shipped(r.from)) return 'puzzle';
    if (!int(r.faults, 1, 9)) return 'faults';
  } else if (r.kind === 'custom') {
    if (r.puzzle !== 'custom' || r.from !== '' || r.faults !== 0) return 'puzzle';
  } else if (!shipped(r.puzzle) || r.from !== '' || r.faults !== 0) return 'puzzle';
  if (typeof r.pv !== 'string' || r.pv.length !== 8 || !HEX.test(r.pv)) return 'pv';
  if (typeof r.level !== 'number' || !(r.level >= 0 && r.level <= 10) || Math.abs(Math.round(r.level * 10) - r.level * 10) > 1e-6) return 'level';
  if (!oneOf(OUTCOMES, r.outcome)) return 'outcome';
  if (!oneOf(ACTIVE, r.active)) return 'active';
  for (const f of ['moves', 'probes', 'tests', 'look'] as const) if (!oneOf(COUNT, r[f])) return f;
  if (!oneOf(FIRST_TESTS, r.firstTest)) return 'firstTest';
  if ((r.firstTest === 'none') !== (r.tests === '0')) return 'firstTest';
  if (r.outcome === 'fixed' && r.tests === '0') return 'outcome';
  if (!int(r.notes, 0, 20)) return 'notes';
  if (!oneOf(VIDEOS, r.video)) return 'video';
  if (!Array.isArray(r.tools) || r.tools.length > TOOL_IDS.length || !r.tools.every((t) => oneOf(TOOL_IDS, t))) return 'tools';
  if (new Set(r.tools).size !== r.tools.length || [...r.tools].sort().join() !== r.tools.join()) return 'tools';
  if (!int(r.tut, 0, 20)) return 'tut';
  if (!oneOf(LAYOUTS, r.layout)) return 'layout';
  if (!oneOf(LANGS, r.lang)) return 'lang';
  if (!oneOf(NTH, r.nth)) return 'nth';
  if (!oneOf(SOLVED, r.solved)) return 'solved';
  if (!oneOf(DAYS, r.days)) return 'days';
  if (typeof r.ab !== 'string' || !AB.test(r.ab)) return 'ab';
  return r as unknown as AttemptRecord;
}

/** 8 hex characters of FNV-1a over a string: a puzzle version, not a security hash. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
