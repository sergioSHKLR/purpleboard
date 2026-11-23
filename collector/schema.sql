-- DEADBOARD puzzle statistics (collector/worker.ts). One row per attempt, one column per field of
-- src/attempts/record.ts, plus the UTC day it arrived. No IP address, no user / device id, no
-- time of day. `attempt` (a random per-attempt token) is erased the day after (cron), and rows
-- older than 90 days are folded into `totals` and deleted.

CREATE TABLE IF NOT EXISTS attempts (
  attempt   TEXT UNIQUE,          -- random per attempt; NULL once erased
  day       TEXT NOT NULL,        -- YYYY-MM-DD (UTC), set by the collector
  v         INTEGER NOT NULL,
  build     TEXT NOT NULL,
  puzzle    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  src       TEXT NOT NULL,        -- record field "from"
  pv        TEXT NOT NULL,
  level     REAL NOT NULL,
  faults    INTEGER NOT NULL,
  outcome   TEXT NOT NULL,
  active    TEXT NOT NULL,
  moves     TEXT NOT NULL,
  probes    TEXT NOT NULL,
  tests     TEXT NOT NULL,
  first_test TEXT NOT NULL,
  notes     INTEGER NOT NULL,
  look      TEXT NOT NULL,
  video     TEXT NOT NULL,
  tools     TEXT NOT NULL,        -- comma-separated, sorted
  tut       INTEGER NOT NULL,
  layout    TEXT NOT NULL,
  lang      TEXT NOT NULL,
  nth       TEXT NOT NULL,
  solved    TEXT NOT NULL,
  days      TEXT NOT NULL,
  ab        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_day ON attempts (day);

-- Kept after the raw rows expire: counts per day, puzzle, layout and outcome.
CREATE TABLE IF NOT EXISTS totals (
  day     TEXT NOT NULL,
  puzzle  TEXT NOT NULL,
  src     TEXT NOT NULL,
  layout  TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (day, puzzle, src, layout, outcome)
);

-- Rows accepted per day: the collector stops accepting above its daily cap (free-plan safety).
CREATE TABLE IF NOT EXISTS daily_count (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- The public summary (src/attempts/summary.ts), rebuilt every 6 hours: one row.
CREATE TABLE IF NOT EXISTS summary (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  made TEXT NOT NULL,
  json TEXT NOT NULL
);
