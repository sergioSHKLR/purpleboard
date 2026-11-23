# Puzzle-statistics collector

DEADBOARD's own anonymous puzzle statistics: a Cloudflare Worker (`worker.ts`) with a D1
database (`schema.sql`). The website sends one record per attempt at a puzzle
(`src/attempts/client.ts`); the fields and their rules are in `src/attempts/record.ts`; the
privacy text is in `docs/PRIVACY.md` → "Puzzle statistics". The apps never send anything.

What it keeps: the record's fields and the UTC day. No IP address, no headers, no request logs
(observability off). The per-attempt token is erased after a day; rows older than 90 days are
folded into `totals` (counts per day, puzzle, layout, outcome) and deleted. At most `DAILY_CAP`
rows a day are accepted (free-plan safety).

## Run it locally

```sh
cd collector
npx --yes wrangler@4 d1 execute deadboard-attempts --local --file schema.sql
npx --yes wrangler@4 dev --port 8787
```

Then send it a record (Origin must match `ALLOWED_ORIGIN`), or point a local build at it with
`VITE_ATTEMPTS_URL=http://…` (the game only sends from deadboard.org, so for the game itself test on
the live site). Report: `npm run attempts-report -- --local`.

## Deploy (once)

1. `npx --yes wrangler@4 login` (the account that holds deadboard.org).
2. `npx --yes wrangler@4 d1 create deadboard-attempts --jurisdiction=eu` (data stays in the EU) and put the printed
   `database_id` into `wrangler.toml`.
3. `npx --yes wrangler@4 d1 execute deadboard-attempts --remote --file schema.sql`
4. `npx --yes wrangler@4 deploy` (creates `stats.deadboard.org` with its certificate).
5. Set the repository variable `ATTEMPTS_URL` to `https://stats.deadboard.org/v1/attempt`; the Pages
   workflow passes it to the build as `VITE_ATTEMPTS_URL`. Without it the game sends nothing.

## Reading it

| Command | What it shows |
| --- | --- |
| `npm run attempts-report` | Puzzle health (last 7 days; `--days 30`, `--by layout\|lang\|pv\|build\|nth`): tries, fixed, left, no test, notes, «Where to look?», phone fix rate, flags; First Light by furthest guide step; the first-visit funnel per layout. |
| `npm run attempts-difficulty` | Fitted difficulty per puzzle (`src/attempts/difficulty.ts`: Rasch model with player bands = boards solved before) on the level scale, next to the level the puzzle shows, and whether it predicts held-out attempts better than the shown levels. Needs ~60 engaged attempts. |
| `npm run attempts-compare` | The parallel run of 2026-11-23 only: our numbers next to Umami's. Umami no longer receives puzzle events (it stays on its free plan), so this no longer applies to later dates. |
| `npm run umami -- stats\|events\|home\|values "<event>" <prop>` | Umami Cloud numbers through a logged-in browser (profile in `~/.deadboard/umami-profile`). |

Groups under 10 attempts show as "<10". All read with the Cloudflare login of this machine
(`npx wrangler login`); `--local` reads the `wrangler dev` database.
