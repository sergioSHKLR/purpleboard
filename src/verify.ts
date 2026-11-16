import type { Board, Objective, Scenario, SwitchMap } from './types';
import { buildConnectivity, pinNet, type Conn } from './connectivity';
import { unlockFlag, topology } from './crypto';
import { netVoltage, simulate, type Sim, type SimOpts } from './sim';
import { simulateSpice } from './spice/adapter';
import type { PowerStateName } from './spice/sequencer';

/** 'fast' = piecewise-linear DC solver, 'spice' = SPICE engine, 'spice-power' = SPICE + behavioral regulators from the power tree. */
export type Solver = 'fast' | 'spice' | 'spice-power';

export function runSolver(solver: Solver, board: Board, conn: Conn, opt: SimOpts & { meters?: [number, number][]; powerState?: PowerStateName; ammeter?: { a: number; b: number; ohms: number }; loadScale?: number } = {}): Sim {
  if (solver === 'fast') return simulate(board, conn, opt);
  return simulateSpice(board, conn, { ...opt, powerTree: solver === 'spice-power' });
}

export interface ObjectiveResult {
  objective: Objective;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  allPassed: boolean;
  results: ObjectiveResult[];
  overloads: { ref: string; msg: string }[];
  flag: string | null;
  topologyMismatch: boolean;
}

function switchKey(sw?: SwitchMap): string {
  if (!sw) return '';
  return Object.keys(sw).sort().map((k) => `${k}=${sw[k] ? 1 : 0}`).join('&');
}

function formatSwitches(sw?: SwitchMap): string {
  if (!sw) return '';
  const parts = Object.entries(sw).map(([k, v]) => `${k} ${v ? 'pressed' : 'released'}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function resolveProbeNet(board: Board, conn: Conn, ref: string): number {
  const c = board.components.find((x) => x.ref === ref);
  if (!c) return -1;
  const firstRole = Object.keys(c.pins)[0];
  return firstRole ? pinNet(conn, c, firstRole) : -1;
}

export function evaluateObjectives(board: Board, conn: Conn, objectives: Objective[], solver: Solver = 'fast'): {
  allPassed: boolean;
  results: ObjectiveResult[];
  overloads: { ref: string; msg: string }[];
} {
  const sims = new Map<string, Sim>();
  // The SPICE solver models the test-bench voltmeter (10 MΩ) on every probed net.
  const meters: [number, number][] = [];
  for (const o of objectives) {
    if (o.type !== 'voltage') continue;
    const a = resolveProbeNet(board, conn, o.a);
    if (a >= 0) meters.push([a, o.b ? resolveProbeNet(board, conn, o.b) : -1]);
  }
  const getSim = (sw?: SwitchMap): Sim => {
    const key = switchKey(sw);
    let s = sims.get(key);
    if (!s) {
      // with regulator models the test bench checks the board fully on
      s = runSolver(solver, board, conn, { ...(sw && { switches: sw }), meters, ...(solver === 'spice-power' && { powerState: 'S0SW' as const }) });
      sims.set(key, s);
    }
    return s;
  };

  // Ensure default simulation runs to catch overloads even if objectives list is empty.
  if (objectives.length === 0) getSim(undefined);

  const overloads: { ref: string; msg: string }[] = [];
  const seenOver = new Set<string>();
  const collectOverloads = (s: Sim) => {
    for (const c of board.components) {
      const r = s.comps.get(c.id);
      if (r?.over && !seenOver.has(c.ref)) {
        seenOver.add(c.ref);
        overloads.push({ ref: c.ref, msg: r.overMsg ?? 'overloaded' });
      }
    }
  };

  const results: ObjectiveResult[] = objectives.map((obj) => {
    const s = getSim(obj.switches);
    collectOverloads(s);

    if (obj.type === 'led') {
      const comp = board.components.find((c) => c.ref === obj.ref);
      const r = comp ? s.comps.get(comp.id) : undefined;
      const isOn = !!r?.on && !r?.over;
      const passed = isOn === obj.on;
      const label = `${obj.ref} must be ${obj.on ? 'ON' : 'OFF'}${formatSwitches(obj.switches)}`;
      const detail = !comp
        ? `${obj.ref} not found`
        : !comp.state.populated
          ? `${obj.ref} is unpopulated`
          : comp.state.burnt
            ? `${obj.ref} is burnt`
            : r?.over
              ? `${obj.ref} overloaded (${r.overMsg})`
              : `${obj.ref} is ${isOn ? 'ON' : 'OFF'} (${((r?.i ?? 0) * 1000).toFixed(1)} mA)`;
      return { objective: obj, label, passed, detail };
    }

    // Voltage objective
    const na = resolveProbeNet(board, conn, obj.a);
    const va = na >= 0 ? netVoltage(s, na) : null;
    let vb: number | null = 0;
    if (obj.b) {
      const nb = resolveProbeNet(board, conn, obj.b);
      vb = nb >= 0 ? netVoltage(s, nb) : null;
    }
    const diff = va !== null && vb !== null ? va - vb : null;
    const passed = diff !== null && diff >= obj.min && diff <= obj.max && overloads.length === 0;
    const target = obj.b ? `${obj.a} − ${obj.b}` : obj.a;
    const label = `V(${target}) in [${obj.min.toFixed(2)} V, ${obj.max.toFixed(2)} V]${formatSwitches(obj.switches)}`;
    const detail = diff === null ? 'Floating / no power' : `Measured ${diff.toFixed(3)} V`;
    return { objective: obj, label, passed, detail };
  });

  if (sims.size === 1) {
    for (const s of sims.values()) collectOverloads(s);
  }

  const allPassed = results.length > 0 && results.every((r) => r.passed) && overloads.length === 0;
  return { allPassed, results, overloads };
}

export async function verifyScenario(scenario: Scenario, board: Board = scenario.board, solver: Solver = 'fast'): Promise<VerifyResult> {
  const conn = buildConnectivity(board);
  const { allPassed, results, overloads } = evaluateObjectives(board, conn, scenario.objectives, solver);
  let flag: string | null = null;
  let topologyMismatch = false;

  if (allPassed && scenario.lock) {
    const topo = topology(board, conn, scenario.id);
    flag = await unlockFlag(scenario.lock, topo);
    if (flag === null) topologyMismatch = true;
  }

  return { allPassed, results, overloads, flag, topologyMismatch };
}
