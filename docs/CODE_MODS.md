# Code mods

A code mod brings a program: a new **circuit solver**, an **importer** for a board format the game
doesn't read, or **panels**: instruments, coaches, anything that shows information next to the board.
It runs in a sandbox, and only when the player has switched code mods on (**Mods → Code mods**,
experimental). Code mods run on the website and in the desktop app, not in the iOS app.

For mods made only of data (boards, puzzles, knowledge, fault types, meters, rules) see
[Make your own boards](MODDING.md) and the [Mod reference](MOD_REFERENCE.md).

## Start from an example

| Example | What it shows |
| --- | --- |
| [ideal-dc.zip](https://deadboard.org/examples/ideal-dc.zip) | A solver: modified nodal analysis in plain JavaScript; matches the official solvers on every built-in board. No permissions. |
| [local-coach.zip](https://deadboard.org/examples/local-coach.zip) | A panel that asks a language model on the player's own computer about the board, with grounding. Permissions `network:localhost`, `panel`, `storage`. |

Install one, switch on **Mods → Code mods**, and press **Use** (solver) or open the side panel's
**Mods** tab (panel).

## The package

```json
{
  "format": "deadboard-mod/2",
  "id": "my-tool",
  "name": "My tool",
  "version": "1.0.0",
  "license": "MIT",
  "code": { "entry": "main.js", "api": "^1", "permissions": [] }
}
```

| `code` field | What it is |
| --- | --- |
| `entry` | The code file in the mod (`.js` or `.mjs`). |
| `api` | The plug-in API range it was written for, e.g. `"^1"`. The app refuses a mod asking for an API it doesn't have. |
| `permissions` | What the mod may use beyond the basics ([Permissions](#permissions)). Shown to the player on install and on the mod's card. |

`main.js` has one export:

```js
/// <reference types="@deadboard/mod-api/global" />
/** @param {DeadboardMod.ModApi} api */
export default function activate(api) {
  api.log('hello from', api.mod.id);
}
```

## The rules

- **One file, one export.** Bundle your code (esbuild, Rollup, …) into a single file whose only
  export is `export default function activate(api)`. The game runs it as a plain script, so it
  can't load other code: the words `import` and `export` may not appear anywhere else in the file,
  not even in a comment or a string. Files that break this are refused at install.
- **No `eval`**, `new Function` or string timers. WebAssembly is allowed.
- **No page, files, storage or other mods.** The mod runs in a worker inside a sandboxed frame with
  no origin of its own; it talks to the game only through `api`.
- **No network** without a permission (below).
- **Time limits:** `activate` must finish within 5 s, a solve within 10 s, an import within 30 s.
  A mod that runs over, fails to start or answers garbage is stopped; the game falls back to its
  own solver and tells the player why.
- **The game checks what it gets:** solver results number by number, panel content node by node,
  importer output through its own importers.

## The API

| Member | What it does |
| --- | --- |
| `api.apiVersion` | The plug-in API version of this app (e.g. `"1.0.0"`). |
| `api.mod` | `{ id, version, permissions }` of your mod. |
| `api.register.solver(id, def)` | A circuit solver, `<mod id>/solvers/<id>` ([Solvers](#solvers)). During `activate` only. |
| `api.register.importer(id, def)` | A board importer, `<mod id>/importers/<id>` ([Importers](#importers)). During `activate` only. |
| `api.register.panel(id, { title, content })` | A panel in the **Mods** tab ([Panels](#panels)). Needs `panel`; up to 4 panels. |
| `api.panels.set(id, content)` | Replaces a panel's content, any time. |
| `api.on(event, handler)` | Read-only [events](#events). |
| `api.queries` | Questions about the open board ([Queries](#queries)). |
| `api.ui.zoomTo(ref)` | Selects a part and zooms to it; resolves `false` if the board has no such part. Needs `panel`. |
| `api.ui.say(text)` | A short message to the player (at most one a second). Needs `panel`. |
| `api.storage.get(key)`, `api.storage.set(key, value)` | A small store for your mod (64 KB), kept by the game; `null` removes. Needs `storage`. |
| `api.log(...)` | The browser console, prefixed with your mod id. |

## Solvers

```js
api.register.solver('my-solver', {
  name: 'My solver',
  description: 'What it models',
  solve({ netlist, meters, currentLimit }) {
    return { nets: { /* net id: volts */ }, parts: { /* ref: { i, v, p, on, bright, over, overMsg } */ }, source: true };
  },
});
```

**Input:** the board as a circuit, with the bench's state already applied.

| `netlist` field | What it is |
| --- | --- |
| `nets` | `[{ id, name }]`; ids are the app's net numbers, `name` is `null` when unnamed. |
| `parts[].ref`, `kind`, `value` | `kind`: resistor, capacitor, led, diode, battery, switch, fuse, testpoint, ic, connector, generic. `value` in Ω / F / V / A (drift applied). |
| `parts[].pins` | `[{ pad, role, net, open, ohms }]`: `role` is the electrical role (`A`/`K`, `+`/`-`, reversal applied); `open` a joint that doesn't conduct; `ohms` a resistive joint. |
| `parts[].populated`, `burnt` | Fitted; damaged (open). |
| `parts[].closed` | Switches: contacts closed (the tests' switch settings applied). |
| `parts[].leak` | `{ ohms, a, b }`: a leak between two pads. |
| `parts[].vf`, `rint`, `rating` | LED forward voltage; battery internal resistance; resistor power rating. |
| `meters` | Voltmeters attached: `[red net, black net]` (black `-1` = ground), 10 MΩ each. |
| `currentLimit` | Bench supply limit (A), when set. |

**Output:** volts per net id (against supply ground; nets left out read as floating) and, per part
ref, current (first role → second), voltage, power, and for LEDs `on` / `bright`. `over: true` burns
the part, so say why in `overMsg`. `source: false` means nothing powers the board.

Players pick your solver under **Bench → Solver** or with **Use** on the mod's card. Ohm, diode and
injection measurements stay on the official solver. "Run tests" uses your solver and labels the
result; a flag still unlocks only after a real repair. The bench check runs your solver on every
working board and compares it with the official ones.

## Importers

```js
api.register.importer('my-format', {
  name: 'My CAD format',
  extensions: ['.myb'],
  read({ name, bytes }) {
    return { kicadPcb: '(kicad_pcb …)' };   // or { pcbfix: { …challenge object… } }
  },
});
```

When the player drops a file with one of your endings, the game calls `read`, then opens what it
returns with its own importers: KiCad board text, or a challenge object in the `.pcbfix.json`
format. File types the game already reads go to its own importer first; yours is tried when that
refuses the file (another program's `.brd`, say). The method is called `read`, because a code
mod can't contain the other word.

## Panels

Panels are data. The game draws them with its own components and escapes all text; a mod can't add
HTML or styles.

| Node | Fields |
| --- | --- |
| `heading` | `text` |
| `text` | `text`; `tone`: `muted`, `warn`, `good`, `mono`; `linkRefs: true` turns part names on the board into links |
| `ref` | `ref`, `label`: a link that selects the part |
| `list` | `items` (texts), `linkRefs` |
| `row` | `children` (nodes side by side) |
| `button` | `id`, `label` |
| `input` | `id`, `submit` (button text), `label`, `placeholder`, `value`, `multiline` |
| `divider` | — |

Clicks and submitted text arrive as `panel:action` (`{ panel, id, value }`), to your mod only.
At most 300 nodes per panel; texts are clipped at 8,000 characters.

An **instrument** is a panel that listens to `bench:solved` and `probe:placed`.

## Events

| Event | Payload |
| --- | --- |
| `board:loaded` | `{ title, netlist }` |
| `power:changed` | `{ on, nets }` (volts by net name while on) |
| `bench:solved` | `{ nets, parts }` after each solve, at most four times a second |
| `probe:placed` | `{ red, black }`: net names (or `#id`) under the probes |
| `measure:taken` | `{ mode, red, black, text }`: what the meter shows |
| `tests:run` | `{ passed, results: [{ label, passed, detail }] }` |
| `flag:unlocked` | `{ title }` |
| `panel:action` | `{ panel, id, value }`, for your panels |

## Queries

`api.queries` answers from the latest board your mod has seen:

| Query | Returns |
| --- | --- |
| `findRef(q)` | `{ found: true, part }`, or `{ found: false, matches }` with near matches. Never throws: use it to keep a coach from inventing part names. |
| `parts()` | All parts. |
| `pinsOfNet(net)` | `[{ ref, pad, role }]` for a net name or id. |
| `netOfPin(ref, pad)` | The net's name (or id), or `null`. |
| `railState(net)` | `{ volts, powered }` from the last power event. |

## Permissions

| Permission | Allows |
| --- | --- |
| (none) | Registering solvers and importers, events, queries, logging. |
| `panel` | Panels, `ui.zoomTo`, `ui.say`. |
| `storage` | `api.storage` (64 KB). |
| `network:localhost` | `http://127.0.0.1` and `http://localhost` only: a server on the player's own computer. |
| `network:https://host` | One named HTTPS site, e.g. `network:https://api.example.org`. |

The sandbox has no origin of its own, so a server must answer cross-origin requests
(`Access-Control-Allow-Origin: *`). On the website Chrome may ask the player before a page reaches
the local network.

## Example: a local coach

`local-coach` shows the pattern for anything that talks to a language model:

1. `api.register.panel('coach', …)` with an input and settings (endpoint, model) kept in `api.storage`.
2. It listens to `board:loaded`, `tests:run`, `bench:solved` and `measure:taken` to know the bench.
3. On `panel:action` it builds a context (parts and their nets from `api.queries`, failing tests,
   readings) and `fetch`es an OpenAI-compatible `/v1/chat/completions` on `127.0.0.1`.
4. **Grounding:** every designator-shaped word in the answer goes through `api.queries.findRef`;
   names the board doesn't have are replaced by `[?]`, and the panel says how many. The panel
   shows the answer with `linkRefs`, so only real parts become links.

With Ollama: run it with `OLLAMA_ORIGINS=*`, pull a model, and set the endpoint
`http://127.0.0.1:11434/v1/chat/completions` and the model in the panel.

## Testing

- **In the app:** install the `.zip`, switch on code mods, and press **Bench check** on the mod's
  card. `api.log` writes to the browser console (`[mod <id>] …`).
- **On the command line:** `npm run bench-check -- path/to/my-mod --run-code` in the DEADBOARD
  repository. This runs your code **without the sandbox**: only for your own mods.
- **Types:** the package `@deadboard/mod-api` (`packages/mod-api` in the repository). TypeScript:
  `import type { ModApi } from '@deadboard/mod-api'` in your sources (the bundle you ship must not
  contain it); plain JavaScript: `/// <reference types="@deadboard/mod-api/global" />` and
  `DeadboardMod.ModApi`. Use `"lib": ["es2022", "webworker"]`.

## Versions

The plug-in API is versioned: this app has the version below. A mod names the range it was written
for (`"api": "^1"`); the app refuses a major it doesn't have, with a message, instead of loading
the mod and failing later. A major version stays supported for a long time after the next one.

## API types

<!-- generated:api-types -->
<!-- Written by npm run docs from the code; edit the code, not this block. -->

Plug-in API 1.0.0, as `@deadboard/mod-api` ships it (`index.d.ts`):

```ts
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
```

<!-- /generated:api-types -->
