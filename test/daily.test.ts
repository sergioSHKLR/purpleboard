// Daily repair (src/scenarios/daily.ts): the date alone decides board, fault count and seed; the pool
// rotates without repeating a board on consecutive days; every day generates a puzzle that fails the
// bench, the same one twice (so every player gets the same), quickly enough for a phone.
import { builtinScenarios } from '../src/scenarios/builtin';
import { referenceBoard } from '../src/scenarios/reference';
import { DAILY_POOL, dailyKey, dailyLevel, dailyPlan, makeDaily, msToNextDaily } from '../src/scenarios/daily';
import { BOARD_INFO } from '../src/scenarios/catalog';
import { buildConnectivity } from '../src/connectivity';
import { evaluateObjectives } from '../src/verify';
import { serializeScenario } from '../src/io/format';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// dates and the plan
assert(dailyKey(new Date('2026-11-22T23:59:59Z')) === '2026-11-22', 'UTC date, late evening');
assert(dailyKey(new Date('2026-11-23T00:00:00Z')) === '2026-11-23', 'UTC date, midnight');
assert(msToNextDaily(new Date('2026-11-22T23:00:00Z')) === 3_600_000, 'an hour to the next daily');
const a = dailyPlan('2026-11-22'), b = dailyPlan('2026-11-22');
assert(JSON.stringify(a) === JSON.stringify(b), 'same date, same plan');
assert(DAILY_POOL.every((id) => BOARD_INFO[id]), 'pool boards are in the catalogue');
assert(dailyLevel({ boardId: 'builtin-smoke-test', faults: 2 }) === 3.6, 'a second fault adds 0.4');

const keys: string[] = [];
for (let d = Date.parse('2026-11-20T12:00:00Z'), i = 0; i < 20; i++, d += 86_400_000) keys.push(dailyKey(new Date(d)));
const plans = keys.map(dailyPlan);
for (let i = 1; i < plans.length; i++) assert(plans[i].boardId !== plans[i - 1].boardId, `${keys[i]}: same board as the day before`);
for (let i = 0; i + DAILY_POOL.length <= plans.length; i += DAILY_POOL.length) {
  assert(new Set(plans.slice(i, i + DAILY_POOL.length).map((p) => p.boardId)).size === DAILY_POOL.length, 'every pool board once in five days');
}
assert(new Set(plans.map((p) => p.faults)).size === 2, 'both one- and two-fault days');
assert(new Set(plans.map((p) => p.seed)).size === plans.length, 'a new seed every day');
for (const p of plans) assert(dailyLevel(p) >= BOARD_INFO[p.boardId].level && dailyLevel(p) <= 10, `${p.key}: level`);

// every day generates, the same twice, and fails the bench as generated
const builtins = await builtinScenarios();
let slowest = 0;
for (const p of plans) {
  const parent = builtins.find((s) => s.id === p.boardId)!;
  const good = referenceBoard(parent);
  assert(good, `${p.boardId}: no known-good reference`);
  const t0 = performance.now();
  const one = await makeDaily(p, parent, good, `Daily ${p.key}`);
  slowest = Math.max(slowest, performance.now() - t0);
  const two = await makeDaily(p, parent, good, `Daily ${p.key}`);
  assert(one && two, `${p.key} (${p.boardId}): nothing generated`);
  assert(one.scenario.id === p.id, `${p.key}: id`);
  // the flag's encryption takes a fresh random salt each time; the puzzle itself must match
  const puzzle = (x: typeof one) => { const j = JSON.parse(serializeScenario(x!.scenario)); delete j.lock; return JSON.stringify(j) + x!.faults.map((f) => `${f.kind}:${f.ref}`).join(','); };
  assert(puzzle(one) === puzzle(two), `${p.key}: not the same puzzle twice`);
  assert(one.faults.length >= 1 && one.faults.length <= p.faults, `${p.key}: ${one.faults.length} faults for ${p.faults} asked`);
  assert(one.scenario.meta.title === `Daily ${p.key}`, `${p.key}: title`);
  const sc = one.scenario;
  assert(!evaluateObjectives(sc.board, buildConnectivity(sc.board), sc.objectives, 'fast').allPassed, `${p.key}: passes the bench as generated`);
  assert(!!sc.lock, `${p.key}: flag locked`);
}
assert(slowest < 3000, `slowest daily took ${Math.round(slowest)} ms (phones are slower: keep the pool small)`);

console.log(`daily: ok (${plans.length} days, ${DAILY_POOL.length} boards, slowest ${Math.round(slowest)} ms)`);
