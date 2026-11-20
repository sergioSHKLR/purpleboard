// @deadboard/mod-api 1.0.0: types of the DEADBOARD plug-in API (generated from
// src/mods/api/types.ts in the DEADBOARD repository; do not edit).

export type PartKind =
  | 'resistor' | 'capacitor' | 'led' | 'diode' | 'battery' | 'switch' | 'fuse'
  | 'testpoint' | 'ic' | 'connector' | 'generic';

/** One pad of a part, as the circuit sees it. */
export interface NetPin {
  /** Pad name on the footprint ("1", "2", "A1"…). */
  pad: string;
  /** Electrical role of this pad ("A"/"K" for diodes, "+"/"-" for batteries, …), reversal applied. */
  role?: string;
  /** Net id (index into Netlist.nets); -1 when the pad touches no copper. */
  net: number;
  /** The joint doesn't conduct (cold, lifted pad, broken copper). */
  open?: boolean;
  /** A resistive (cold) joint: series resistance in ohms. */
  ohms?: number;
}

export interface NetPart {
  ref: string;
  kind: PartKind;
  /** Ohms (resistor, drift applied), farads (capacitor), volts (battery), amps (fuse rating). */
  value: number;
  /** The value is a guess (the board file didn't say). */
  valueGuessed?: boolean;
  /** Part number / marking, when known. */
  label?: string;
  /** LED colour and its typical forward voltage (V). */
  color?: string;
  vf?: number;
  /** Battery internal resistance (Ω). */
  rint?: number;
  /** Resistor power rating (W). */
  rating?: number;
  populated: boolean;
  burnt: boolean;
  /** Switch contacts closed (the test's switch settings already applied). */
  closed?: boolean;
  /** A leak across the part (failed capacitor, liquid residue): ohms between two pads. */
  leak?: { ohms: number; a: string; b: string };
  pins: NetPin[];
}

export interface Net { id: number; name: string | null }

/** The board as a circuit: nets and parts. */
export interface Netlist { title: string; nets: Net[]; parts: NetPart[] }

/** What the app asks a solver mod to solve: the board fully powered, as the bench sees it. */
export interface SolveInput {
  netlist: Netlist;
  /** Voltmeters attached: [red net, black net (-1 = supply ground)], 10 MΩ input. */
  meters: [number, number][];
  /** Bench supply current limit (A), when set. */
  currentLimit?: number;
}

export interface PartResult {
  /** Current through the part (A): first role → second (A→K, + delivering for a battery). */
  i: number;
  /** Voltage across it (V), first role minus second. */
  v: number;
  /** Power (W). */
  p: number;
  /** An LED is lit. */
  on?: boolean;
  /** Brightness 0–1 (LEDs). */
  bright?: number;
  /** The part is overloaded: the app burns it. Say why in overMsg. */
  over?: boolean;
  overMsg?: string;
}

export interface SolveResult {
  /** Volts per net id, against supply ground. Nets left out read as floating. */
  nets: Record<number, number>;
  /** Per part ref. Parts left out carry no current. */
  parts: Record<string, PartResult>;
  /** False when nothing powers the board. Default true. */
  source?: boolean;
}

export interface SolverDef {
  /** Shown in the solver menu. */
  name: string;
  description?: string;
  solve(input: SolveInput): SolveResult | Promise<SolveResult>;
}

/** A file the player opened, for an importer. */
export interface ImportInput { name: string; bytes: Uint8Array }
/**
 * What an importer returns: KiCad board text (read by the app's KiCad importer) or a DEADBOARD
 * scenario object (the .pcbfix.json format, as the Author tab exports it). Either way the app's own
 * importers check it, so an importer never builds the app's structures directly.
 */
export type ImportOutput = { kicadPcb: string } | { pcbfix: unknown };

export interface ImporterDef {
  /** Shown to players, e.g. "Eagle board". */
  name: string;
  /** File endings it reads, lowercase with the dot: [".sch", ".myboard"]. */
  extensions: string[];
  description?: string;
  /** Reads the file. (Not called "import": a code mod's file can't contain that word.) */
  read(input: ImportInput): ImportOutput | Promise<ImportOutput>;
}

