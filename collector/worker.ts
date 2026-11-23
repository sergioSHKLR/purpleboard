// Cloudflare Worker entry of DEADBOARD's puzzle-statistics collector (logic in ./core.ts, see README.md).
import { config, d1Store, handle, type Env } from './core';

/** The nightly upkeep's schedule (wrangler.toml); the other schedule only rebuilds the summary. */
const MAINTAIN_CRON = '17 3 * * *';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, d1Store(env.DB), config(env));
  },
  async scheduled(event: { cron: string }, env: Env): Promise<void> {
    const store = d1Store(env.DB), now = new Date();
    if (event.cron === MAINTAIN_CRON) await store.maintain(now.toISOString().slice(0, 10));
    await store.refreshSummary(now);
  },
};
