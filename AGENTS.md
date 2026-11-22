# AGENTS.md

Notes for AI coding agents working on the DEADBOARD repository. (Making a *mod* rather than changing
the app? Read [docs/MODS_FOR_AGENTS.md](docs/MODS_FOR_AGENTS.md) instead.)

DEADBOARD is a board-level repair trainer that runs in the browser: TypeScript, Vite, no
framework, no backend. The site is static (GitHub Pages, deadboard.org); the same build also feeds
a desktop (Electron) and an iOS app.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (`app.html` is the bench, `index.html` the homepage). |
| `npm test` | Every suite in sequence (a few minutes). Run it before you hand work back. |
| `npx tsx test/<name>.test.ts` | One suite. |
| `npm run build` | Type-check + production build (also renders the docs pages). |
| `npm run bench-check -- <mod> [mods it needs]` | Test a mod on the simulator (`--run-code`: your own code mod, unsandboxed). |
| `npm run community` | Rebuild `public/community/index.json`, the Community mods list (bench-checks every listed zip). `-- --add <zip>` adds a reviewed submission (`npm run feedback` saves them to `.feedback/`). Run it after `npm run example-mod`. |
| `npm run example-mod` | Rebuild the example mods' zips in `public/examples/`. **Also re-locks the starter kit challenge with a new random salt:** afterwards run `git checkout -- examples/mods/starter-kit/boards/night-light-repair.pcbfix.json public/examples/starter-kit.zip` unless you meant to change it. |
| `npm run mod-api` | Regenerate `packages/mod-api` from `src/mods/api/types.ts`. |
| `npm run docs` | Regenerate the generated blocks in `docs/MOD_REFERENCE.md` and `docs/CODE_MODS.md`. |
| `npm run thumbs` | Re-render the board pictures of the board picker into `public/thumbs/` (needs `npx vite --port 5199` running and Chrome). Run it when a shipped board looks different; `test/catalog.test.ts` fails when a board in `src/scenarios/catalog.ts` has no picture. |

Tests fail when a generated artefact is stale (example zips, `packages/mod-api`, docs blocks):
regenerate with the command above, never by hand.

## Layout

| Path | What's there |
| --- | --- |
| `src/ui/app.ts` | The bench UI (one large class). |
| `src/sim.ts`, `src/spice/` | Fast DC solver; SPICE engine, device library, power tree, meter model. |
| `src/faults.ts`, `src/rework.ts`, `src/thermal.ts`, `src/intermittent.ts` | Faults and the physical bench. |
| `src/scenarios/` | Built-in boards (TypeScript builders), the problem generator, known-good references. |
| `src/io/` | Importers: KiCad, boardview `.brd` / `.tvw`, BOM, schematics, `.pcbfix.json`. |
| `src/mods/` | The mod platform: loader, loadouts, dependency resolution, item types, bench check. |
| `src/mods/api/` | Code mods: API types, runtime, host, sandbox. |
| `src/i18n/` | `t('English text')`; `ru.ts` is the Russian catalogue. |
| `docs/` | `MODDING.md`, `MOD_REFERENCE.md`, `CODE_MODS.md`, `MOD_SAFETY.md`, `MODS_FOR_AGENTS.md` are also the website's docs pages (rendered by `vite.config.ts`). `MOD_PLATFORM.md` is the platform's design and security review. |
| `examples/mods/` | Example mods (sources of the downloadable zips). |

## Conventions

- **Universal, not board-specific.** Fixes and models must work for any board; quirks of one board
  belong in that scenario's data, never in shared code.
- **Honest numbers.** Every model value has provenance; estimates are marked as estimates.
- **Translations.** UI text goes through `t()` with the English text as the key; Russian must stay
  complete (`test/i18n.test.ts` lists missing strings). Plurals: `'{n} part|{n} parts'`.
- **Phones.** On phones, shorten or fold text; never just shrink the font.
- **No new analytics events** without the maintainer asking; analytics run on the website only.
- **Private data stays local:** `test/private/`, `board_schemas/`, `.parts-cache/`, Apple boardview
  and schematic files are git-ignored and must never be committed or published. Check images and
  zips before you commit.
- Commits: `Area: what changed` as the title, then a short body.

## Mod platform invariants

The platform's security model is in `docs/MOD_PLATFORM.md`. Keep these true:

- **A data mod never runs code.** Every string from a mod reaches the page escaped (`this.esc()`
  in `app.ts`; `t()` does not escape its parameters). Toasts use `textContent`.
- **Code mods run only in the sandbox** (`src/mods/api/sandbox.ts`, `csp.ts`, `runtime-worker.ts`):
  an opaque-origin iframe with a strict CSP, a worker, and the mod loaded as a **classic script**
  through `importScripts(blob)`. Never load a mod as an ES module (`import()`): Chrome lets module
  loading in a worker bypass the CSP. `codeProblem` in `version.ts` refuses sources with the word
  `import`, any other `export`, or a second default.
- **The host decides**: permissions are checked in `host.ts`, results are sanitised
  (`netlist.ts` `simFromResult`, `panels.ts`), importer output goes through the app's importers.
- **Flags** unlock from the repaired board's topology (`src/crypto.ts`), never from a solver result.
- New item types: parse and validate in `src/mods/<type>.ts`, add the key to `mods.ts`
  (`KNOWN_KEYS`, the manifest, the patch-field table), apply in `loadMods()` in `app.ts`, add a
  bench check, tests, the reference page and the agents page.