/**
 * A panel's content: plain data the app draws with its own components (a mod can't add HTML).
 * Text is shown as written; with `linkRefs`, part names that are on the open board become links.
 */
export type PanelNode =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: 'muted' | 'warn' | 'good' | 'mono'; linkRefs?: boolean }
  | { type: 'ref'; ref: string; label?: string }
  | { type: 'list'; items: string[]; linkRefs?: boolean }
  | { type: 'row'; children: PanelNode[] }
  | { type: 'button'; id: string; label: string }
  | { type: 'input'; id: string; label?: string; placeholder?: string; value?: string; multiline?: boolean; submit: string }
  | { type: 'divider' };

export interface PanelDef {
  /** Shown above the panel. */
  title: string;
  content?: PanelNode[];
}

/** Events the app sends to every code mod (read-only). */
export interface Events {
  /** A board was opened. */
  'board:loaded': { title: string; netlist: Netlist };
  /** Bench power switched. `nets`: volts by net name while on. */
  'power:changed': { on: boolean; nets: Record<string, number> };
  /** The player ran the tests. */
  'tests:run': { passed: boolean; results: { label: string; passed: boolean; detail: string }[] };
  /** A repair unlocked the flag. */
  'flag:unlocked': { title: string };
  /** The meter showed a reading. */
  'measure:taken': { mode: string; red: string | null; black: string | null; text: string };
  /** A probe moved: the nets (by name, or "#id" when unnamed) under the red and black probes. */
  'probe:placed': { red: string | null; black: string | null };
  /** The bench solved the board (at most a few times a second): volts by net name, and per part. */
  'bench:solved': { nets: Record<string, number>; parts: Record<string, { i: number; v: number; p: number; on: boolean }> };
  /** A button or input in one of this mod's panels (sent to that mod only). */
  'panel:action': { panel: string; id: string; value?: string };
}
export type EventName = keyof Events;

/** Read-only questions about the open board (the latest one an event or solve call carried). */
export interface Queries {
  /** A part by ref, or near matches when there is no exact one (never throws). */
  findRef(q: string): { found: true; part: NetPart } | { found: false; matches: NetPart[] };
  parts(): NetPart[];
  /** Pins on a net (by name or id): ref + pad. */
  pinsOfNet(net: string | number): { ref: string; pad: string; role?: string }[];
  /** The net name (or id when unnamed) a pin is on, or null. */
  netOfPin(ref: string, pad: string): string | number | null;
  /** Latest volts on a net while powered, or null (off / unknown / floating). */
  railState(net: string): { volts: number | null; powered: boolean };
}

export interface ModApi {
  apiVersion: string;
  mod: { id: string; version: string; permissions: string[] };
  register: {
    /** A solver, listed in the app as `<mod id>/solvers/<id>`. */
    solver(id: string, def: SolverDef): void;
    /** A board file importer, `<mod id>/importers/<id>`: used for files with its endings. */
    importer(id: string, def: ImporterDef): void;
    /** A panel in the side panel's Mods tab (needs the "panel" permission). */
    panel(id: string, def: PanelDef): void;
  };
  /** Replace a panel's content (any time after it is registered). */
  panels: { set(id: string, content: PanelNode[]): void };
  /** Point at things on the bench (needs the "panel" permission). */
  ui: {
    /** Select a part and zoom to it. Resolves to false when the board has no such part. */
    zoomTo(ref: string): Promise<boolean>;
    /** A short message to the player (at most one a second). */
    say(text: string): Promise<void>;
  };
  /** A small store for this mod only, kept by the app (needs the "storage" permission; 64 KB). */
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
  };
  on<E extends EventName>(event: E, handler: (payload: Events[E]) => void): void;
  queries: Queries;
  /** Writes to the browser console, prefixed with the mod id (for authors). */
  log(...args: unknown[]): void;
}

/** The default export of a code mod. */
export type Activate = (api: ModApi) => void | Promise<void>;
