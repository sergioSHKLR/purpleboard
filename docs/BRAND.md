# PurpleBoard — brand basics

> PurpleBoard is a fork of [DEADBOARD by tholtman1-del](https://github.com/tholtman1-del/deadboard) (Apache-2.0). The fork follows the SHKLR brand kit (rev 4): own name and icon, wordmark PURPLEBOARD in uppercase Martian Mono Bold, condensed (wdth 75), tracking +0.02em, self-hosted from `@fontsource-variable/martian-mono`; UI text is not set in the brand font. The notes below the icon table are from the upstream brand guide.

**Name:** DEADBOARD (always one word, all caps in the wordmark; "Deadboard" in running text is fine).
Repair slang for a board that will not power on, with a nod to `0xDEADBEEF`.
**Tagline:** *Bring dead boards back.*  **Descriptor:** Board-level repair trainer.

Audience: a professional core (repair technicians, training centres) with a playful
challenge edge (CTF-style repair puzzles). Credibility first, personality second.

## Logo

| Asset | File |
|---|---|
| PurpleBoard app icon (SHKLR brand kit rev 4 style: Lucide "square-activity" stroke glyph, a rounded square with a pulse line (ISC licence); violet #7c3aed on a #ffffff plate (light), #a78bfa on #1a1a1a (dark)) | [`brand/purpleboard-tile-light.svg`](brand/purpleboard-tile-light.svg), [`brand/purpleboard-tile-dark.svg`](brand/purpleboard-tile-dark.svg), square (apple-touch) and maskable variants in `docs/brand/`; source `src/ui/brand-icon.ts`; in-app (dark tile): `markSvg()` in `src/ui/logo.ts` |
| Favicon / app icons | `public/favicon.svg` (bare glyph, swaps colour with `prefers-color-scheme`), `public/favicon-32{,-dark}.png`, `public/icons/icon-{180,192,512}{,-dark}.png`, `public/icons/icon-maskable-512{,-dark}.png` |

- The wordmark is JetBrains Mono Bold, tracked +0.14 em, followed by a phosphor-green block cursor
  (blinks in the app; static in print and when reduced motion is on).
- Signal green is only for the trace and cursor; the board outline uses the text colour.
- Minimum mark size: 16 px. Keep clear space of half the mark's width around it.
- Don't recolour the trace, add glows or gradients, or put the mark on a busy background.

## Colour (tokens in `src/ui/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` / `--surface` / `-2` / `-3` | `#090c0a` `#0f1311` `#141916` `#1a201c` | green-tinted near-blacks, back to front |
| `--border` / `--border-strong` | `#222a25` `#2e3832` | 1 px hairlines |
| `--text` / `--text-2` / `--muted` | `#e3eae5` `#aeb9b1` `#7d8a82` | primary / secondary / tertiary text |
| `--accent` (phosphor) | `#4be38a` | the one brand accent: active states, primary actions, focus |
| `--accent-ink` | `#04140a` | text on an accent fill (never white on green) |
| `--warn` / `--danger` / `--ok` | `#f2b33d` `#ff5f57` `#34c77b` | status |

Instrument colours keep their bench meaning and are **not** brand colours: probe red, scope
trace yellow `#f5d547`, supply volts green `#7ee787`, supply amps amber `#ffa657`, thermal ramp.

## Type

- **JetBrains Mono** (variable): wordmark, readings, values, net names, code.
- **Inter** (variable): interface text, labels, explanations.
- Both are bundled (`@fontsource-variable/*`), with no font requests to third parties.

## Voice

Precise like a technician, terse like a terminal, with the occasional dry joke.

- Lead with the fact and its unit; name the part and the net (`R7788`, `PP3V3_S5`, `317 mA`).
- Say what to do next, not only what went wrong.
- Never fake certainty: estimates and synthesized data are labelled as such.
- Humour stays short and goes in successes and empty states, never in error details.

| Instead of | Write |
|---|---|
| All test bench objectives passed! | All checks green. The board is alive. |
| Objectives pass electrically, but circuit topology differs… | Checks pass, but the circuit is not the reference design — a fault is still hiding in there. |
| Flag unlocked | Flag captured |
| Created blank sandbox board. Lock a flag in CTF Studio! | Blank board ready. Lock a flag in the Author tab, then break it. |

## Kept for compatibility

The scenario file format id `pcbfix/1`, the `.pcbfix.json` extension, the `pcbfix_*` browser
storage keys and existing `PCB{…}` flags are unchanged, so shared challenges and saved settings
keep working. Rename them only together with a migration.
