# Make your own boards: the DEADBOARD modding guide

A **mod** adds boards to DEADBOARD: your own designs, open-hardware boards you converted, or repair
challenges you built. Each board can bring its **BOM** (part values) and its **schematic**, which
players can open next to the board while they probe.

Mods are plain files: a folder (or a `.zip` of it) with one small text file, `mod.json`, that lists
your boards. Mods contain no code, so installing someone else's mod is safe.

You don't need to be a programmer. If you can export a file from KiCad and edit a few lines of text,
you can make a mod.

## Try a mod first

1. Download the example mod: [starter-kit.zip](https://deadboard.org/examples/starter-kit.zip).
2. Open the bench and click the board name at the top left to open the board list. Click **Mods**,
   then **Install mod (.zip)**, and pick the file. Dropping the `.zip` onto the bench works too.
3. The new boards show up under **Community Mods** in the board list. Open **Night light (sandbox)**
   and click **Schematic** in the Overview tab to see the schematic next to the board.

On the website, installed mods are kept in your browser (they stay after a reload; clearing site
data removes them). The desktop app keeps them too, and also reads a **mods folder** (see
[Where mods live](#where-mods-live)).

## Turn mods on and off

Every mod in the **Mods** window has an **On** switch. A mod that's off stays installed, but its
boards leave the board list until you turn it back on.

- **Loadouts** are saved sets of mods that are on. Pick one at the top of the Mods window:
  - **Official** is the game as shipped, with no community mods. Switching to it is the quick way
    back to normal, and nothing is uninstalled.
  - **My mods** is where you start: every mod you install is on.
  - **New loadout** copies the current one under a new name, e.g. one for hard challenges and one
    for teaching. Newly installed mods are on in every loadout except Official.
- **Safe mode:** if a mod makes the app misbehave, open `app.html?safe`. The app starts with no mods
  for that visit, and **Leave safe mode** in the Mods window goes back. If the app didn't finish
  starting last time while mods were on, it starts in safe mode by itself and tells you.

When a mod can't run, its card says why: it may need another mod that's missing, too old or turned
off, or it may not work together with a mod you have. Each line has a button to fix it: **Find on
mod.io** or **Turn on**.

## The fastest way: export from the bench

Every board you can open in DEADBOARD can become a mod without touching any file.

1. **Get the board on the bench.** Drop a KiCad `.kicad_pcb` file or a boardview `.brd` onto the
   bench. Check that the parts look right and that the board powers up.
2. **Make it a challenge (optional).** In the **Author** tab:
   - give it a title, your name, a difficulty and a description of the customer's complaint;
   - add **objectives**, the tests a repaired board must pass ("D1 is on when SW1 is pressed",
     "the 3.3 V rail reads 3.2–3.4 V");
   - type a **flag** and press **Lock reference topology & flag** while the board still works: the
     flag is encrypted with the working circuit, so only a real repair unlocks it;
   - break the board: inject faults (cold joints, shorted capacitors, drifted resistors…) or do the
     damage by hand with the tools.
3. Press **Export as mod (.zip)** (Author tab, or **Mods → Current board as a mod** in the board list).
4. Open the `.zip`, check `mod.json` (name, author, licence), and share it.

The rest of this guide is for when you want more: several boards in one mod, a BOM, a schematic, or
an imported board without a challenge.

## What's in a mod

```
my-mod/
├── mod.json                    ← the list of boards (required)
└── boards/
    ├── amp.kicad_pcb           ← a board: .kicad_pcb, .brd or .pcbfix.json
    ├── amp-bom.csv             ← optional: part values for that board
    ├── amp-schematic.pdf       ← optional: schematic shown next to the board
    └── amp-repair.pcbfix.json  ← a challenge exported from the Author tab
```

Folder and file names are up to you; `mod.json` must sit at the top. Names are case-sensitive:
`Amp.pdf` and `amp.pdf` are different files.

To share the mod, zip the folder. A zip that contains the `my-mod` folder works, and so does a zip
of just its contents.

## mod.json

A complete example, from the starter kit:

```json
{
  "format": "deadboard-mod/1",
  "id": "starter-kit",
  "name": "Starter kit",
  "version": "1.0.0",
  "author": "DEADBOARD",
  "description": "An example mod to copy: one KiCad board with its BOM and schematic, and the same board as a repair challenge.",
  "license": "CC0-1.0",
  "homepage": "https://github.com/tholtman1-del/deadboard/tree/main/examples/mods/starter-kit",
  "boards": [
    {
      "id": "night-light",
      "file": "boards/night-light.kicad_pcb",
      "title": "Night light (sandbox)",
      "description": "A two-AA night light: push SW1 and D1 lights.",
      "difficulty": 1,
      "bom": "boards/night-light-bom.csv",
      "schematic": "boards/night-light-schematic.svg",
      "objectives": [
        { "type": "led", "ref": "D1", "on": true, "switches": { "SW1": true } },
        { "type": "led", "ref": "D1", "on": false, "switches": { "SW1": false } }
      ]
    },
    {
      "id": "night-light-repair",
      "file": "boards/night-light-repair.pcbfix.json",
      "schematic": "boards/night-light-schematic.svg"
    }
  ]
}
```

### The mod

| Field | Required | What it is |
| --- | --- | --- |
| `format` | yes | Always `"deadboard-mod/1"`. |
| `id` | yes | A unique name for your mod: lowercase letters, digits, `-`, `_` or `.`, 2–64 characters. Put your name in it (`jane-audio-boards`) so it doesn't clash with other people's mods. Keep it the same in every version: a mod with the same id **replaces** the installed one. |
| `name` | yes | What players see. |
| `license` | yes | The licence of your mod's files, as an [SPDX id](https://spdx.org/licenses/): `CC-BY-4.0`, `CC0-1.0`, `CERN-OHL-S-2.0`, `MIT`… |
| `version` | no | Your version number, shown in the Mods window. Default `1.0.0`. |
| `author` | no | Your name or handle. Default `anonymous`. |
| `description` | no | A sentence or two about the mod. |
| `homepage` | no | An `https://` link: your repository, forum post or page. |
| `boards` | yes | The list of boards (at least one). |

### Each board

| Field | Required | What it is |
| --- | --- | --- |
| `file` | yes | Path to the board file inside the mod: `.kicad_pcb` (KiCad layout), `.brd` (boardview) or `.pcbfix.json` (exported from the Author tab). |
| `id` | no | Unique within the mod. Default: the file name. |
| `title` | no* | Name in the board list. *Give imported boards a title: then large boards load only when a player opens them, so the list stays fast. |
| `description` | no | What's wrong with the board, or what to explore. |
| `difficulty` | no | 1 (beginner) to 5 (expert). |
| `hints` | no | Up to 10 hints. Players reveal them one at a time under **Notes** in the Overview tab. |
| `bom` | no | A BOM file that sets part values (see [BOM](#bom-part-values)). |
| `schematic` | no | A schematic players can open next to the board: `.pdf`, `.png`, `.jpg`, `.webp` or `.svg`. |
| `objectives` | no | Tests for an imported board (see below). Challenges exported from the Author tab already carry theirs. |
| `solver` | no | `"fast"`, `"spice"` or `"spice-power"`. Use `"spice-power"` for boards with regulators and power sequencing. |
| `credits`, `license`, `source` | no | Attribution for a board you didn't design (see [Licences](#licences-and-other-peoples-boards)). `source` must be an `https://` link. |

A `.pcbfix.json` challenge keeps its own title, description, hints and flag. Anything you set in
`mod.json` overrides the title, description, difficulty and hints, never the flag.

### Objectives

Objectives are the checks behind **Run tests**. Two kinds:

```json
{ "type": "led", "ref": "D1", "on": true, "switches": { "SW1": true } }
{ "type": "voltage", "a": "C29", "min": 3.2, "max": 3.4 }
```

- `led`: LED `ref` must be on (`"on": true`) or off. `switches` sets switches first (`true` = pressed / closed).
- `voltage`: the voltage at pin 1 of part `a` (against ground, or against pin 1 of part `b`) must be
  between `min` and `max` volts. Pick a capacitor on the rail you care about, and check in the
  **Inspect** tab that its pin 1 is the rail side, not the ground side.

The easiest way to get them right is to add them in the Author tab and export, then copy them.

## Mods that need other mods

A mod can build on another mod: extra challenges for someone else's board, or a **pack** that only
lists mods to install together. This needs `"format": "deadboard-mod/2"`:

```json
{
  "format": "deadboard-mod/2",
  "id": "jane-night-light-challenges",
  "name": "Night light: three more faults",
  "version": "1.0.0",
  "license": "CC-BY-4.0",
  "requires": { "starter-kit": "^1.0" },
  "conflicts": { "old-night-light-pack": "*" },
  "boards": [ { "file": "boards/flicker.pcbfix.json" } ]
}
```

| Field | What it is |
| --- | --- |
| `version` | Must be three numbers, `MAJOR.MINOR.PATCH` (`1.0.0`, `2.3.1`). Raise MAJOR when a change could break mods that use yours. |
| `requires` | Mods this one needs, with the versions that work: `"^1.2"` = 1.2 or newer but below 2.0, `"~1.2.3"` = 1.2.x from 1.2.3, `">=1.0"`, an exact `"1.2.3"`, or `"*"` for any. |
| `conflicts` | Mods this one can't run next to, with versions. If both are on, yours steps aside and says why. |
| `boards` | As before. A pack may leave `boards` out completely and only list mods in `requires`. |

A mod whose needs aren't met doesn't half-load. It stays installed and its card lists what's
missing (see [Turn mods on and off](#turn-mods-on-and-off)).

Fields that later versions of DEADBOARD will read (planned in
[MOD_PLATFORM.md](https://github.com/tholtman1-del/deadboard/blob/main/docs/MOD_PLATFORM.md)) are
shown as warnings and ignored, so a `/2` mod made for a newer app still loads here.

Keep `deadboard-mod/1` if you don't need any of this: every version of the app reads it, and the
**Export as mod** button still writes `/1`.

A `/2` mod can also bring the three kinds of content below. None of them needs a board file, so a
mod can be nothing but notes, a knowledge pack or a few puzzles for boards someone else made. The
example [night-light-extras.zip](https://deadboard.org/examples/night-light-extras.zip) uses all
three. Install it after the starter kit.

### Addresses

Every board has an **address**: `<mod id>/boards/<board id>`. The boards that ship with the game
belong to the mod `official-boards` and use their built-in ids:

| Board | Address |
| --- | --- |
| A board in your own mod | `my-mod/boards/amp` |
| The starter kit's sandbox | `starter-kit/boards/night-light` |
| Ghost Short (built in) | `official-boards/boards/builtin-ghost-short` |

To use another mod's board, list that mod in `requires` (`"official-boards": "^1.0"` for the built-in
ones). The **Mods** window shows the official boards at the top.

## Change another mod's board (patches)

A patch changes a board's text or tests without copying the board:

```json
"patches": [
  {
    "target": "official-boards/boards/builtin-ghost-short",
    "set": { "difficulty": 5, "hints": ["First note…", "Second note…"] },
    "why": "Harder version for my repair class."
  }
]
```

- You can change `title`, `description`, `difficulty`, `hints`, `objectives` and `solver`. The board
  itself (parts, copper, faults) and its flag can't be patched.
- `set` merges into the board: fields you leave out stay as they are. A list (`hints`, `objectives`)
  is replaced as a whole, so to add a note, list the existing notes too. `null` removes a field.
- `why` is shown to players in the Mods window next to the change.
- If two mods change the same field, the one loaded later wins, and the Mods window says so. A
  patch that would leave the board invalid (difficulty 9, a test without a part) is skipped and
  the reason is shown.
- Turning your mod off undoes its patches.

## Knowledge packs

What a repair technician knows about a board but the board file doesn't say: which rails there
are, what makes them, what to expect where. Players see it in the **Overview** tab under **Board
knowledge**, and clicking a part name selects it on the board.

```json
"knowledge": [
  {
    "id": "night-light-rails",
    "board": "starter-kit/boards/night-light",
    "provenance": { "kind": "schematic", "where": "night-light-schematic.svg", "confidence": "documented" },
    "rails": [
      {
        "net": "VBAT",
        "nominal": 3.0,
        "source": { "ref": "BT1", "kind": "2 × AA" },
        "checks": [ { "at": "BT1", "expect": "2.8–3.2 V", "readsLowIf": "flat cells or corroded contacts" } ]
      }
    ],
    "powerUp": ["VBAT"],
    "notes": ["R2 is not fitted."]
  }
]
```

| Field | What it is |
| --- | --- |
| `board` | The board's address. |
| `rails` | Each rail: `net` (its net name on the board), `nominal` volts, `domain` (e.g. "always on"), `source` (`ref` of the part that makes it, optional `kind`), `checks` (where to measure: `at` a part, optional `pin`, `expect` as text, `readsLowIf`), `notes`. |
| `powerUp` | Rail nets in the order they come up. |
| `notes` | Anything else worth knowing. |
| `provenance` | How sure you are: `confidence` is `documented` (read from a schematic or datasheet), `derived` (worked out from the board) or `estimated` (a guess), with optional `kind` and `where`. Set it on the pack, and on a rail when that rail differs. |

Part refs and net names are checked against the board. Ones the board doesn't have (a pack written
for another revision) are struck through and listed under **Not on this board**.

## Puzzles

A puzzle is a repair challenge written as a recipe: a working board, the faults to plant and the
story. The simulator does the physics, so the puzzle behaves like any other board on the bench.

```json
"puzzles": [
  {
    "id": "barely-glows",
    "board": "starter-kit/boards/night-light",
    "title": "Night light · barely glows",
    "description": "Press the button and D1 hardly lights. The batteries are new.",
    "difficulty": 2,
    "hints": ["Measure R1 with the power off."],
    "faults": [ { "ref": "R1", "fault": "resistor-drift", "severity": 25 } ],
    "flag": "DEAD{dr1ft3d_r3s1st0r}"
  }
]
```

- `board` must be a **working** board: one without a flag (like the starter kit's sandbox or an
  imported design), or a built-in board (the game knows how each one looks repaired). A community
  challenge with a flag can't be a puzzle base.
- `faults` (1 to 10): `ref` is the part, `fault` one of `mlcc-dead-short`, `cap-partial-short`,
  `liquid-leakage`, `resistor-drift`, `cap-capacitance-loss`, `cold-joint`, `open-part`,
  `ic-rail-short`, `net-break`, `thermal-open-joint`, `thermal-leak`, `flex-open-joint`,
  `flex-close-joint`. `severity` is optional and must be inside the range the Author tab shows for
  that fault (a resistor drifts ×1.5 to ×30, for example). `pad` names a pad (`"2"`) for joint faults.
- `objectives` is optional: by default the puzzle uses the board's own tests.
- `flag` is optional. It unlocks only after a real repair, like a flag locked in the Author tab.
  It's readable in `mod.json`, so treat it as a reward, not a secret.
- The puzzle is built when a player opens it. If a fault doesn't fit (no such part, a resistor
  fault on an LED), the message says which and what fits instead.

## Device models

The SPICE solvers model diodes, LEDs, transistors and MOSFETs from their **datasheet numbers**,
looked up by the part number on the board (the KiCad value field, a BOM part number, the boardview
label). The built-in library belongs to the mod `official-solvers`. A mod can add parts it lacks,
or change one of its entries:

```json
"devices": [
  {
    "mpn": "2N7002K",
    "description": "N-MOSFET 60 V",
    "pkg": "SOT-23",
    "source": "onsemi 2N7002K/D Rev. 9",
    "verified": true,
    "units": [ { "kind": "nmos", "vth": 1.6, "rds": [[10, 1.6], [4.5, 2.0]], "body": [0.8, 0.115], "pins": { "G": "1", "S": "2", "D": "3" } } ]
  }
],
"patches": [
  { "target": "official-solvers/devices/bss138pw", "set": { "units": [ … ] }, "why": "worst-case part" }
]
```

| Unit `kind` | Numbers |
| --- | --- |
| `nmos`, `pmos` | `vth` (|Vgs(th)| in V), `rds` (1–4 points `[ohms, |Vgs|]`), optional `body` (`[|Vsd|, |Is|]`), `caps` (`[Ciss, Crss, Coss]` in F), `pins` `D` `G` `S` |
| `npn`, `pnp` | `hfe`, `vbe` (`[V, Ic]`), optional `vaf`, `pins` `C` `B` `E` |
| `diode`, `schottky`, `zener`, `led`, `tvs-bi` | `vf` (1–6 points `[V, A]`), optional `bv` (`[V, A]` at breakdown), `cj` (F), `pins` `A` `K` |

- `pins` are datasheet pin numbers. A package with several parts (a dual MOSFET) lists one unit each.
- `verified: true` needs a `source`: the datasheet, with maker, document and revision. Leave it
  `false` for numbers you estimated.
- The address of a library part is `official-solvers/devices/<part number in lowercase>` (other
  characters become `-`). Add `"official-solvers": "^1.0"` to `requires` to patch one.
- A patch that changes a verified part's numbers without giving its own `source` makes it
  unverified, and its note says which mod changed it.
- Every model is fitted when the mod loads; one that can't be fitted is refused with the reason,
  so it never reaches a solve.
- Device models apply to **every board** that uses the part while the mod is on. Run the
  [bench check](#test-your-mod) to see which boards that changes.

A board's `solver` can also be written as an address: `official-solvers/solvers/fast`,
`…/spice` or `…/spice-power`.

## Fault types

The faults the Author tab and puzzles plant come from the mod `official-faults`. A mod can add new
ones, as data, by combining **effects**:

```json
"faultTypes": [
  {
    "id": "salt-water",
    "name": "Salt-water damage",
    "applies": { "kinds": ["resistor", "capacitor", "diode", "led"], "minPads": 2 },
    "effects": [
      { "do": "leak", "ohms": { "min": 300, "max": 30000 } },
      { "do": "residue", "amount": 0.8, "leaky": true }
    ]
  }
]
```

| Effect | What it does |
| --- | --- |
| `leak` | A resistance across the part (`ohms` range; `between`: two pad names, or `"rail-ground"` for a chip's supply pin to ground). |
| `drift` | Multiplies the value (`factor` range). |
| `cold` | A cold joint on a pad (`pad` name, random if left out); with `ohms` it's resistive, without it's open. |
| `open` | The part is open (damaged). |
| `break` | Broken copper near a pad: only a jumper wire fixes it. |
| `residue` | Visible corrosion (`amount` 0–1); `"leaky": true` makes it the cause of the leak, so cleaning with IPA repairs it. |
| `warm-open`, `warm-leak` | Intermittent: opens / leaks above a temperature (`temp` range, °C). |
| `flex-open`, `flex-close` | Intermittent: opens on flex / only conducts while pressed (`level` range, 0–1). |

`applies` says which parts it fits: `kinds`, `minPads`, `needsNet` (a pad with a named net),
`railToGround` (a chip with power and ground pins). Ranges are `{ "min", "max" }`, sampled
log-uniformly (add `"dist": "lin"` for linear); the first effect with a range takes the severity an
author types in. A puzzle uses a mod's fault type by address:
`{ "ref": "R2", "fault": "repair-lab/faultTypes/salt-water", "severity": 2000 }`.

The built-in classes' severity ranges can be patched (`"official-faults": "^1.0"` in `requires`):
`{ "target": "official-faults/faultTypes/mlcc-dead-short", "set": { "range": { "min": 0.02, "max": 0.5 } } }`.
The bench check plants a new fault type on every part it fits across the working boards and says
how often it shows on the bench.

## Meters

The multimeter's behaviour is a profile in the mod `official-instruments`
(`official-instruments/meters/generic`). A mod can patch it or add meters, which players then pick
under **Bench → Meter**:

```json
"meters": [ { "id": "budget-2000", "name": "Budget 2000-count", "counts": 2000, "vInputOhms": 1000000, "vGainError": 0.008 } ]
```

Fields: `counts`, `vInputOhms` (voltage input impedance), `vGainError` (fraction of the reading),
`noiseCounts`, `ohmRanges` (`[{ fullScale, itest, voc }]`, increasing), `leadOhms`, `contactOhms`
(`[min, max]`), `beepOhms`, `diode` (`{ itest, voc, olVolts }`). Fields you leave out are the
official meter's.

## Rules (Where to look?)

After a failed test run, **Where to look?** in the Overview tab compares the board with its working
version and ranks the parts worth measuring first, with the measurement that would confirm each.
It runs on **rules**, which are data: the mod `official-rules` ships a baseline, and a mod can add
rules or patch theirs (`weight`, `confirm`…):

```json
"rules": [
  {
    "id": "supply-joint",
    "when": "low",
    "suspect": { "where": "on-net", "kinds": ["battery", "connector"] },
    "weight": 8,
    "confirm": "Measure the supply at {ref}'s pins and on the board side of its joints."
  }
]
```

| Field | Values |
| --- | --- |
| `when` | What the bench shows: `dead`, `low`, `high` (a net against the working board), `short` (a rail to ground, power off), `hot` (a part), `dark` (an LED that should light), `tested` (a part a failing test names). |
| `suspect.where` | `on-net` (parts on that net), `series` (two-terminal parts between it and another net), `feeds-net` (those on the side nearer the supply), `the-part` (for `hot`, `dark`, `tested`). |
| `suspect.kinds` | Optional part kinds. |
| `weight` | 1–10. A rule that points at a single part counts more than one that points at many. |
| `confirm` | What to measure; `{net}` and `{ref}` are filled in. |

The bench check runs the **recall test**: every fault from the catalogue planted on every part of
the small working boards; for each one that shows on the bench, is the planted part among the top 3
suggestions? It reports the score with and without your rules. The official rules find 115 of 120;
the example mod's one extra rule makes it 120.

## Code mods

Everything above is data. A **code mod** brings a program: today, a **circuit solver** that
players can pick instead of the official ones. Code mods are **experimental** and off until a
player turns them on (**Mods → Code mods**). They don't run in the iOS app.

Try the data example [repair-lab.zip](https://deadboard.org/examples/repair-lab.zip) for fault
types, meters and rules. For code, try the example first: [ideal-dc.zip](https://deadboard.org/examples/ideal-dc.zip), a small DC
solver in plain JavaScript (resistors, batteries, switches, fuses, diodes and LEDs). Install it, turn
on code mods, press **Use** on its card, then power a board and run the tests.

```json
{
  "format": "deadboard-mod/2",
  "id": "my-solver",
  "name": "My solver",
  "version": "1.0.0",
  "license": "MIT",
  "code": { "entry": "main.js", "api": "^1", "permissions": [] }
}
```

`main.js` is one JavaScript module whose default export receives the API:

```js
/// <reference types="@deadboard/mod-api/global" />
/** @param {DeadboardMod.ModApi} api */
export default function activate(api) {
  api.register.solver('my-solver', {
    name: 'My solver',
    solve({ netlist, meters }) {
      // netlist.nets: [{ id, name }]; netlist.parts: [{ ref, kind, value, pins: [{ pad, role, net, open, ohms }], … }]
      return { nets: { /* net id: volts */ }, parts: { /* ref: { i, v, p, on, over } */ } };
    },
  });
  api.on('board:loaded', ({ title }) => api.log('opened', title));
}
```

| In the API | What it does |
| --- | --- |
| `register.solver(id, { name, solve })` | Adds a solver, listed in the solver menu as `<mod id>/solvers/<id>`. `solve` gets the board as a netlist (pins with their electrical roles, open or resistive joints, leaks, switch positions already set) and returns volts per net and current / power / lit / overloaded per part. It may be `async`. |
| `on(event, handler)` | `board:loaded`, `power:changed`, `bench:solved` (volts per net and per-part current after each solve, a few times a second), `probe:placed`, `measure:taken`, `tests:run`, `flag:unlocked`, and `panel:action` for your panels. Read-only. An **instrument** is a panel that listens to these. |
| `queries` | `findRef`, `parts`, `pinsOfNet`, `netOfPin`, `railState`: questions about the open board. `findRef` never throws: with no exact match it returns the near ones. |
| `register.importer(id, { name, extensions, read })` | Opens files the game doesn't know (or a known ending its own importer refuses): `read({ name, bytes })` returns `{ kicadPcb: "…" }` (KiCad board text) or `{ pcbfix: { … } }` (a challenge object), which the game's own importers then check. Players just drop the file on the bench. |
| `register.panel(id, { title, content })`, `panels.set(id, content)` | A panel in the side panel's **Mods** tab (needs `panel`). Content is data the game draws itself: `heading`, `text` (with `linkRefs: true`, part names on the board become links), `ref`, `list`, `row`, `button`, `input` (with a submit button), `divider`. Clicks and submitted text come back as the `panel:action` event, to your mod only. |
| `ui.zoomTo(ref)`, `ui.say(text)` | Select and zoom to a part; show a short message (at most one a second). Needs `panel`. |
| `storage.get(key)`, `storage.set(key, value)` | A small store for your mod (64 KB), kept by the game. Needs `storage`. |
| `log(…)` | Writes to the browser's console, prefixed with your mod id. |

Types for your editor: the package `@deadboard/mod-api` (in the repository under `packages/mod-api`).

**The rules a code mod runs under:**

- It runs in a **sandbox**: a separate, locked-down frame and worker. It can't see the page,
  the player's files, saves or browser storage, or other mods. It talks to the game only through
  the API.
- **No network**, unless it asks for a permission and the player installs it knowing that:
  `network:localhost` (a server on the player's own machine, e.g. a local model) or
  `network:https://host` (one named site). The permissions are shown on install and on the mod's card.
  The sandbox has no origin of its own, so the server must answer cross-origin requests
  (`Access-Control-Allow-Origin: *`); Chrome may ask the player before a website reaches the
  local network.
- `panel` and `storage` permissions, as above.
- **One file, one export.** Bundle your code (esbuild, Rollup…) into a single file whose only
  export is `export default function activate(api)`. The game runs it as a plain script, so it
  can't load other code: the words `import` and `export` may not appear anywhere else in the file,
  not even in a comment or a string, and the game refuses a file that has them. (In Chrome, module
  loading inside a worker, `import()` or `export … from`, can reach the network despite the
  sandbox's rules, so the game doesn't use it at all.)
- **No `eval`, `new Function` or string timers.** WebAssembly is allowed.
- **Time limits:** `activate` must finish within 5 s and each solve within 10 s. A mod that runs
  over, throws while starting or answers garbage is stopped, and the game goes back to its own
  solver and says why.
- A solver can be wrong, and the game can't tell. So test results from a solver mod are labelled
  as such, and **a flag only unlocks after a real repair**: it's tied to the board's wiring, never
  to what a solver says.

**A coach: [local-coach.zip](https://deadboard.org/examples/local-coach.zip).** An example that
asks a language model running on the player's own computer (Ollama, llama.cpp, vLLM: anything with
an OpenAI-compatible `/v1/chat/completions`) about the board on the bench. It sends the parts and
their nets, the failing tests and the last readings with the question, and shows the answer in a
panel. Every part name in the answer is checked against the board first: names the board doesn't
have are removed, and the panel says how many. For Ollama: start it with `OLLAMA_ORIGINS=*`, pull
a model, and set the endpoint and model in the panel.

**Testing it:** press **Bench check** on the mod's card. For each solver it runs every working
board's tests and compares the voltages with the official solvers. From the command line:
`npm run bench-check -- path/to/my-solver --run-code`. That runs your code without the sandbox,
so use it only for your own mods.

A board can ask for your solver in `mod.json`: `"solver": "my-solver/solvers/my-solver"` (with
`my-solver` in `requires` when it's another mod). Players who don't run it get the official SPICE solver.

## BOM (part values)

Board files often lack part values: a boardview (`.brd`) has none at all, and KiCad boards sometimes
use `~` or library names. A BOM fills them in. Use the CSV your design tool exports (KiCad, Altium,
EasyEDA, Eagle, JLCPCB / PCBWay templates…); comma, semicolon and tab separators all work.

```csv
Reference,Value,Footprint,DNP
R1,68R,R_Axial_DIN0207,
R2,22R,R_Axial_DIN0207,DNP
C1-C4,100nF 16V X7R,C_0402,
```

- **Reference** (also `Designator`, `RefDes`…): one or more parts: `R1`, `R1, R2`, `R5-R7`.
- **Value** (also `Comment`): `10k`, `4k7`, `68R`, `0R`, `1M`, `100nF`, `4.7uF 10V`, `2.2uH 3A`.
- **DNP** (also `DNI`, `Do not place`, `Fitted`, `Populate`): parts marked not fitted are left off the board.
- A part with no label of its own gets the BOM value text as its label. Other columns (part number,
  footprint, description) are ignored for now.

DEADBOARD uses the BOM for resistor and capacitor values and for fitted / not fitted. Parts the BOM
doesn't mention keep what the board file says. A BOM where no designator matches the board is
reported as an error, so a wrong file is easy to spot.

## Schematics

Add a `schematic` to any board and players get a **Schematic** button in the Overview tab. It opens
a window over the bench that they can move and resize, so they can read the schematic while they
probe.

- **PDF** is best for real schematics: players can zoom and search part names.
- **PNG / JPG / WebP / SVG** work for one-page drawings. Click the image to zoom.

The schematic is for reading. Part values for the simulation come from the board file and the BOM.

## Test your mod

1. Install it (**Boards → Mods → Install mod**) or, in the desktop app, put the folder in the mods
   folder and reload (**Ctrl+R** / **Cmd+R**).
2. Open the **Mods** window. Problems are listed there:
   - a red card means the mod could not load at all (the message says why: usually a typo in `mod.json`);
   - **warnings** list boards or files that were skipped (missing files, a board id that's already in use).
3. Open every board. Press **Power on**, then **Run tests**: a challenge should fail before the repair
   and pass after it.
4. Press **Bench check** on the mod's card. It tests the mod on the simulator and lists what it found:
   - boards: a challenge must fail its tests as shipped, a board without a flag should pass them,
     and nothing may burn at power-up;
   - puzzles: the working board passes the tests, the puzzle fails them, each fault shows on its own;
   - patches: a working board still passes the patched tests;
   - knowledge packs: every part and net they name is on the board;
   - devices: every board that uses the part is solved with and without your mod, and the report
     lists the voltages that moved and any test that changes result.

   ✗ means players would hit a real problem; ! is worth a look. The same check runs on the command
   line: `npm run bench-check -- path/to/my-mod [mods it needs…]`.

Installing a mod with the same `id` again replaces the old version, so you can fix and re-install
as often as you like.

## Share it on mod.io

DEADBOARD's mod hub is on [mod.io](https://mod.io). Mods published there show up in the app under
**Boards → Mods → Browse mod.io**, where players install them with one click (no account needed).

1. Test the mod (above) and zip it: `mod.json` at the root of the `.zip`.
2. Sign in at mod.io, open DEADBOARD's page and choose **Add mod**.
3. Give it a name, a short summary and a logo (a 16:9 screenshot of the board works well), then
   upload the `.zip` as the mod's file. Fill in the version so players can tell releases apart.
4. To release a fix, upload a new file to the same mod.io page: players who installed it see an
   **Update** button.

Credit and licence rules (below) apply on mod.io too, and so do mod.io's
[Terms of Use](https://mod.io/terms). A mod.io page is only a wrapper: DEADBOARD reads the same
mod zip, so the mod still works when shared any other way.

### Common problems

| Message | Fix |
| --- | --- |
| `mod.json is not valid JSON` | A missing comma or quote. Paste the file into any JSON checker to find the line. |
| `"id" must be 2-64 characters…` | Use lowercase letters, digits and `-` only, no spaces. |
| `… not found (did you mean …?)` | File names are case-sensitive; the message suggests the right one. |
| `has no mod.json at its root` | The zip holds more than one folder level. Zip the mod folder itself. |
| `no designator matches a part` | The BOM belongs to another board, or its reference column has a different name. |
| `"version" must look like 1.2.0` | In a `deadboard-mod/2` mod the version needs all three numbers. |
| `"requires"."…" must be a version range` | Use `"^1.0"`, `"~1.2.3"`, `">=1.0"`, `"1.2.3"` or `"*"`. Words like `"latest"` don't work. |
| `"…" must be listed in "requires" to use its items` | Add the mod that owns the board to `requires`, e.g. `"official-boards": "^1.0"`. |
| `… doesn't fit R1 (fits: …)` when opening a puzzle | Pick a fault from the list in the message, or another part. |
| `… is a challenge whose repair isn't known` | Base the puzzle on a board without a flag, or a built-in board. |
| **Can't run: needs «…»** in the Mods window | Install the mod it names (or the version it asks for), or turn it on. |
| `a board with id "…" is already loaded` | Two mods contain the same board (remove one), or a challenge was saved from a built-in board without a flag of its own. Open it, lock your own flag in the Author tab and export again: it then gets its own id. |

## Where mods live

- **Website:** in your browser's storage, per browser. Remove a mod in the Mods window.
- **Desktop app** (coming soon): installed mods are stored the same way. You can also drop mod folders or `.zip`
  files into the **mods folder**; **Mods → Open mods folder** opens it:
  - Windows: `%APPDATA%\DEADBOARD\mods`
  - macOS: `~/Library/Application Support/DEADBOARD/mods`
  - Linux / Steam Deck: `~/.config/DEADBOARD/mods`

  Reload the app (**Ctrl+R** / **Cmd+R**) after changing files there. To remove a mod, delete it from
  the folder.
- **mod.io:** mods installed from **Browse mod.io** are stored like any installed mod.
- **Steam Workshop:** planned. Workshop mods will use this same format, so a mod you make now will
  work there unchanged.

## Licences and other people's boards

Only share boards you have the right to share.

- **Your own design:** pick any licence. `CC-BY-4.0` lets others reuse it as long as they credit you.
- **Open hardware** (KiCad projects on GitHub, GitLab, OSHWLab…): its licence (CERN-OHL, Apache,
  CC-BY-SA…) applies to your converted version too. Keep it, and credit the designer:

  ```json
  "credits": "Jetson Nano baseboard by Antmicro. Converted, with planted faults, for DEADBOARD.",
  "license": "Apache-2.0",
  "source": "https://github.com/antmicro/jetson-nano-baseboard"
  ```

- **Manufacturer boardviews and schematics** (laptops, phones, consoles) are usually confidential,
  even when they can be found online. Don't put them in a mod you share. You can still load them on
  your own computer.

Players see the credits, licence and source link in the board's Overview tab.

## Limits

- A mod `.zip` can hold up to 4,000 files and unpack to at most 512 MB (256 MB per file).
- Encrypted zips and ZIP64 archives aren't supported. The zip tools built into Windows and macOS
  produce archives that work.
- A mod lists up to 500 boards.

## For developers

- Format versions: `deadboard-mod/1` (boards) and `deadboard-mod/2` (adds `requires`, `conflicts`,
  packs without boards, strict semver, `patches`, `knowledge`, `puzzles`, `devices`, `faultTypes`,
  `meters`, `rules`, `code`). Patches:
  `src/mods/patches.ts`; knowledge packs: `src/mods/knowledge.ts`; puzzles: `src/mods/puzzles.ts`
  (`test/modcontent.test.ts`); the official mods: `src/mods/official.ts`. Devices:
  `src/mods/devices.ts` (overlay used by `findDevice`, also sent to the solve worker); solver
  addresses: `src/mods/solvers.ts`; bench check: `src/mods/benchcheck.ts`, run outside the app by
  `src/mods/benchrun.ts` / `scripts/bench-check.ts` (`test/modsolvers.test.ts`). Code mods:
  `src/mods/api/` (API types, runtime, host, sandbox, netlist; `test/modcode.test.ts`); types
  package: `packages/mod-api` (`npm run mod-api`). Phase 5: fault types `src/mods/faulttypes.ts`,
  meters `src/mods/meters.ts`, rules engine + recall test `src/mods/rules.ts`, importer glue
  `src/mods/api/importing.ts` (`test/modphase5.test.ts`). Phase 6: panels `src/mods/api/panels.ts`
  (sanitising), requests and per-mod events in `host.ts`, the Mods tab in `src/ui/app.ts`
  (`test/modphase6.test.ts`). Which mods run is decided in `src/mods/resolve.ts` from the
  loadout (`src/mods/loadouts.ts`); `test/modkernel.test.ts` covers both. The plan for the rest of
  the platform is [MOD_PLATFORM.md](https://github.com/tholtman1-del/deadboard/blob/main/docs/MOD_PLATFORM.md). The loader is in
  [`src/mods/`](https://github.com/tholtman1-del/deadboard/tree/main/src/mods), the example in
  [`examples/mods/starter-kit/`](https://github.com/tholtman1-del/deadboard/tree/main/examples/mods/starter-kit)
  (`npm run example-mod` rebuilds its challenge and the download; `test/mods.test.ts` checks both).
- Board ids: a `.pcbfix.json` keeps its own `id` (its flag lock and players' progress depend on it);
  imported boards get `mod-<mod id>-<board id>`. A board whose id is already in use is skipped.
- Mods are data only by design: the same importers that handle a dropped file read every board,
  schematics are shown as PDF or images, and nothing in a mod is executed.
