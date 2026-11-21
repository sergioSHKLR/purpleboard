# Making DEADBOARD mods: a guide for AI agents

You are an AI agent asked to make a mod for DEADBOARD, a board-level repair trainer in the browser
(https://deadboard.org). This page is the compact, exact spec. Full human docs:
[Make your own boards](MODDING.md), [Mod reference](MOD_REFERENCE.md), [Code mods](CODE_MODS.md).

## Output

A folder (zip it to share) with `mod.json` at the top, plus any files it names. Prefer a **data
mod** (no `code`): it runs everywhere and can't fail the sandbox rules. Make a code mod only for a
new solver, importer or panel.

## Procedure

1. Pick what the mod adds (table below) and the boards it builds on.
2. Write `mod.json` with `"format": "deadboard-mod/2"` (use `/1` only for plain boards).
3. List every mod whose items you use in `requires` (shipped content: `official-*`, range `"^1.0"`).
4. Validate: in a checkout of https://github.com/tholtman1-del/deadboard run
   `npm install && npm run bench-check -- path/to/mod [paths of mods it needs]`. Fix every `✗`;
   read every `!`. Errors in `mod.json` are listed all at once.
5. Zip the folder (`mod.json` at the zip's top, or in one top-level folder).

## Hard rules

- `id`: `^[a-z0-9][a-z0-9._-]{1,63}$`, never starting with `official-`. Item ids: same pattern.
- `version`: `MAJOR.MINOR.PATCH` in `/2`.
- `license`: an SPDX id (`CC0-1.0`, `CC-BY-4.0`, `MIT`, …).
- Addresses: `<mod id>/<type>/<item id>`; the mod must be in `requires` (or be this mod).
- Paths: relative, `/`, case-sensitive, never `..`.
- Boards can be patched only in `title`, `description`, `difficulty`, `hints`, `objectives`, `solver`.
- A puzzle's board must be a working board (no flag) or a shipped board.
- Severities must be inside the catalogue's ranges (see the reference's fault class table).
- Code: one file whose only export is `export default function activate(api)`. The words
  `import` and `export` must not appear anywhere else, including comments and strings. No `eval`.
  Name an importer's method `read`.
- Never invent part refs: use refs that exist on the target board (open it in the app's Inspector,
  or read its file).

## Schemas

TypeScript notation; `?` = optional. Strings have length limits; numbers must be finite.

```ts
interface ModJson {
  format: 'deadboard-mod/1' | 'deadboard-mod/2';
  id: string; name: string; license: string;
  version?: string; author?: string; description?: string; homepage?: string /* https:// */;
  boards?: Board[];                        // required in /1
  requires?: Record<string, string>;       // mod id → version range: "^1.0", "~1.2.3", ">=1 <2", "*"
  conflicts?: Record<string, string>;
  patches?: Patch[]; knowledge?: Knowledge[]; puzzles?: Puzzle[];
  devices?: Device[]; faultTypes?: FaultType[]; meters?: Meter[]; rules?: Rule[];
  code?: { entry: string /* .js */; api: string /* "^1" */; permissions?: Permission[] };
}
type Permission = 'panel' | 'storage' | 'network:localhost' | `network:https://${string}`;

interface Board {
  file: string;            // .kicad_pcb | .brd | .tvw | .pcbfix.json
  id?: string; title?: string; description?: string; difficulty?: 1 | 2 | 3 | 4 | 5;
  hints?: string[];        // ≤ 10
  bom?: string;            // CSV/TSV path
  schematic?: string;      // .pdf .png .jpg .webp .svg
  objectives?: Objective[];
  solver?: 'fast' | 'spice' | 'spice-power' | string /* solver address */;
  credits?: string; license?: string; source?: string /* https:// */;
}
type Objective =
  | { type: 'led'; ref: string; on: boolean; switches?: Record<string, boolean> }
  | { type: 'voltage'; a: string; b?: string; min: number; max: number; switches?: Record<string, boolean> };

interface Patch { target: string /* address */; set: Record<string, unknown> /* JSON merge patch */; why?: string }

interface Knowledge {
  id: string; board: string /* address */; title?: string;
  rails?: { net: string; nominal?: number; domain?: string; source?: { ref: string; kind?: string };
            checks?: { at: string; pin?: string; expect: string; readsLowIf?: string }[];
            notes?: string; provenance?: Provenance }[];
  powerUp?: string[]; notes?: string[]; provenance?: Provenance;
}
interface Provenance { confidence: 'documented' | 'derived' | 'estimated'; kind?: string; where?: string }

interface Puzzle {
  id: string; board: string /* address */; title: string;
  description?: string; difficulty?: number; hints?: string[]; objectives?: Objective[];
  faults: { ref: string; fault: FaultClass | string /* fault type address */; severity?: number; pad?: string }[]; // 1–10
  flag?: string;
}
type FaultClass = 'mlcc-dead-short' | 'cap-partial-short' | 'liquid-leakage' | 'resistor-drift'
  | 'cap-capacitance-loss' | 'cold-joint' | 'open-part' | 'ic-rail-short' | 'net-break'
  | 'thermal-open-joint' | 'thermal-leak' | 'flex-open-joint' | 'flex-close-joint';

interface Device {
  mpn: string; description?: string; pkg?: string; verified?: boolean /* true needs source */;
  source?: string; note?: string; thetaJA?: number;
  units: ( { kind: 'nmos' | 'pmos'; vth: number; rds: [number, number][]; body?: [number, number]; caps?: [number, number, number]; pins: { D: string; G: string; S: string } }
         | { kind: 'npn' | 'pnp'; hfe: number; vbe: [number, number]; vaf?: number; pins: { C: string; B: string; E: string } }
         | { kind: 'diode' | 'schottky' | 'zener' | 'led' | 'tvs-bi'; vf: [number, number][]; bv?: [number, number]; cj?: number; pins: { A: string; K: string } } )[];
}

interface FaultType {
  id: string; name: string; description?: string;
  applies: { kinds?: PartKind[]; minPads?: number; needsNet?: boolean; railToGround?: boolean };
  effects: ( { do: 'leak'; ohms: Range; between?: [string, string] | 'rail-ground' }
           | { do: 'drift'; factor: Range } | { do: 'cold'; pad?: string; ohms?: Range } | { do: 'open' }
           | { do: 'break'; pad?: string } | { do: 'residue'; amount: number; leaky?: boolean }
           | { do: 'warm-open'; pad?: string; temp: Range } | { do: 'warm-leak'; temp: Range }
           | { do: 'flex-open' | 'flex-close'; pad?: string; level: Range } )[];   // 1–6
}
interface Range { min: number; max: number; dist?: 'log' | 'lin' }
type PartKind = 'resistor' | 'capacitor' | 'led' | 'diode' | 'battery' | 'switch' | 'fuse' | 'testpoint' | 'ic' | 'connector' | 'generic';

interface Meter { id: string; name?: string; counts?: number; vInputOhms?: number; vGainError?: number; noiseCounts?: number;
  ohmRanges?: { fullScale: number; itest: number; voc: number }[]; leadOhms?: number; contactOhms?: [number, number];
  beepOhms?: number; diode?: { itest: number; voc: number; olVolts: number } }

interface Rule {
  id: string;
  when: 'dead' | 'low' | 'high' | 'short' | 'hot' | 'dark' | 'tested';
  suspect: { where: 'on-net' | 'series' | 'feeds-net' | 'the-part'; kinds?: PartKind[] };
  weight?: number /* 1–10 */; confirm: string /* {net} {ref} filled in */; why?: string;
}
```

Patchable fields per target type: devices: `description pkg units verified source thetaJA note`;
official fault classes: `range`; mod fault types: `name description applies effects`; meters: all
fields; rules: `when suspect weight confirm why`.

## Templates

A patch to a shipped board:

```json
{
  "format": "deadboard-mod/2", "id": "my-ghost-short-notes", "name": "Ghost Short notes", "version": "1.0.0", "license": "CC0-1.0",
  "requires": { "official-boards": "^1.0" },
  "patches": [ { "target": "official-boards/boards/builtin-ghost-short", "set": { "difficulty": 5 }, "why": "harder" } ]
}
```

A puzzle on a shipped board, with a flag:

```json
{
  "format": "deadboard-mod/2", "id": "my-dark-led", "name": "Dark LED", "version": "1.0.0", "license": "CC0-1.0",
  "requires": { "official-boards": "^1.0" },
  "puzzles": [ { "id": "dark", "board": "official-boards/boards/builtin-ghost-short", "title": "Dark",
                 "faults": [ { "ref": "D1", "fault": "open-part" } ], "flag": "DEAD{example}" } ]
}
```

A code mod skeleton (a panel):

```json
{ "format": "deadboard-mod/2", "id": "my-panel", "name": "My panel", "version": "1.0.0", "license": "MIT",
  "code": { "entry": "main.js", "api": "^1", "permissions": ["panel"] } }
```

```js
/// <reference types="@deadboard/mod-api/global" />
/** @param {DeadboardMod.ModApi} api */
export default function activate(api) {
  api.register.panel('main', { title: 'My panel', content: [{ type: 'text', text: 'Open a board.' }] });
  api.on('board:loaded', (p) => api.panels.set('main', [{ type: 'text', text: `${p.title}: ${p.netlist.parts.length} parts` }]));
}
```

## Common errors

| Message contains | Fix |
| --- | --- |
| `must be listed in "requires"` | Add the owning mod to `requires`. |
| `"version" must look like 1.2.0` | Use three numbers in `/2`. |
| `must be a version range` | `"^1.0"`, `"~1.2.3"`, `">=1.0"`, `"1.2.3"` or `"*"`. |
| `doesn't fit <ref>` | The fault class doesn't apply to that part; the message lists those that do. |
| `severity must be a number from` | Use the range the message gives. |
| `is a challenge whose repair isn't known` | Base the puzzle on a working or shipped board. |
| `can't use import` / `only export is` | Bundle to one file with a single `export default`; remove the words elsewhere (comments too). |
| `needs the "panel" permission` | Add `"panel"` to `code.permissions`. |
| `the working board fails the puzzle's tests` (bench check) | Your `objectives` can't pass even when repaired; fix them. |
| `the faults don't show` (bench check) | Pick a fault or severity the tests detect. |

## Where things are

Item addresses of everything shipped (boards, devices, fault classes, rules, the meter):
[Mod reference → Official items](MOD_REFERENCE.md#official-items). API types for code mods:
[Code mods → API types](CODE_MODS.md#api-types). Examples to copy:
https://deadboard.org/examples/starter-kit.zip, night-light-extras.zip, repair-lab.zip, ideal-dc.zip,
local-coach.zip, board-notes.zip (knowledge packs for every shipped board).
