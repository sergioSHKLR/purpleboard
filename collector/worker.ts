// Cloudflare Worker entry of DEADBOARD's puzzle-statistics collector (logic in ./core.ts, see README.md).
import { config, d1Store, handle, type Env } from './core';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, d1Store(env.DB), config(env));
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await d1Store(env.DB).maintain(new Date().toISOString().slice(0, 10));
  },
};
