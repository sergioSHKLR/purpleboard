// Solver agreement: the fast piecewise-linear solver (src/sim.ts) and the SPICE engine
// (src/spice/adapter.ts) must give the player the same meter readings.
import { buildConnectivity, type Conn } from '../src/connectivity';
import { parseScenario } from '../src/io/format';
import { measureDiode, measureOhms, simulate } from '../src/sim';
import { measureDiodeSpice, simulateSpice } from '../src/spice/adapter';
import type { Board } from '../src/types';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc: 'utf8'): string }

const netOf = (b: Board, conn: Conn, ref: string, pad: string) => {
  const c = b.components.find((x) => x.ref === ref)!;
  return conn.net[conn.padItem.get(c)![c.pads.findIndex((p) => p.name === pad)]];
};
const volts = (s: { nodeOfNet: Map<number, number>; V: Float64Array }, net: number) => {
  const k = s.nodeOfNet.get(net);
  return k === undefined ? 0 : s.V[k];
};

async function run() {
  const modName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ modName)) as Fs;

  // ---- a net nothing drives reads ~0 V, not a divider of leakage terms ----
  // Night-light challenge: BT1 3 V → SW1 → R1 → D1. With SW1 open, R1.1 (net SW) is driven by
  // nothing; a real meter's 10 MΩ input pulls it to 0 V. The fast solver used to stamp the open
  // switch with the same 1 nS as its node shunts and read exactly +1.000 V there.
  {
    const sc = parseScenario(fs.readFileSync('examples/mods/starter-kit/boards/night-light-repair.pcbfix.json', 'utf8'));
    const b = sc.board, conn = buildConnectivity(b);
    const sw = netOf(b, conn, 'R1', '1'), vbat = netOf(b, conn, 'SW1', '1');
    for (const meters of [undefined, [[sw, -1]] as [number, number][]]) {
      const f = simulate(b, conn, { switches: { SW1: false }, meters });
      const s = simulateSpice(b, conn, { switches: { SW1: false }, meters });
      assert(Math.abs(volts(f, sw)) < 1e-3, `fast: floating R1.1 reads ${volts(f, sw).toFixed(4)} V (meters ${!!meters}), want ~0`);
      assert(Math.abs(volts(s, sw)) < 1e-3, `spice: floating R1.1 reads ${volts(s, sw).toFixed(4)} V, want ~0`);
      assert(Math.abs(volts(f, vbat) - 3) < 0.01, 'fast: BT1 side of SW1 still at 3 V');
    }
    const f = simulate(b, conn, { switches: { SW1: true } });
    assert(Math.abs(volts(f, sw) - 3) < 0.01, `fast: SW1 closed puts ~3 V on R1.1 (got ${volts(f, sw).toFixed(3)})`);
    // power off: across the open switch the ohmmeter reads OL, the diode test OL
    assert(measureOhms(b, conn, sw, vbat) === Infinity, 'open switch reads OL in Ω mode');
    assert(measureDiode(b, conn, sw, vbat).volts === Infinity && measureDiodeSpice(b, conn, sw, vbat).volts === Infinity, 'open switch reads OL in diode mode');
  }

  console.log('DIFFERENTIAL TESTS PASSED (floating net ~0 V in both solvers)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
