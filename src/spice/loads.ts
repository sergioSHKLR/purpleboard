// Rail load estimate. Netlists (and boardviews in particular) say nothing about how much
// current the chips on a rail draw, yet boot current is mostly load current. Designers place
// decoupling roughly in proportion to a rail's current, so the number of capacitors on a rail
// is a board-agnostic proxy for its load. The constants are ORDER-OF-MAGNITUDE ESTIMATES
// (a laptop board idling at ~5–10 W in S0) — calibrate them with real measurements.
import type { Board } from '../types';
import type { Conn } from '../connectivity';
import type { PowerStateName } from './sequencer';
import { railVoltage, type PowerTree } from './powertree';

// Chips whose supply current a datasheet states replace the estimate on their rail (data beats
// the decoupling proxy, and the board's caps on that rail are mostly that chip's anyway).
export interface ChipLoadDef {
  /** Part-number prefix as printed in board values. */
  mpn: string;
  /** Supply pin (datasheet / footprint pad name). */
  supply: string;
  /** Enable / reset pin: below its threshold the chip is held in reset and draws ~nothing. */
  enable?: string;
  /** Supply current in the modelled state (A), and what that state is. */
  amps: number;
  state: string;
  /** Below this supply voltage the chip is not running (estimate unless the note says otherwise). */
  vmin: number;
  source: string;
  note?: string;
}

const CHIP_LOADS: ChipLoadDef[] = [
  { mpn: 'ESP32-WROOM-32D', supply: '2', enable: '3', amps: 0.08, state: 'running, Wi-Fi on (average)', vmin: 2.5,
    source: 'Espressif ESP32-WROOM-32D & ESP32-WROOM-32U datasheet v2.4',
    note: 'average operating current 80 mA (the module sheet\'s own figure); supply must deliver ≥ 500 mA (TX peaks are not modelled in DC); VDD33 3.0–3.6 V; EN high = VIH 0.75 × VDD (the input threshold; no separate EN figure). vmin 2.5 V: estimate for the brown-out reset' },
  { mpn: 'ESP32-C3-MINI-1', supply: '3', enable: '8', amps: 0.082, state: 'running, Wi-Fi listening (RX)', vmin: 2.5,
    source: 'Espressif ESP32-C3-MINI-1 & MINI-1U datasheet v1.7',
    note: 'RX 82 mA (802.11b/g/n HT20, Table 12); TX peaks up to 350 mA (802.11b, 20.5 dBm) are not modelled in DC; modem-sleep 16–28 mA; VDD33 3.0–3.6 V; EN high = VIH 0.75 × VDD. vmin 2.5 V: estimate for the brown-out reset' },
];
const chipSorted = [...CHIP_LOADS].sort((a, b) => b.mpn.length - a.mpn.length);
export function findChipLoad(value: string | undefined): ChipLoadDef | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase().replace(/\s+/g, '');
  return chipSorted.find((d) => v.startsWith(d.mpn));
}
export function allChipLoads(): readonly ChipLoadDef[] { return CHIP_LOADS; }

export interface ChipLoad { ref: string; def: ChipLoadDef; supplyNet: number; enableNet?: number }

/**
 * Fitted, working chips the library knows, with the nets of their supply (and enable) pins.
 * `any`: every such chip, dead or removed too (its rail's load is known either way).
 */
export function chipLoads(board: Board, conn: Conn, any = false): ChipLoad[] {
  const out: ChipLoad[] = [];
  for (const c of board.components) {
    const def = findChipLoad(c.label);
    if (!def || (!any && (!c.state.populated || c.state.burnt))) continue;
    const idx = conn.padItem.get(c);
    if (!idx) continue;
    const netOf = (pad: string) => { const i = c.pads.findIndex((p, k) => p.name === pad && (any || !c.state.cold.includes(k))); return i < 0 ? -1 : conn.net[idx[i]]; };
    const supplyNet = netOf(def.supply);
    if (supplyNet < 0) continue;
    const en = def.enable !== undefined ? netOf(def.enable) : undefined;
    out.push({ ref: c.ref, def, supplyNet, ...(en !== undefined && en >= 0 && { enableNet: en }) });
  }
  return out;
}

/** Estimated active power per decoupling capacitor on a rail (W). Estimate, not a measurement. */
export const LOAD_W_PER_CAP = 0.02;
/** Fraction of a rail's active load drawn in each machine state (S0 = fully active). Estimates. */
export const STATE_ACTIVITY: Record<PowerStateName, number> = { G3H: 0.05, S5: 0.1, S4: 0.1, S3: 0.25, S0: 1, S0SW: 1 };

export interface RailLoad { rail: string; v: number; caps: number; watts: number }

/** One load per rail that has a known voltage and is produced by a converter in the tree. */
export function estimateRailLoads(board: Board, conn: Conn, tree: PowerTree): RailLoad[] {
  const produced = new Set(tree.sources.filter((s) => ['buck', 'boost', 'ldo', 'load-switch'].includes(s.kind)).map((s) => s.output));
  const caps = new Map<number, number>();
  for (const c of board.components) {
    if (c.kind !== 'capacitor' || !c.state.populated) continue;
    const idx = conn.padItem.get(c);
    if (!idx) continue;
    const nets = new Set(idx.map((i) => conn.net[i]).filter((n) => n >= 0));
    for (const n of nets) caps.set(n, (caps.get(n) ?? 0) + 1);
  }
  const out: RailLoad[] = [];
  const seen = new Set<string>();
  // datasheet loads replace the estimate, also while that chip is dead (the caps were its own)
  const known = new Set(chipLoads(board, conn, true).map((l) => l.supplyNet));
  conn.netNames.forEach((name, net) => {
    if (seen.has(name) || !produced.has(name) || known.has(net)) return;
    const v = tree.rails.get(name)?.v ?? railVoltage(name);
    const n = caps.get(net) ?? 0;
    if (!v || n === 0) return;
    seen.add(name);
    out.push({ rail: name, v, caps: n, watts: n * LOAD_W_PER_CAP });
  });
  return out;
}

/** Load power of a rail in a machine state (a rail that is not up draws nothing anyway). */
export function loadWatts(l: RailLoad, state: PowerStateName): number {
  return l.watts * STATE_ACTIVITY[state];
}
