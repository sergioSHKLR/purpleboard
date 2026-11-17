# Make your own boards: the DEADBOARD modding guide

A **mod** adds boards to DEADBOARD: your own designs, open-hardware boards you converted, or repair
challenges you built. Each board can bring its **BOM** (part values) and its **schematic**, which
players can open next to the board while they probe.

Mods are plain files: a folder (or a `.zip` of it) with one small text file, `mod.json`, that lists
your boards. Mods contain no code, so installing someone else's mod is safe.

You don't need to be a programmer. If you can export a file from KiCad and edit a few lines of text,
you can make a mod.

## Try a mod first

1. Download the example mod: [starter-kit.zip](https://tholtman1-del.github.io/deadboard/examples/starter-kit.zip).
2. Open the bench and click the board name at the top left to open the board list. Click **Mods**,
   then **Install mod (.zip)**, and pick the file. Dropping the `.zip` onto the bench works too.
3. The new boards show up under **Community Mods** in the board list. Open **Night light (sandbox)**
   and click **Schematic** in the Overview tab to see the schematic next to the board.

On the website, installed mods are kept in your browser (they stay after a reload; clearing site
data removes them). The desktop app keeps them too, and also reads a **mods folder** (see
[Where mods live](#where-mods-live)).

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

Installing a mod with the same `id` again replaces the old version, so you can fix and re-install
as often as you like.

### Common problems

| Message | Fix |
| --- | --- |
| `mod.json is not valid JSON` | A missing comma or quote. Paste the file into any JSON checker to find the line. |
| `"id" must be 2-64 characters…` | Use lowercase letters, digits and `-` only, no spaces. |
| `… not found (did you mean …?)` | File names are case-sensitive; the message suggests the right one. |
| `has no mod.json at its root` | The zip holds more than one folder level. Zip the mod folder itself. |
| `no designator matches a part` | The BOM belongs to another board, or its reference column has a different name. |
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

- Format version: `deadboard-mod/1`. The loader is in
  [`src/mods/`](https://github.com/tholtman1-del/deadboard/tree/main/src/mods), the example in
  [`examples/mods/starter-kit/`](https://github.com/tholtman1-del/deadboard/tree/main/examples/mods/starter-kit)
  (`npm run example-mod` rebuilds its challenge and the download; `test/mods.test.ts` checks both).
- Board ids: a `.pcbfix.json` keeps its own `id` (its flag lock and players' progress depend on it);
  imported boards get `mod-<mod id>-<board id>`. A board whose id is already in use is skipped.
- Mods are data only by design: the same importers that handle a dropped file read every board,
  schematics are shown as PDF or images, and nothing in a mod is executed.
