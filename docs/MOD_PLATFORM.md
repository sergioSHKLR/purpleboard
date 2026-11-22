# Mod platform: design

**Status:** phases 1 (kernel), 2 (patches, knowledge, puzzles, official boards), 3 (solvers, devices, bench check) 4 (plug-in API + sandbox, code mods experimental and off by default) 5 (fault types, meters, importers, rules engine) and 6 (panels, network permission, coach example) built 2026-11-20; phase 7 waits on mod.io · **Player and author guide:** [MODDING.md](MODDING.md)
(today's format, `deadboard-mod/1`) · **Owner of this doc:** the main repo

## Goal

**Make forking pointless by making a mod the easier way to change anything.**

DEADBOARD ships with a set of **official mods**: our best version of every board, engine, importer,
instrument and fault model. Players get those out of the box and never have to think about mods.
Anyone who wants something different, such as a harsher fault model, a better diode model, a new
file format, a hint engine or a repair coach, makes a mod. Players then add, remove and mix mods
from one marketplace that lists official and community mods together.

A fork has to merge every core change by hand and falls behind. A mod that builds on an
official mod picks up our improvements by itself. As long as that holds, people choose mods.

### What this design must keep

- **Nothing changes for players who never touch mods.** With no community mods installed, the game
  is exactly the official set. Each phase below ships without changing behaviour.
- **A data mod from a stranger can't run anything.** This is the promise in MODDING.md, and it
  stays true. Code is a separate, opt-in tier with a sandbox and permissions.
- **Mods can't make a board easier to cheat.** The flag check, the tests that run mods and the
  installer stay in the core (see [Trust boundary](#trust-boundary)).
- **`deadboard-mod/1` mods keep loading unchanged.**

## Concepts

| Term | Meaning |
|---|---|
| **Core** | The small part of the app that is not a mod: mod loader, plug-in API, sandbox, trust pieces, authoring tools. |
| **Mod** | A package with `mod.json`. It adds **items** (boards, engines, fault types, …) and/or **patches** to other mods' items. |
| **Item** | One thing a mod provides, with an id that is unique within the mod. Every item has a global **address**: `<mod-id>/<type>/<item-id>`, e.g. `official-faults/faultTypes/mlcc-dead-short`. |
| **Official mod** | A mod that ships inside the app, maintained in this repo under `mods/official/`. It has the same format as a community mod, plus an **Official** badge. |
| **Data mod** | Only JSON, images and board files. Safe on every platform, no review needed. |
| **Code mod** | Also contains one JavaScript module that registers items through the plug-in API. Runs in a sandbox and asks for permissions. Not available in the iOS app. |
| **Patch** | A change to another mod's item ("set `max` to 5"), applied on top of it at load time. |
| **Loadout** | A named list of enabled mods, in order. "Official" is the default and can't be edited. |
| **Pin** | A challenge's record of the mods (and versions) it was built and checked with. |

## Manifest: `deadboard-mod/2`

`/2` adds item types, dependencies, patches and code. A `/1` manifest is read as a `/2` manifest
that only has `boards`.

```json
{
  "format": "deadboard-mod/2",
  "id": "jane-real-mlcc",
  "name": "Realistic MLCC failures",
  "version": "1.2.0",
  "author": "jane",
  "license": "CC-BY-4.0",
  "description": "Cracked MLCCs short harder and heat more, based on my bench notes.",
  "homepage": "https://example.org/jane-real-mlcc",

  "requires": { "official-faults": "^1.0" },

  "patches": [
    {
      "target": "official-faults/faultTypes/mlcc-dead-short",
      "set": { "range": { "min": 0.02, "max": 0.5 } },
      "why": "Measured 0.02–0.4 Ω on 14 cracked 0402 MLCCs."
    }
  ],

  "faultTypes": [ "…new items of this type…" ],
  "boards": [ "…same as today…" ],

  "code": {
    "entry": "main.js",
    "api": "^1",
    "permissions": []
  }
}
```

| Field | New in /2 | Meaning |
|---|---|---|
| `version` | now must be semver | `MAJOR.MINOR.PATCH`. Dependencies and pins compare it. |
| `requires` | yes | Other mods this one needs, with a version range (`^1.2`, `~1.2.3`, `>=1.0`, `1.2.3`, `*`). The app offers to install them from the marketplace. A patch may only target mods listed here. |
| `patches` | yes | Changes to other mods' items (see [Patches](#patches)). |
| one key per item type | yes (`boards` exists) | Items this mod adds (see [Item types](#item-types)). |
| `code` | yes | Makes this a code mod (see [Code mods](#code-mods)). |
| `conflicts` | yes | Mods this one can't run with (`{ "other-mod": "*" }`). Rare; shown in the manager. |

The parser keeps today's style: it collects every problem and reports them all at once, in plain
words, because most authors aren't programmers. Unknown top-level keys are a warning, not an error,
so a mod made for a newer app still loads in an older one.

## Item types

Each item type is a **registry** in the core. A registry has a schema for data items, an optional
interface for code items, and a rule for which item is the default. Official mods fill every
registry. Community mods add items or patch them.

| Type (`mod.json` key) | Data or code | What an item is | Official mod | Today's code |
|---|---|---|---|---|
| `boards` | data | A board or challenge, as today | `official-boards` | [scenarios/](../src/scenarios/), [mods.ts](../src/mods/mods.ts) |
| `puzzles` | data | A recipe: board address + faults from the catalogue + story + objectives (the "puzzle marketplace" idea in SIMULATION_HANDOFF.md) | none yet | [puzzles.ts](../src/mods/puzzles.ts) |
| `knowledge` | data | A knowledge pack for one board: rails, power-up order, expected readings, provenance (see [RFC mapping](#how-the-coach-rfc-fits)) | none yet | none |
| `faultTypes` | data | A fault type built from primitives (leak, drift, cold, open, break, residue, warm/flex intermittents), where it applies (**built**) | `official-faults` (ranges patchable) | [faulttypes.ts](../src/mods/faulttypes.ts), [faults.ts](../src/faults.ts) |
| `devices` | data | A semiconductor's datasheet quantities + pin map, as in today's device library | `official-solvers` | [devicelib.ts](../src/spice/devicelib.ts) |
| `meters` | data | A DMM profile (ranges, test currents, input impedance) (**built**) | `official-instruments` | [meters.ts](../src/mods/meters.ts), [dmm.ts](../src/spice/dmm.ts) |
| `solvers` | code | A circuit engine: board in, operating point out | `official-solvers` (fast, spice, spice-power) | [verify.ts](../src/verify.ts), [sim.ts](../src/sim.ts), [spice/](../src/spice/) |
| `importers` | code | A board file format → KiCad text or a challenge object, checked by the app's importers (**built**) | `official-importers` (KiCad, .brd, .tvw) | [io/](../src/io/), [importing.ts](../src/mods/api/importing.ts) |
| `instruments` | code | A tool on the bench (meter, scope, thermal camera, PSU) | `official-instruments` | [app.ts](../src/ui/app.ts), [scope.ts](../src/scope.ts), [thermal.ts](../src/thermal.ts) |
| `rules` | data | Diagnostic rules: observation → ranked parts → confirming measurement (**built**) | `official-rules` | [rules.ts](../src/mods/rules.ts) |
| `panels` | code | A UI panel beside the board | none (last phase) | none |
| `languages` | data | A UI translation keyed by English text, as today | `official-lang-ru` (later: languages load before mods, so this needs its own early path) | [i18n/](../src/i18n/) |

**Data first.** The more of each official mod is data, the more changes can be made with a patch
rather than code. Device models, meter profiles and fault ranges are already data with provenance.
Fault *types* are code today (`injectFault`). The plan is a few core **fault primitives**, such as
"resistance between pads", "series resistance at a pad", "scale the value", "open the part" and
"heat-triggered", so that a new fault type is a JSON item. Code fault types are only for what the
primitives can't express.

## Patches

A patch changes one item of another mod, without copying it.

```json
{ "target": "official-solvers/devices/bss138", "set": { "vth": 1.3 }, "why": "datasheet rev. 6, typ." }
```

- `target` is an item address. The target mod must be in `requires`.
- `set` is a **JSON merge patch** (RFC 7396): objects merge, arrays and plain values replace, and
  `null` deletes a key. One rule, no special syntax.
- `why` is optional and shown in the manager. Patches to physics items should say where the
  number comes from, in keeping with the app's "honest numbers" principle.
- Patches are applied in loadout order. If two enabled mods set the same field, the later mod wins
  and the manager shows the conflict, with both values and both `why` notes.
- After patching, the item is validated against its type's schema again. A patch that breaks the
  schema is skipped with a warning, and the rest of the mod still loads.
- Code items can't be patched. Their data (devices, meters) can, which is why it lives in separate
  registries.

**Replacing an item outright** is not a patch. The mod adds its own item with its own id (e.g. a new
solver `jane-spice/solvers/spice`) and the player, or a board, picks it. The official item stays
available, so nothing that works with it breaks.

## Defaults, choice and pins

- Each registry has a **default item**: the official one, unless the player picks another in the
  manager ("Use as default engine"). Registries that the game can't run without (solver, KiCad
  importer, meter) always keep at least one usable item, so the official mods that provide them
  can be set aside but never removed.
- **Boards pin what they need.** Today a scenario says `solver: "spice-power"`. In `/2` it becomes
  an address: `solver: "official-solvers/solvers/spice-power"`. The three old names keep working as
  aliases. A board built on a community engine names that engine, and the app offers to install
  it.
- **Challenges record a pin:** the mods and versions enabled when the author exported the challenge
  (`requires` inside `.pcbfix.json`). When a player opens it with a different loadout, the app runs
  that challenge with the pinned set where it can, and otherwise says what differs ("built with
  jane-real-mlcc 1.2, you have 1.0").
- **Official mods keep their majors stable.** Within a major version, official mods don't change
  in a way that breaks a pinned challenge. CI runs every bundled challenge against the current
  official mods to enforce this.

## Loadouts

- A loadout is a list: `[{ "id": "official-boards", "version": "^1" }, { "id": "jane-real-mlcc", "version": "1.2.0" }, …]`
  in load order, with the chosen default per registry.
- **"Official"** is built in and read-only: no community mods. Switching to it is the one-click
  "reset to official", and it never uninstalls anything.
- **"My mods"** is the starting loadout (so players who installed mods before loadouts existed
  keep them). A loadout stores the mods turned *off*, so a new install is on everywhere except
  Official. Turning a mod on while in Official switches to My mods.
- Players can keep several loadouts and switch between them from the Mods window.
- **A shared loadout is a mod with only `requires`.** It needs no new file type, and the
  marketplace lists it like any other mod ("Jane's hardcore pack").
- **Safe mode** (`app.html?safe`) runs one visit with no mods at all, without touching the saved
  loadouts. It also switches on by itself when the previous start ran mods and never finished
  (crash, hang, or the tab closed mid-start), with a note saying why. Starts that never loaded a
  mod, or that stopped on the GPU error screen, don't count.

## Code mods

For what data can't express: a new engine, a new file format, a new instrument, a coach.

```json
"code": { "entry": "main.js", "api": "^1", "permissions": ["network:localhost"] }
```

- **One ES module**, bundled by the author. It may not contain the word `import` at all (see the security review).
- **`api`** is the plug-in API range it was built for. The app refuses a major it doesn't have,
  with a clear message, instead of loading it and failing later.
- **The sandbox:** each code mod runs in its own Web Worker started inside a sandboxed iframe
  (`sandbox="allow-scripts"`, opaque origin) with a Content-Security-Policy of `default-src 'none'`.
  The iframe has no DOM access to the app, no cookies or storage of the site, and no network unless
  a permission opens it. It talks to the app only through the plug-in API messages. Built in phase 4
  and probed in Chrome; see [Security review](#security-review-phase-4-2026-11-20). An outside
  review is still open, so code mods are off by default.
- **Permissions**, shown on install and in the manager, revocable at any time:

  | Permission | Allows |
  |---|---|
  | (none) | Read the board, register items, answer calls. Most code mods need nothing more. |
  | `network:localhost` | `http://127.0.0.1` and `http://localhost` only, e.g. a local model server for a coach. |
  | `network:<https origin>` | One named HTTPS origin. Shown in red; the bench check flags it. |
  | `panel` | Show one panel beside the board (phase 6). |
  | `storage` | A small key-value store for this mod only. |

- **Limits:** each call has a time budget (a solve that runs over is cancelled and reported). A mod
  that crashes repeatedly is turned off for the session with a note in the manager.
- **Everything is async.** Mod solvers answer through the async solve path (built in phase 4,
  see [Plug-in API v1](#plug-in-api-v1)); the official solvers keep their synchronous path.
- **Official mods are trusted code.** They are bundled and reviewed, so they run in-process like
  today. They register through the same registries as community mods. If an official mod needs
  something the public API lacks, that's an API gap to close, because community mods will need it
  too.
- **iOS:** App Store rules forbid downloading code that changes the app, so the iOS app runs data
  mods only and shows code mods as "desktop and web only".

## Plug-in API v1

What code mods can call ([types.ts](../src/mods/api/types.ts), the single source; authors get it as
the `@deadboard/mod-api` package, generated into `packages/mod-api`). It is versioned (`1.0.0`); a
mod names the range it was written for (`"api": "^1"`) and the app refuses a major it doesn't have.
A major version stays supported for a long time after the next one ships.

A code mod is one ES module whose default export is `activate(api)`.

**Built (phase 4):**

- **Board queries**, the coach RFC's query layer ([queries.ts](../src/mods/api/queries.ts)),
  synchronous inside the sandbox over the latest board a mod saw: `findRef` (never throws: near
  matches when there is no exact one), `parts`, `pinsOfNet`, `netOfPin`, `railState`.
  `groupOf` isn't needed (in DEADBOARD a net *is* a connected-copper group); `knowledge()` is left
  for when a mod needs it. **API 1.1 (2026-11-21, asked for by Biga73):** `board.netsNear(ref, mm)`
  stands in for `copperGap`: the host answers from its own geometry with net names, gaps and pad
  names only (no coordinates leave the app; distance capped at 5 mm; no permission, as it says
  less than the netlist a mod already has plus "these pads are close"), and `ui.highlight(net)`
  (needs `panel`, like `zoomTo`) points at a net.
- **Events** (read-only): `board:loaded` (with the netlist), `power:changed` (with net voltages),
  `measure:taken`, `tests:run`, `flag:unlocked`.
- **Solvers:** `register.solver(id, { name, solve })`. The app gives a solver the board as a
  **netlist** ([netlist.ts](../src/mods/api/netlist.ts)): nets, and per part its pins with
  electrical roles (reversal applied), open / resistive joints, leaks, drift, switch positions. So a
  solver needs no geometry. It returns volts per net and current / power / lit / overloaded per
  part, which the app checks number by number before using (untrusted).
- **The async solve path:** with a solver mod in use, the bench asks it after every change and
  keeps its last answer until the next one lands; a stand-in never burns a part. "Run tests" solves
  once per switch setting the tests use (`evaluateObjectivesAsync` in [verify.ts](../src/verify.ts)).
  Ohm, diode and injection measurements stay on the official solver.

**Later:** `register.importer`, `register.instrument`, `register.rule` (phase 5), panels and UI
requests (`highlight`, `zoomTo`, `say`; phase 6). A mod can point and explain; it can never click,
rework, inject faults or unlock anything.

**Download size:** the parts of the platform a player only needs when they use them load on
demand: the bench check, the rules engine (`rules-engine.ts`; the rules themselves are data in
`rules.ts`), and the code-mod host, sandbox and runtime (`api/nohost.ts` stands in until code mods
are switched on). With that, the mod platform adds about 90 KB to the app's first download
(≈30 KB gzipped).

## Security review (phase 4, 2026-11-20)

Code mods are **off by default** behind an "experimental" switch with a warning, and stay that way
until an outside review. This is the in-house review: the threat model, what enforces each rule,
what was tested and what is still open.

**Threat:** a code mod from a stranger (marketplace) that tries to read the player's data, use the
network (exfiltrate, or use the player's connection), break the page, or fake results.

**Controls, outermost first** ([sandbox.ts](../src/mods/api/sandbox.ts), [csp.ts](../src/mods/api/csp.ts),
[runtime-worker.ts](../src/mods/api/runtime-worker.ts), [host.ts](../src/mods/api/host.ts)):

1. **Opaque origin.** Each mod runs in its own `<iframe sandbox="allow-scripts">` (no
   `allow-same-origin`): no access to the app's DOM, cookies, localStorage or IndexedDB.
2. **Content-Security-Policy** in that frame: `default-src 'none'; script-src 'unsafe-inline' blob:
   'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'` (or the origins a granted permission
   names). No eval, no network, no images or styles.
3. **A worker** inside the frame runs the runtime and the mod, so a busy mod doesn't freeze the page.
4. **Lockdown before the mod runs:** the module's blob URL is made, then `fetch`, XHR, WebSocket,
   EventSource, WebTransport (unless a network permission), `importScripts`, IndexedDB, caches,
   Worker, SharedWorker, BroadcastChannel, `URL.createObjectURL` and more are removed, from the
   global object **and its prototypes**.
5. **No module loading:** the mod runs as a **classic script** through `importScripts(blob)`,
   which the frame's CSP governs ([runtime-worker.ts](../src/mods/api/runtime-worker.ts)); its one
   `export default` is rewritten first. A source containing the word `import`, any other `export`,
   or a second default is refused, at install, at start and in the loader
   ([version.ts](../src/mods/api/version.ts) `codeProblem`). See the findings below.
6. **The host trusts nothing it receives:** message shapes are checked, results are sanitised
   (non-finite numbers, unknown nets and parts dropped, text capped), and every call has a time limit
   (start 5 s, solve 10 s). Past it the frame is removed, which ends the worker; the app goes back to
   its own solver and says why.
7. **Results can't unlock a flag:** the flag key comes from the board's wiring and fault state
   ([crypto.ts](../src/crypto.ts)), and test results from a solver mod are labelled as such.
8. **Consent:** off by default; turning code mods on shows a warning; installing a code mod shows
   its permissions; they stay visible on its card.

**Finding during the review:** in Chrome a *classic* worker's dynamic `import()` fetches its URL
even though the frame's CSP doesn't allow that origin (the same policy does block `eval`,
`fetch` and `importScripts` in that worker; a module worker doesn't start in the sandboxed frame at
all). Confirmed with a minimal page outside the app (Chrome 157). `import` is syntax and eval is
blocked, so the word has to be in the source to be used: hence the word rule. Rule 4 removes the
ways to load other code a mod could build at run time (blob URLs, `importScripts`).

**Second finding (security check, 2026-11-20):** the mod was first loaded as an ES module
(`import(blob)`), and an ES module can load other modules without the word: `export * from
"https://…"`. Its static dependencies go through the same loader, and Chrome sent the request
despite `connect-src 'none'` (reproduced: the re-export reached the server; the fetched module
could then call `import()` freely and send out what the mod sees). Fixed by never loading a mod as
a module (rule 5): a classic script can't contain module syntax at all, and `importScripts`
respects the CSP. Re-tested in Chrome: an `export * from` mod is refused at install, the escape
probe reaches no server, and both example code mods (solver, coach) run unchanged.

**Tested in Chrome 157 (headless), with an escape-probe mod and the app's real sandbox:** blocked:
`fetch` (also taken back from the prototype), XHR, WebSocket, `importScripts` of http / blob / data
URLs, `URL.createObjectURL`, a nested Worker, `eval`, `new Function`, the async-function
constructor, a string passed to `setTimeout` (refused silently, no request), IndexedDB, caches,
`document`, `localStorage`. **No request reached the server.** A mod containing `import(` is refused
at install. A solver that loops forever is stopped after 10 s and the page stays responsive.

**Added in phase 6:** panel content is untrusted data, sanitised by the host (known node types
only, text clipped, at most 300 nodes, ids checked) and escaped by the app; a panel's events go to
its own mod only; `ui.say` is limited to one message a second; `storage` is per mod, in the app's
localStorage, capped at 64 KB; every request is checked against the mod's permissions by the
host, not the runtime. Tested in Chrome: the coach reached the local server with `network:localhost`;
the same mod pointed at a non-local endpoint got "Failed to fetch" and no request left the machine.

**Open before code mods may be on by default:**

- an outside security review of the above;
- the same probe in **Firefox and Safari** (and the desktop app's Electron settings);
- **memory:** a mod can allocate until the tab's renderer dies (a worker can't be memory-capped);
  the tab reloads and a crash during start leads to safe mode, but a crash later doesn't;
- **message size:** a huge result is copied to the page before it's checked; cap it;
- **CPU:** a mod can keep a core busy until its time limit, on every solve;
- **side channels:** the frame may share the page's process; there is no SharedArrayBuffer
  (the page isn't cross-origin isolated), which limits precise timers;
- the import rule is a text check: it needs revisiting if browsers add other module-loading syntax.

## Trust boundary

These stay in the core and no mod can replace or patch them:

- **Flag lock and unlock** ([crypto.ts](../src/crypto.ts)). The key is derived from the board's
  wiring plus its fault state, not from any solver result. A solver mod can make "Run tests" go
  green, but it can't unlock a flag without the real repair. When tests run on a non-official
  engine, the results name the engine.
- **The bench check** (below). A mod must not be able to pass its own test.
- **Installing, updating and downloading** from mod.io, and the permission prompts.
- **The sandbox** itself.
- **Saves, progress and settings.** Removing a mod never breaks a save; boards from a missing mod
  show as "needs <mod>".
- **Analytics** (website only, as today). Mods can't send events and can't read the analytics
  setup.

## Bench check

The automatic test that makes the marketplace trustworthy. It is built on today's verification
code ([verify.ts](../src/verify.ts)), and the same code runs in three places: the Author tab
before export, `npm run bench-check -- <mod>` for authors working in a folder, and a scheduled bot
that checks new mod.io uploads and sets a locked **Bench-checked** tag.

| Mod adds | Check |
|---|---|
| boards / puzzles | The reference board passes its objectives; each planted fault is visible; no burn cascade; a repair with the player's tools unlocks the flag. |
| patches | Every installed board touched by the patch is re-run, and the differences are listed. |
| solvers | Every official board runs on the new engine and on official SPICE; the report says "agrees on 41 of 44 boards" and lists the readings that differ. |
| faultTypes | Injected on the official boards: visible, repairable, severities inside the stated range. |
| rules | Recall: for each injectable fault on each official board, the planted part is among the top 3 candidates. A rule set that names a part not on the board fails. |
| knowledge | Every designator and net in the pack exists on its board; stale entries are listed. |
| code mods | Loads in the sandbox within its time budget, registers what its manifest says, uses no permission it didn't declare. |

The report is shown in the marketplace next to the mod, so players can see that an engine is
"close to official SPICE on everything except switching regulators" before they install it.

## Official mods

They live in this repo under `mods/official/<id>/` and are bundled into every build.

| Mod | Contents | Built from |
|---|---|---|
| `official-boards` | Tutorials, demo repairs, realistic boards | **Built (phase 2):** listed under `official-boards/boards/<scenario id>` from the scenarios the app builds at start ([official.ts](../src/mods/official.ts)). Each shipped challenge keeps its pre-sabotage board beside it ([reference.ts](../src/scenarios/reference.ts)) as the base for puzzles. *Later:* write the builders' output to `.pcbfix.json` files at build time, so the shipped mod is data too. |
| `official-solvers` | `fast`, `spice`, `spice-power`; device library; regulator models | [sim.ts](../src/sim.ts), [spice/](../src/spice/) |
| `official-importers` | KiCad, boardview `.brd`, `.tvw` | [io/](../src/io/) |
| `official-faults` | Today's 13 fault classes and their ranges | [faults.ts](../src/faults.ts), [intermittent.ts](../src/intermittent.ts) |
| `official-instruments` | Meter (with DMM profiles), scope, thermal camera, bench supply | [app.ts](../src/ui/app.ts) and friends |
| `official-lang-ru` | Russian | [i18n/ru.ts](../src/i18n/ru.ts) (the completeness test stays) |

They are also published on mod.io, marked Official, so they appear in the marketplace next to
community mods and anyone can download one as a starting point.

**Promoting a community mod:** when a community mod is better than ours, we can make it official,
with the author's consent and a compatible licence, crediting them in the mod. That is the
reward for building a mod instead of a fork.

## Marketplace

mod.io stays the hub (see [MODDING.md](MODDING.md) and `src/mods/modio.ts`).

- **Tags:** Type = Board, Puzzle, Knowledge, Faults, Devices, Engine, Importer, Instrument, Rules,
  Panel, Language, Loadout. Tier = Data / Code. Locked tags set only by us or the bot: Official,
  Bench-checked.
- **Curation:** data mods auto-approve after the virus scan, as now. Code mods should get a human
  look before going public. Whether mod.io can curate by tag or only for the whole game is an open
  question.
- **In the app**, the Mods window has:
  - Installed and Browse tabs, and a loadout picker;
  - per mod: enable switch, version, permissions, bench-check report, and what it changes (a
    readable summary of its patches);
  - conflicts shown side by side;
  - "needs X", with an install button for missing dependencies;
  - **Make my version**: creates a new mod that `requires` the chosen one with an empty patch
    list, and opens it in the Author tab. This is the "remix" button that replaces forking.

## How the coach RFC fits

An outside RFC by Biga73 proposed a knowledge pack, a board query layer, an offline fault-candidate engine
and an optional LLM coach. On this platform:

| RFC piece | Where it lands | Phase |
|---|---|---|
| 1. Knowledge pack | `knowledge` item type: data, attached to a board by address (**built**; fingerprints open). Packs for all 13 shipped boards: example `board-notes`, its readings tested against the simulator | 2 |
| 2. Board query layer | The core: it *is* plug-in API v1's board queries (**built**) | 4 |
| 3. Fault-candidate engine | `rules` item type, data (**built**: [rules.ts](../src/mods/rules.ts), «Where to look?», recall test in the bench check) | 5 |
| 4. Explanation coach | A code mod with `panel` + `network:localhost` (**built**: example `local-coach`, grounding enforced by the mod with `findRef`). Opt-in by installing it, so no LLM is ever in the core. | 6 |

The RFC's open question "where should packs live?" is answered by `requires` + item addresses: a
pack is its own mod that names the board it targets, so it can come from someone other than the
board's author. Targeting by **board fingerprint** (a hash of the board's netlist) lets a pack
apply to a board the player imported themselves, without the pack redistributing that board.

## Phases

Each phase ships alone and leaves the game behaving exactly as before for players on the Official
loadout. The full test suite passes after each.

| # | Phase | Done when |
|---|---|---|
| 0 | This design | Agreed; open questions below answered or parked. |
| 1 | **Kernel:** `/2` parser (`/1` unchanged), semver, `requires`, item addresses, enable/disable, loadouts, safe mode | **Built 2026-11-20:** `src/mods/semver.ts`, `resolve.ts`, `loadouts.ts`, `/2` in `mods.ts`, Mods window (loadout picker, On switch, "Can't run" with Find on mod.io / Turn on), `test/modkernel.test.ts`, safe mode after a failed start. |
| 2 | **Data registries + patches:** `official-boards` as a bundled mod; `knowledge` and `puzzles` types; patches with conflict display | **Built 2026-11-20:** [patches.ts](../src/mods/patches.ts) (merge patch on board fields; order, conflicts, skipped patches, undo when a mod is turned off), [knowledge.ts](../src/mods/knowledge.ts) (Overview tab card, stale refs/nets struck through), [puzzles.ts](../src/mods/puzzles.ts) (faults planted on a known-good board, flag locked to it), Official card + per-mod changes in the Mods window, example mod `examples/mods/night-light-extras`, `test/modcontent.test.ts`. Moved out: `official-lang-ru` (see `languages`). Knowledge packs target boards by address only; fingerprints are still open. |
| 3 | **Solvers:** `official-solvers` with fast/spice/spice-power; solver addresses with aliases; devices as patchable data; bench check v1 | **Built 2026-11-20:** [solvers.ts](../src/mods/solvers.ts) (addresses ↔ the three names), [devices.ts](../src/mods/devices.ts) (`devices` items + device patches → an overlay `findDevice` uses before the library, also posted to the solve worker; unsourced number changes clear `verified`; every model fitted at load), [benchcheck.ts](../src/mods/benchcheck.ts) (boards, puzzles, patches, knowledge, devices → which boards' nets move), Mods-window button, `npm run bench-check`, `test/modsolvers.test.ts`. Done-when met: a BSS138PW Vth patch moves two nets on the Jetson demo and nothing else. **Moved:** the async-first solve path to phase 4 (only code solvers need it; built-in solves stay as they are), meter profiles to phase 5 with the instruments (`GENERIC_DMM` is read when modules load). |
| 4 | **Plug-in API v1 + sandbox:** async-first solve path (moved from phase 3); board queries, events, code solvers in the sandbox, permissions, `@deadboard/mod-api`, a template code mod, security review | **Built 2026-11-20 (experimental, off by default):** [src/mods/api/](../src/mods/api/) (types, runtime, host, sandbox, netlist, queries), solver mods in the bench and in "Run tests", events, permissions + consent, `packages/mod-api`, example `examples/mods/ideal-dc` (agrees with the official solvers on all 11 built-in boards; since 2026-11-22 the SPICE-only transistor switch is outside what it models, and the bench check warns about that one board), bench check of code solvers (app, or `--run-code`), `test/modcode.test.ts`, [security review](#security-review-phase-4-2026-11-20) (found and closed an `import()` hole). Done-when met in Chrome: the example runs sandboxed, the probe reaches no server, the bench check passes. |
| 5 | **Remaining registries:** meter profiles as patchable data (moved from phase 3); fault primitives + `official-faults`, `official-importers`, `official-instruments`, `rules` | **Built 2026-11-20:** [faulttypes.ts](../src/mods/faulttypes.ts) (10 primitives; official ranges patchable; Author tab + puzzles use mod types), [meters.ts](../src/mods/meters.ts) (official meter patchable, mods add meters, Bench → Meter; the solve worker gets the active profile), `register.importer` for code mods ([importing.ts](../src/mods/api/importing.ts): output goes through the app's own importers), [rules.ts](../src/mods/rules.ts) (observation → rules → ranked parts with how to confirm; **Where to look?** in the Overview tab; recall test in the bench check), official cards for faults / importers / rules / instruments, example `examples/mods/repair-lab`, `test/modphase5.test.ts`. Done-when met: the salt-water fault type (data only) works in a puzzle and is repaired with IPA; official rules: planted part in the top 3 for 115 of 120 visible faults (none invented), repair-lab's one rule: 120 of 120. Since 2026-11-21 the official rules find all 120 (symptoms downstream of a supply net that already reads wrong count half; the five misses were cold joints at the supply). Since 2026-11-22 (transistor switch board): 139 of 139, after `generic` parts joined `high-open` / `low-load`, a `high-leak` rule, and physics filters (a pull-down must lead lower; a feed must carry current; no `low` below 0.3 V). **Moved:** code instruments (`register.instrument`) to phase 6: an instrument needs a panel. |
| 6 | **Panels + network permission**, code instruments (moved from phase 5) | **Built 2026-11-20:** declarative panels in a **Mods** tab ([panels.ts](../src/mods/api/panels.ts) sanitises every node; the app draws and escapes them), `ui.zoomTo` / `ui.say` and `storage` behind the `panel` / `storage` permissions (checked by the host), `panel:action` to the owning mod only, `bench:solved` + `probe:placed` events (so an instrument is a panel listening to them), `network:localhost` usable from the sandbox (`allow="local-network-access"` on its frame), example `examples/mods/local-coach`, `test/modphase6.test.ts`. Done-when met in Chrome: the coach asks a (fake) local model server from the real sandbox, shows the answer with part links, removes a made-up designator, and a non-local endpoint is blocked before any request leaves. |
| 7 | **Marketplace:** tags, bot bench check, "Make my version", in-app upload | A player can remix an official mod and publish it without leaving the app. **Started 2026-11-21 on deadboard.org itself:** a Community catalogue ([community.ts](../src/mods/community.ts), `npm run community`: every listed zip bench-checked, SHA-256 in the index, checked on download) in the Mods window, and **Submit** on an installed mod (bench check must pass; sent for review through the feedback route, no account, up to 40 KB inline (FormSubmit's limit, measured) else a link; `npm run feedback` saves it, `--add` lists it). mod.io stays a second channel. |

Phases 1–3 are the core of the work and need no sandbox. Phase 4 is the riskiest and gets its own
review.

## Open questions

- **Pinned versions:** how many old versions of a community mod the app keeps so pinned challenges
  still open, and whether to fetch exact old versions from mod.io on demand.
- **mod.io curation** for code mods only: possible per tag, or game-wide only?
- **Board fingerprint:** what goes into the hash so it survives cosmetic edits (silkscreen, trace
  geometry) but changes when the circuit does. The flag `topology` string is a starting point.
- **Order of item types after phase 3:** follow what authors ask for first; the coach RFC's author (Biga73)
  is the first known user.
- **Official mods' trust:** whether official code should, over time, run through the public API
  only, so it proves the API is enough.
