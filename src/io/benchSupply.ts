// Where to clip the bench supply on an imported board. Design files describe the board, not
// the bench: there is no "supply" part, and the batteries a layout does contain are usually RTC
// coin cells. The supply goes on the board's main input rail: a root rail of the power tree
// (feeds converters, produced by nothing on the board), preferring input-style names and rails
// that reach a connector. Its voltage comes from the rail name; otherwise a labelled assumption.
import type { Board, Component, Side, V2 } from '../types';
import { buildConnectivity } from '../connectivity';
import { padWorld } from '../model';
import { discoverPowerTree, isGroundName, netBase, railVoltage } from '../spice/powertree';

/** Bench voltage used when the input rail's name states none (a common laptop / SBC brick). */
export const ASSUMED_INPUT_VOLTS = 12;

const INPUT_NAME = /^(VIN|DCIN|DC_IN|VDC|VBAT|VSYS|PPBUS|VMAIN|VBUS|PP_?DCIN|V_IN|PWR_IN|VCC_IN)/i;

export interface SupplyChoice { net: string; volts: number; assumed: boolean; why: string }

/** Picks the input rail, or null when the board has no power tree to feed. */
export function chooseInputRail(board: Board): SupplyChoice | null {
  const conn = buildConnectivity(board);
  const tree = discoverPowerTree(board, conn);
  const produced = new Set(tree.sources.map((s) => s.output));
  const feeds = new Map<string, number>();
  for (const s of tree.sources) if (s.input && !produced.has(s.input)) feeds.set(s.input, (feeds.get(s.input) ?? 0) + 1);
  if (!feeds.size) return null;
  const onConnector = new Set<string>();
  for (const c of board.components) if (c.kind === 'connector') for (const p of c.pads) if (p.net) onConnector.add(p.net);
  let best: { net: string; score: number } | null = null;
  for (const [net, n] of feeds) {
    const base = netBase(net);
    const v = railVoltage(base);
    const score = n + (INPUT_NAME.test(base) ? 3 : 0) + (onConnector.has(net) ? 2 : 0) + (v !== null ? v / 10 : 0);
    if (!best || score > best.score) best = { net, score };
  }
  const base = netBase(best!.net);
  const named = railVoltage(base);
  if (named !== null) return { net: best!.net, volts: named, assumed: false, why: `rail name ${base}` };
  if (/VBUS|USB/i.test(base)) return { net: best!.net, volts: 5, assumed: true, why: 'USB VBUS (5 V)' };
  return { net: best!.net, volts: ASSUMED_INPUT_VOLTS, assumed: true, why: `no voltage in the name ${base}: ${ASSUMED_INPUT_VOLTS} V assumed` };
}

/** Adds a bench supply ("J_BENCH") on the chosen input rail, next to one of its pads. */
export function addBenchSupply(board: Board, choice: SupplyChoice, nextId: () => number): Component | null {
  let posPt: { at: V2; side: Side } | null = null, negPt: { at: V2; side: Side } | null = null;
  for (const c of board.components) {
    for (const p of c.pads) {
      if (!posPt && p.net === choice.net) posPt = { at: padWorld(c, p).at, side: c.side };
      if (!negPt && p.net && isGroundName(netBase(p.net))) negPt = { at: padWorld(c, p).at, side: c.side };
    }
  }
  if (!posPt || !negPt) return null;
  const gndNet = board.components.flatMap((c) => c.pads).find((p) => p.net && isGroundName(netBase(p.net)))!.net!;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const sup: Component = {
    id: 'c' + nextId().toString(36),
    ref: 'J_BENCH',
    kind: 'battery',
    value: choice.volts,
    label: `Bench supply → ${netBase(choice.net)}${choice.assumed ? ' (voltage assumed)' : ''}`,
    at: [posPt.at[0], posPt.at[1]],
    rot: 0,
    side: posPt.side,
    pads: [
      { name: '1', at: [0, 0], size: [1.0, 1.0], shape: 'rect', layers: 'FB', net: choice.net },
      { name: '2', at: [r3(negPt.at[0] - posPt.at[0]), r3(negPt.at[1] - posPt.at[1])], size: [1.0, 1.0], shape: 'circle', layers: 'FB', net: gndNet },
    ],
    pins: { '+': '1', '-': '2' },
    body: { shape: 'header', w: 2.5, h: 2.5, z: 3.0 },
    state: { populated: true, reversed: false, burnt: false, cold: [] },
  };
  board.components.push(sup);
  return sup;
}
