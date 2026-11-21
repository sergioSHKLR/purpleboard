// The intended repair of each shipped open-hardware demo (public/demos), shared by the demo
// build (scripts/build-demos.ts), calibration against published values (npm run calibrate --
// --repair) and the full-board regression tests, which all need the known-good board.
import type { Component, Scenario } from '../types';
import { installPart, toggleCold } from '../ops';
import { cleanWithIpa } from '../residue';

export type DemoRepair = (sc: Scenario, part: (ref: string) => Component) => void;

export const DEMO_REPAIRS: Record<string, DemoRepair> = {
  'demo-mnt-reform2-mb30': (sc, part) => {
    installPart(part('C173'), { value: 22e-6 });
    const c97 = part('C97');
    for (let k = 0; k < 6 && c97.state.residue; k++) cleanWithIpa(sc.board, c97.at[0], c97.at[1], 2);
  },
  'demo-antmicro-jetson-nano-bb': (_sc, part) => {
    installPart(part('U2'), {});
    toggleCold(part('FB1'), 0);
  },
  'demo-olimex-esp32-devkit-lipo': (_sc, part) => {
    const d1 = part('D1');
    toggleCold(d1, d1.pads.findIndex((p) => p.name === d1.pins.K));
    installPart(part('R4'), { value: 2200 });
  },
  'demo-olimex-esp32-c3-devkit-lipo': (_sc, part) => {
    installPart(part('C5'), { value: 22e-6 });
    installPart(part('R11'), { value: 49.9e3 });
  },
};

/** A repaired copy of a shipped demo, or null when the scenario is not one. */
export function repairedDemo(sc: Scenario): Scenario | null {
  const fix = DEMO_REPAIRS[sc.id];
  if (!fix) return null;
  const out: Scenario = structuredClone(sc);
  fix(out, (ref) => {
    const c = out.board.components.find((x) => x.ref === ref);
    if (!c) throw new Error(`${sc.id}: no part ${ref}`);
    return c;
  });
  return out;
}
