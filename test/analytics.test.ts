// Website analytics: only the public site with a real id is tracked; active-time milestones fire once each.
import { analyticsEnabled, milestonesCrossed, MILESTONES, SITE_HOST, trackBoardView, trackEvent } from '../src/analytics';

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
assert(JSON.stringify(milestonesCrossed(100, 650)) === '[2,5,10]', 'a long jump fires every passed milestone');
// summing 15 s ticks over 5 hours fires every milestone exactly once
const fired: number[] = [];
for (let s = 0; s < 5 * 3600; s += 15) fired.push(...milestonesCrossed(s, s + 15));
assert(JSON.stringify(fired) === JSON.stringify(MILESTONES), `all milestones once: ${fired}`);

// bench events: no-ops without the Umami script (apps, dev); a board change is a page view of /board/<id>
const g = globalThis as { window?: unknown };
const hadWindow = 'window' in g, oldWindow = g.window;
g.window = {};
trackEvent('board fixed', { board: 'x' }); // no umami: must not throw
const sent: unknown[] = [];
g.window = { umami: { track: (a: unknown, b?: unknown) => sent.push(typeof a === 'function' ? a({ website: 'w', url: '/app.html' }) : [a, b]) } };
trackEvent('board fixed', { board: 'builtin-first-light' });
trackBoardView('builtin-first-light', 'First Light');
if (hadWindow) g.window = oldWindow; else delete g.window;
assert(JSON.stringify(sent[0]) === '["board fixed",{"board":"builtin-first-light"}]', `event sent: ${JSON.stringify(sent[0])}`);
const view = sent[1] as Record<string, string>;
assert(view.url === '/board/builtin-first-light' && view.title === 'First Light' && view.website === 'w', `board view: ${JSON.stringify(view)}`);

console.log('analytics: ok');
