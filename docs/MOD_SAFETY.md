# Are mods safe?

Mods are made by other players. This page explains what a mod can and can't do on your computer, so
you can decide which ones to install. The short answer: **ordinary mods are data and can't run
anything; mods with code are off unless you switch them on, and run locked away from the rest of
the game.**

## Two kinds of mods

| | Data mods | Code mods |
| --- | --- | --- |
| Examples | Boards, repair challenges, puzzles, knowledge packs, fault types, meter profiles, diagnostic rules | New circuit solvers, importers for other file formats, panels such as a coach |
| Runs anything? | No. The game reads them like a board file you drop on the bench. | Yes, inside a sandbox (below). |
| Available | Everywhere | Website and desktop app, when you switch on **Mods → Code mods** (experimental). Not in the iOS app. |
| Marked | — | **Runs code**, with its permissions, on install and on its card |

## What a data mod can change

- **Its own boards and puzzles.** Text is always shown as text: a title or note can't turn into a
  program.
- **Other mods' boards, but only their text and tests:** title, description, difficulty, hints,
  tests, solver. Never the board itself, its parts, or its flag. The Mods window lists every change
  a mod makes, and why.
- **How faults, parts and meters behave** (fault types, device models, meter profiles), within
  checked limits. A device model the solver can't use is refused when the mod loads.
- **The hints "Where to look?" gives** (rules).

A **flag** unlocks only after a real repair: it's locked to the repaired board's wiring, not to
anything a mod or a solver says.

Turning a mod off undoes everything it changed. **Mods → Loadout → Official** runs the game as
shipped, without uninstalling anything.

## What keeps code mods in

When you switch on code mods, each one runs:

- **in its own sandboxed frame**, with no access to the game's page, your saves, your settings,
  your files, or other mods;
- **in a separate worker**, so a slow or stuck mod can't freeze the game. A mod that takes too long
  (5 s to start, 10 s per solve, 30 s per import) is stopped, and the game goes back to its own
  solver and says why;
- **without network access**, unless the mod asks for it and you install it knowing that.
  `network:localhost` means only a program on your own computer (such as a local AI model);
  `network:https://…` names the one site it may reach;
- **without `eval` or loading other code**: a mod is one plain script, checked when you install it.

The game also checks everything a code mod sends back: solver results number by number, panel
content node by node, imported boards through the game's own importers. Panels are drawn by the
game, so a mod can't put its own HTML on your screen.

**Permissions** you may see on install:

| Permission | What it allows |
| --- | --- |
| (none) | Run, read the board on the bench, offer a solver or importer. |
| `panel` | Show panels in the side panel's Mods tab, select a part, show short messages. |
| `storage` | Keep up to 64 KB of its own settings. |
| `network:localhost` | Talk to programs on your own computer. |
| `network:https://example.org` | Talk to that one site. |

## How we test it

We attacked the sandbox with a probe mod in Chrome. It tried every route out we could think of:
network requests of every kind (taken back from the browser's internals too), loading scripts and
modules, `eval`, storage, the page, nested workers. **No request got out.** Two ways out turned up
on the way, both through module loading in Chrome; both are closed, and the game now refuses any
mod that could use them.

**Bench check** (on every mod's card) tests what a mod does on the simulator before you rely on it.
For a code solver it compares every reading with the official solvers.

## What's still open

We're honest about the limits:

- The sandbox hasn't had an **outside security review** yet. That's why code mods are
  experimental and off by default.
- It has been probed in **Chrome**; Firefox and Safari still need the same tests.
- A code mod can use a lot of **memory or processor time** while it runs. The game stops it after
  its time limit, but a mod that eats memory can crash the tab (reload, and the game starts in safe
  mode if it happened while starting).
- A solver mod can simply be **wrong**. Test results from a solver mod are labelled as such.

## If something looks wrong

- Turn the mod off, or switch the loadout to **Official**.
- Open `app.html?safe` to start once with no mods at all.
- Report the mod on its mod.io page, or tell us through **Feedback** in the app.
