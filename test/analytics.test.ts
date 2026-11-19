// Website analytics: only the public site with a real id is tracked; active-time milestones fire once each.
import { analyticsEnabled, milestonesCrossed, MILESTONES, SITE_HOST } from '../src/analytics';

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

console.log('analytics: ok');
