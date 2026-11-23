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
2. `npx --yes wrangler@4 d1 create deadboard-attempts --location weur` and put the printed
   `database_id` into `wrangler.toml`.
3. `npx --yes wrangler@4 d1 execute deadboard-attempts --remote --file schema.sql`
4. `npx --yes wrangler@4 deploy` (creates `stats.deadboard.org` with its certificate).
5. Set the repository variable `ATTEMPTS_URL` to `https://stats.deadboard.org/v1/attempt`; the Pages
   workflow passes it to the build as `VITE_ATTEMPTS_URL`. Without it the game sends nothing.

## Reading it

`npm run attempts-report` (last 7 days; `-- --days 30`). Groups under 10 attempts show as "<10".
