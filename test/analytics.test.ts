// Website analytics: only the public site with a real id is tracked; active-time milestones fire once each.
import { analyticsEnabled, milestonesCrossed, MILESTONES, scrollBucket, secondsBucket, SITE_HOST, trackEvent } from '../src/analytics';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const id = '94db1cb1-74f4-4a40-ad6c-962362670409';
assert(analyticsEnabled(id, SITE_HOST), 'public site with an id: tracked');
assert(!analyticsEnabled('', SITE_HOST), 'no id (forks, unset variable): not tracked');
assert(!analyticsEnabled('nonsense', SITE_HOST), 'malformed id: not tracked');
for (const host of ['localhost', '127.0.0.1', '', 'tholtman1-del.github.io', 'someone-else.github.io', 'deadboard.local']) {
  assert(!analyticsEnabled(id, host), `${host || 'app (file:// / custom scheme)'}: not tracked`);
}

assert(milestonesCrossed(0, 59).length === 0, 'under a minute: nothing');
assert(JSON.stringify(milestonesCrossed(45, 60)) === '[1]', 'reaching 60 s fires 1 min');
assert(milestonesCrossed(60, 75).length === 0, 'a milestone fires only once');
assert(JSON.stringify(milestonesCrossed(30, 950)) === '[1,5,15]', 'a long jump fires every passed milestone');
// summing 15 s ticks over 5 hours fires every milestone exactly once
const fired: number[] = [];
for (let s = 0; s < 5 * 3600; s += 15) fired.push(...milestonesCrossed(s, s + 15));
assert(JSON.stringify(fired) === JSON.stringify(MILESTONES), `all milestones once: ${fired}`);

// leave events: time and scroll depth only as ranges
assert(['0', 4.9, 5, 14.9, 15, 29, 30, 59.9, 60, 3600].map((x) => secondsBucket(+x)).join() === '<5s,<5s,5-15s,5-15s,15-30s,15-30s,30-60s,30-60s,60s+,60s+', 'seconds ranges');
assert([0, 0.1, 0.25, 0.5, 0.74, 0.75, 0.99, 1, 1.4, -1].map(scrollBucket).join() === '0%,0%,25%,50%,50%,75%,75%,100%,100%,0%', 'scroll quarters');

// bench events: no-ops without the Umami script (apps, dev)
const g = globalThis as { window?: unknown };
const hadWindow = 'window' in g, oldWindow = g.window;
g.window = {};
trackEvent('board fixed', { board: 'x' }); // no umami: must not throw
const sent: unknown[] = [];
g.window = { umami: { track: (a: unknown, b?: unknown) => sent.push(typeof a === 'function' ? a({ website: 'w', url: '/app.html' }) : [a, b]) } };
trackEvent('board fixed', { board: 'builtin-first-light' });
if (hadWindow) g.window = oldWindow; else delete g.window;
assert(JSON.stringify(sent[0]) === '["board fixed",{"board":"builtin-first-light"}]', `event sent: ${JSON.stringify(sent[0])}`);
assert(sent.length === 1, `one call: ${JSON.stringify(sent)}`);

console.log('analytics: ok');
