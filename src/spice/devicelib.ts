// Discrete semiconductor library: datasheet key specs → fitted SPICE models + pin maps.
//
// Each entry stores the *datasheet quantities* (Rds(on) at given Vgs, Vf at given If, hFE…)
// and the pad→terminal map; SPICE parameters are fitted from them at build time, so a spec
// correction automatically corrects the model.
//
// Provenance: `verified: true` only when every number in the entry was read from the
// manufacturer datasheet named in `source` (typical column; a value the datasheet gives only as
// a limit, or derived from limits, is called out in `note`). Entries checked only against
// datasheet limits, or whose datasheet was not read, stay `verified: false` and say so in
// `note`. Numbers are facts transcribed from the documents; no datasheet text is copied.
import type { PartSpec } from './board';
import { VT_300K } from './devices';
import { formatSpiceNumber as fmt } from './units';

export interface MosSpec {
  kind: 'nmos' | 'pmos';
  /** |VGS(th)| typical (V). */
  vth: number;
  /** Rds(on) typical (Ω) at |VGS| (V); two points allow fitting threshold + gain from the on-curve. */
  rds: [number, number][];
  /** Body diode |VSD| (V) at |IS| (A). */
  body?: [number, number];
  /** Ciss, Crss, Coss (F). */
  caps?: [number, number, number];
  pins: { D: string; G: string; S: string };
}
export interface BjtSpec { kind: 'npn' | 'pnp'; hfe: number; vbe: [number, number]; vaf?: number; pins: { C: string; B: string; E: string } }
export interface DiodeSpec {
  kind: 'diode' | 'schottky' | 'zener' | 'led' | 'tvs-bi';
  /** Forward points (V, A). */
  vf: [number, number][];
  /** Reverse breakdown / zener voltage (V) at current (A). */
  bv?: [number, number];
  cj?: number;
  pins: { A: string; K: string };
}
export type UnitSpec = MosSpec | BjtSpec | DiodeSpec;

export interface DeviceDef {
  mpn: string;
  description: string;
  pkg: string;
  units: UnitSpec[];
  verified: boolean;
  /** Datasheet the numbers were read from: maker, document id, revision, date. */
  source?: string;
  /** Junction-to-ambient thermal resistance (°C/W) as the datasheet states it (condition in `note`). */
  thetaJA?: number;
  note?: string;
}

// Pin numbers are DATASHEET pin numbers. Multi-pin packages (SOT, SON, PowerPAK…) follow
// IPC numbering, so footprint pad = datasheet pin on practically every CAD library. Two-pin
// diodes are the exception — libraries disagree on whether pad 1 is the anode or cathode —
// so their mapping is resolved per board from netlist evidence (see inferDiodeConvention).
const DEVICES: DeviceDef[] = [
  { mpn: 'FDC638APZ', description: 'P-MOSFET −20 V −4.5 A', pkg: 'SuperSOT-6 (TSOT-23-6)', verified: true,
    source: 'onsemi FDC638APZ/D Rev. 3, Nov 2023', thetaJA: 156,
    note: 'θJA on the minimum pad (note 1b)',
    units: [{ kind: 'pmos', vth: 0.8, rds: [[4.5, 0.037], [2.5, 0.052]], body: [0.8, 1.3], caps: [750e-12, 130e-12, 155e-12], pins: { D: '1', G: '3', S: '4' } }] },
  { mpn: 'DMN5L06VK', description: 'dual N-MOSFET 50 V 0.28 A', pkg: 'SOT-563', verified: true,
    source: 'Diodes Inc. DS30769 Rev. 15-3, Nov 2024', thetaJA: 500,
    note: 'the table gives limits only (VGS(th) 0.49–1.0 V, RDS(on) ≤ 2.0 Ω at 5 V, VSD 0.5–1.4 V, Ciss ≤ 50 pF): typicals read from Figs. 3, 6, 8 and 9 at 25 °C (about ±10 %); no typical capacitance: omitted',
    units: [
      { kind: 'nmos', vth: 0.8, rds: [[10, 1.05], [5, 1.15]], body: [0.75, 0.1], pins: { D: '6', G: '2', S: '1' } },
      { kind: 'nmos', vth: 0.8, rds: [[10, 1.05], [5, 1.15]], body: [0.75, 0.1], pins: { D: '3', G: '5', S: '4' } },
    ] },
  { mpn: 'DMN32D2LFB4', description: 'N-MOSFET 30 V small signal', pkg: 'X2-DFN1006-3', verified: true,
    source: 'Diodes Inc. DS31124 Rev. 9-2, Aug 2015', thetaJA: 357,
    note: 'the table gives RDS(on), VGS(th) and VSD as limits only (RDS(on) ≤ 1.2 Ω at 4 V, ≤ 1.5 Ω at 2.5 V; VGS(th) 0.6–1.2 V): their typicals are read from Figs. 3, 5, 6 and 8 at 25 °C (about ±10 %). Capacitances are table typicals. The pin-out drawing names no pin numbers: pads net-checked per board',
    units: [{ kind: 'nmos', vth: 0.75, rds: [[4, 0.8], [1.8, 1.5]], body: [0.8, 0.2], caps: [39e-12, 3.6e-12, 10e-12], pins: { G: '1', S: '2', D: '3' } }] },
  { mpn: 'NTUD3169CZ', description: 'complementary N+P MOSFET 20 V', pkg: 'SOT-963', verified: true,
    source: 'onsemi NTUD3169CZ/D Rev. 2, Jun 2025', thetaJA: 1000,
    note: 'VGS(th) has no typical (0.4–1.0 V): midpoint used. Pinout matches package style 9; which unit is N is net-checked per board. θJA on the minimum pad',
    units: [
      { kind: 'nmos', vth: 0.7, rds: [[4.5, 0.75], [2.5, 1.0]], body: [0.6, 0.01], caps: [12.5e-12, 2.6e-12, 3.6e-12], pins: { S: '1', G: '2', D: '6' } },
      { kind: 'pmos', vth: 0.7, rds: [[4.5, 2.0], [2.5, 2.6]], body: [0.6, 0.01], caps: [13.5e-12, 2.0e-12, 3.8e-12], pins: { D: '3', S: '4', G: '5' } },
    ] },
  { mpn: 'SI5419DU', description: 'P-MOSFET −30 V (DC-in isolation)', pkg: 'PowerPAK ChipFET single', verified: true,
    source: 'Vishay Si5419DU, doc. 69001 Rev. B, 07-Feb-2011', thetaJA: 34,
    note: 'VGS(th) has no typical (1.2–2.5 V): midpoint used. Pinout not legible in the text extraction: pads net-checked per board. θJA typical, t ≤ 5 s on 1" × 1" FR4',
    units: [{ kind: 'pmos', vth: 1.85, rds: [[10, 0.016], [4.5, 0.027]], body: [0.85, 7.9], caps: [1400e-12, 200e-12, 240e-12], pins: { S: '1', G: '4', D: '5' } }] },
  { mpn: 'SI7137DP', description: 'P-MOSFET −20 V (battery FET)', pkg: 'PowerPAK SO-8', verified: true,
    source: 'Vishay Si7137DP, doc. 69063 Rev. D, 18-May-2009', thetaJA: 15,
    note: 'VGS(th) has no typical (0.5–1.4 V): midpoint used. θJA typical, t ≤ 10 s on 1" × 1" FR4 (54 °C/W max steady state)',
    units: [{ kind: 'pmos', vth: 0.95, rds: [[10, 0.0016], [4.5, 0.002]], body: [0.64, 5], caps: [20000e-12, 2650e-12, 2150e-12], pins: { S: '1', G: '4', D: '5' } }] },
  { mpn: 'SI8409DB', description: 'P-MOSFET −30 V load switch', pkg: 'MICRO FOOT 1.6x1.6', verified: true,
    source: 'Vishay Si8409DB, doc. 73111 Rev. D, 20-Jul-2015', thetaJA: 72,
    note: 'VGS(th) has no typical (0.6–1.4 V): midpoint used. Capacitances only as a graph: omitted. θJA typical, steady state',
    units: [{ kind: 'pmos', vth: 1.0, rds: [[4.5, 0.038], [2.5, 0.052]], body: [0.8, 1], pins: { G: '1', D: '2', S: '4' } }] },
  { mpn: 'IRF9395', description: 'dual P-MOSFET −30 V, common drain (inrush/back-to-back)', pkg: 'DirectFET MC dual', verified: true,
    source: 'Infineon (IR) IRF9395MTRPbF datasheet, revision history to 2014-02-24',
    note: 'drains common on the thermal pads (no boardview net); body diodes oppose. VSD given only as a maximum (1.2 V at 11 A). Package is DirectFET, not PQFN: pad numbers come from the board footprint (net-checked)',
    units: [
      { kind: 'pmos', vth: 1.8, rds: [[10, 0.0053], [4.5, 0.009]], body: [1.2, 11], caps: [3241e-12, 466e-12, 820e-12], pins: { S: '1', G: '3', D: '7' } },
      { kind: 'pmos', vth: 1.8, rds: [[10, 0.0053], [4.5, 0.009]], body: [1.2, 11], caps: [3241e-12, 466e-12, 820e-12], pins: { S: '4', G: '6', D: '7' } },
    ] },
  { mpn: 'SISA18DN', description: 'N-MOSFET 30 V (VR high side)', pkg: 'PowerPAK 1212-8S', verified: false,
    note: 'datasheet not retrieved: unverified estimates',
    units: [{ kind: 'nmos', vth: 1.6, rds: [[10, 0.0054], [4.5, 0.0076]], body: [0.75, 5], caps: [1100e-12, 60e-12, 300e-12], pins: { S: '1', G: '4', D: '5' } }] },
  { mpn: 'SISA12DN', description: 'N-MOSFET 30 V (VR low side)', pkg: 'PowerPAK 1212-8S', verified: false,
    note: 'datasheet not retrieved: unverified estimates',
    units: [{ kind: 'nmos', vth: 1.4, rds: [[10, 0.0026], [4.5, 0.0034]], body: [0.7, 5], caps: [2600e-12, 140e-12, 600e-12], pins: { S: '1', G: '4', D: '5' } }] },
  { mpn: 'CSD58873Q3D', description: 'synchronous buck power block 30 V', pkg: 'SON 3.3x3.3', verified: false,
    note: 'TGR (pad 4) is the control-FET source sense, tied internally to VSW. Datasheet not retrieved: unverified estimates',
    units: [
      { kind: 'nmos', vth: 1.4, rds: [[8, 0.0092], [4.5, 0.011]], body: [0.8, 5], caps: [900e-12, 50e-12, 250e-12], pins: { D: '1', G: '3', S: '6' } },
      { kind: 'nmos', vth: 1.2, rds: [[8, 0.0041], [4.5, 0.0049]], body: [0.7, 5], caps: [1900e-12, 90e-12, 500e-12], pins: { D: '6', G: '5', S: '9' } },
    ] },
  { mpn: 'NTMFD4902NF', description: 'dual N-MOSFET power stage 30 V (charger)', pkg: 'SO-8FL dual', verified: true,
    source: 'onsemi NTMFD4902NF/D Rev. 5, May 2019', thetaJA: 65.9,
    note: 'VGS(th) has no typical (1.2–2.2 V): midpoint used. Q2 has an integrated Schottky (VSD 0.37 V at 2 A). θJA of Q1 on 1 in² 2 oz Cu (Q2 62.8)',
    units: [
      { kind: 'nmos', vth: 1.7, rds: [[10, 0.0052], [4.5, 0.008]], body: [0.75, 3], caps: [1150e-12, 105e-12, 360e-12], pins: { D: '2', G: '1', S: '10' } },
      { kind: 'nmos', vth: 1.7, rds: [[10, 0.0033], [4.5, 0.005]], body: [0.37, 2], caps: [1590e-12, 83e-12, 813e-12], pins: { D: '10', G: '8', S: '5' } },
    ] },
  { mpn: 'BC846BLP', description: 'NPN 65 V (thermal-sense diode)', pkg: 'X2-DFN1006-3', verified: false,
    note: 'datasheet not retrieved: unverified estimates',
    units: [{ kind: 'npn', hfe: 290, vbe: [0.66, 2e-3], vaf: 100, pins: { B: '1', E: '2', C: '3' } }] },
  { mpn: 'MMBT3904LP', description: 'NPN 40 V general purpose', pkg: 'X2-DFN1006-3', verified: false,
    source: 'Diodes Inc. DS31835 Rev. 7, Aug 2023', thetaJA: 310,
    note: 'hFE typical ≈ 200 at 1–10 mA read from Fig. 4 (table: 100–300 at 10 mA). VBE stays an estimate (Fig. 7 temperature labels are inconsistent; VBE(sat) 0.65–0.85 V at 10 mA), Early voltage not specified: unverified',
    units: [{ kind: 'npn', hfe: 200, vbe: [0.65, 10e-3], vaf: 100, pins: { B: '1', E: '2', C: '3' } }] },
  { mpn: 'RB160M-60', description: 'Schottky 60 V 1 A', pkg: 'PMDU (SOD-123F class)', verified: true,
    source: 'ROHM RB160M-60 datasheet, 3 pages (revision not printed on the copy read)',
    note: 'VF typical 0.54 V at 1 A from the table; 10 mA and 0.1 A points read from Fig. 1 at 25 °C (about ±15 mV); CJO ≈ the 0 V end of Fig. 3. BV is the 60 V reverse rating, not a measured breakdown',
    units: [{ kind: 'schottky', vf: [[0.265, 0.01], [0.33, 0.1], [0.54, 1]], bv: [60, 1e-3], cj: 200e-12, pins: { K: '1', A: '2' } }] },
  { mpn: 'RB521ES-30', description: 'Schottky 30 V 0.2 A', pkg: 'SOD-523', verified: false,
    note: 'datasheet not retrieved: unverified estimates',
    units: [{ kind: 'schottky', vf: [[0.3, 0.01], [0.45, 0.2]], bv: [30, 1e-3], cj: 10e-12, pins: { K: '1', A: '2' } }] },
  { mpn: 'NSR1020MW2', description: 'Schottky 20 V 1 A', pkg: 'SOD-323', verified: true,
    source: 'onsemi NSR1020MW2/D Rev. 4, Oct 2025',
    note: 'VF typical only at 10 mA (0.24 V); 0.1 A and 1 A points are the maximum limits. BV is the 20 V reverse rating, not a measured breakdown',
    units: [{ kind: 'schottky', vf: [[0.24, 0.01], [0.33, 0.1], [0.54, 1]], bv: [20, 1e-3], cj: 25e-12, pins: { K: '1', A: '2' } }] },
  { mpn: 'BAT30CWFILM', description: 'dual Schottky 30 V, common cathode', pkg: 'SOT-323', verified: false,
    note: 'datasheet not retrieved: unverified estimates',
    units: [
      { kind: 'schottky', vf: [[0.3, 0.01], [0.45, 0.1]], bv: [30, 1e-3], cj: 15e-12, pins: { A: '1', K: '3' } },
      { kind: 'schottky', vf: [[0.3, 0.01], [0.45, 0.1]], bv: [30, 1e-3], cj: 15e-12, pins: { A: '2', K: '3' } },
    ] },
  { mpn: 'SDZT15R6.8', description: 'Zener 6.8 V', pkg: 'SMD0603 (SOD-962)', verified: false,
    source: 'ROHM SDZ series data sheet (SDZ6.8, taping code T15R), Rev. 002, 2017-02-23',
    note: 'VZ checked: 6.47–7.14 V at 5 mA, typical curve ≈ 6.8 V. The datasheet gives no forward-voltage figure, so the forward points stay unverified estimates (was listed as SOD-523)',
    units: [{ kind: 'zener', vf: [[0.7, 0.01], [0.8, 0.1]], bv: [6.8, 5e-3], pins: { K: '1', A: '2' } }] },
  { mpn: 'ESD112-B1-02ELS', description: 'bidirectional ESD protection (ultra-low C)', pkg: 'TSSLP-2', verified: false,
    source: 'Infineon ESD112-B1-02 series data sheet Rev. 1.3, 2013-11-27',
    note: 'line capacitance 0.2 pF typical (matches); breakdown given as 7 V without a typical, so the 9 V estimate is only checked to lie above it',
    units: [{ kind: 'tvs-bi', vf: [], bv: [9, 1e-3], cj: 0.2e-12, pins: { K: '1', A: '2' } }] },
  { mpn: 'GREEN-56MCD-2MA-2.65V', description: 'green LED (debug)', pkg: '0402', verified: false,
    note: 'Vf/If taken from the part string (no manufacturer part number to look up): unverified',
    units: [{ kind: 'led', vf: [[2.65, 2e-3]], pins: { K: '1', A: '2' } }] },
];

const byKey = new Map<string, DeviceDef>();
for (const d of DEVICES) byKey.set(d.mpn.toUpperCase(), d);

/** Finds a device by part number, tolerating ordering suffixes (_SBMS001, -7, -G, T1G, TRPBF, -HF). */
export function findDevice(partNumber: string | undefined): DeviceDef | undefined {
  if (!partNumber) return undefined;
  let s = partNumber.toUpperCase().replace(/_SBMS\d+$/, '').replace(/-HF$/, '');
  for (let k = 0; k < 4; k++) {
    const d = byKey.get(s);
    if (d) return d;
    const next = s.replace(/(TRPBF|T1G|T\d?G|-\d|-G|G|PBF)$/, '');
    if (next === s) break;
    s = next;
  }
  return undefined;
}

export function allDevices(): readonly DeviceDef[] { return DEVICES; }

// ---------------- fitting ----------------

export interface MosFit { vto: number; kp: number; lambda: number }

/** Level-1 fit from on-resistance points: 1/Rds = β(|VGS| − VT) in the linear region. */
export function fitMos(s: MosSpec): MosFit {
  const pts = [...s.rds].sort((a, b) => b[0] - a[0]);
  let vt = s.vth, beta = 1 / (pts[0][1] * Math.max(0.3, pts[0][0] - s.vth));
  if (pts.length >= 2) {
    const [v1, r1] = pts[0], [v2, r2] = pts[1];
    const g1 = 1 / r1, g2 = 1 / r2;
    const b = (g1 - g2) / (v1 - v2);
    const t = v1 - g1 / b;
    // accept the on-curve fit when it is physically consistent with the datasheet threshold
    if (b > 0 && t > 0.3 * s.vth && t < 2.5 * s.vth) { beta = b; vt = t; }
  }
  return { vto: s.kind === 'pmos' ? -vt : vt, kp: beta, lambda: 0.01 };
}

export interface DiodeFit { is: number; n: number; rs: number }

/** Shockley fit (IS, N, RS) to forward points. */
export function fitDiode(pts: [number, number][], nDefault = 1.05): DiodeFit {
  const p = [...pts].sort((a, b) => a[1] - b[1]);
  if (!p.length) return { is: 1e-14, n: 1, rs: 0 };
  if (p.length === 1) {
    const n = nDefault;
    return { is: p[0][1] / Math.exp(p[0][0] / (n * VT_300K)), n, rs: 0 };
  }
  const [v1, i1] = p[0], [v2, i2] = p[1];
  // N and IS through the first two points after the RS drop, RS through the last point;
  // iterated so all three hold together (RS alone would lift the middle point)
  let n = 1, is = 1e-14, rs = 0;
  for (let k = 0; k < (p.length >= 3 ? 40 : 1); k++) {
    n = Math.min(3, Math.max(0.9, (v2 - rs * i2 - (v1 - rs * i1)) / (VT_300K * Math.log(i2 / i1))));
    is = i1 / Math.exp((v1 - rs * i1) / (n * VT_300K));
    if (p.length < 3) break;
    const [v3, i3] = p[p.length - 1];
    rs = Math.max(0, (v3 - n * VT_300K * Math.log(i3 / is)) / i3);
  }
  return { is, n, rs };
}

// ---------------- SPICE emission ----------------

const num = (v: number) => fmt(v);

function unitCards(u: UnitSpec, k: number, port: (pad: string) => string, models: string[]): string[] {
  const L: string[] = [];
  if (u.kind === 'nmos' || u.kind === 'pmos') {
    const f = fitMos(u);
    const m = `M${k}`;
    // with a datasheet body diode (DB below) the level-1 bulk junction is switched off (IS=0)
    models.push(`.model ${m}_${u.kind} ${u.kind.toUpperCase()}(VTO=${num(f.vto)} KP=${num(f.kp)} LAMBDA=${num(f.lambda)}${u.body ? ' IS=0' : ''})`);
    const d = port(u.pins.D), g = port(u.pins.G), s = port(u.pins.S);
    L.push(`${m} ${d} ${g} ${s} ${s} ${m}_${u.kind}`);
    if (u.body) {
      const bf = fitDiode([[u.body[0] - 0.12, u.body[1] / 100], [u.body[0], u.body[1]]]);
      models.push(`.model DB${k} D(IS=${num(bf.is)} N=${num(bf.n)})`);
      L.push(u.kind === 'nmos' ? `DB${k} ${s} ${d} DB${k}` : `DB${k} ${d} ${s} DB${k}`);
    }
    if (u.caps) {
      const [ciss, crss, coss] = u.caps;
      L.push(`CGS${k} ${g} ${s} ${num(Math.max(1e-15, ciss - crss))}`, `CGD${k} ${g} ${d} ${num(crss)}`, `CDS${k} ${d} ${s} ${num(Math.max(1e-15, coss - crss))}`);
    }
  } else if (u.kind === 'npn' || u.kind === 'pnp') {
    const is = u.vbe[1] / Math.exp(u.vbe[0] / VT_300K);
    models.push(`.model Q${k}_m ${u.kind.toUpperCase()}(IS=${num(is)} BF=${num(u.hfe)} BR=1 VAF=${num(u.vaf ?? 100)})`);
    L.push(`Q${k} ${port(u.pins.C)} ${port(u.pins.B)} ${port(u.pins.E)} Q${k}_m`);
  } else {
    const dU = u as DiodeSpec;
    const a = port(dU.pins.A), kk = port(dU.pins.K);
    if (dU.kind === 'tvs-bi') {
      // two junctions back to back: open until |V| exceeds the breakdown voltage
      const [bv, ibv] = dU.bv ?? [9, 1e-3];
      models.push(`.model DT${k} D(IS=1e-15 N=1 BV=${num(bv - 0.7)} IBV=${num(ibv)}${dU.cj ? ` CJO=${num(dU.cj * 2)}` : ''})`);
      L.push(`DT${k}a ${a} n${k} DT${k}`, `DT${k}b ${kk} n${k} DT${k}`);
    } else {
      const f = fitDiode(dU.vf, dU.kind === 'led' ? 2 : dU.kind === 'schottky' ? 1.05 : 1.0);
      const rs = dU.kind === 'led' ? Math.max(f.rs, 10) : f.rs;
      const bv = dU.bv ? ` BV=${num(dU.bv[0])} IBV=${num(dU.bv[1])}` : '';
      models.push(`.model D${k}_m D(IS=${num(f.is)} N=${num(f.n)} RS=${num(rs)}${bv}${dU.cj ? ` CJO=${num(dU.cj)}` : ''})`);
      L.push(`D${k} ${a} ${kk} D${k}_m`);
    }
  }
  return L;
}

/** PartSpec (subckt) for a device on a footprint, or undefined when a pin is missing. */
export function deviceSpec(dev: DeviceDef, padNames: string[]): PartSpec | undefined {
  const used: string[] = [];
  for (const u of dev.units) for (const p of Object.values(u.pins)) if (!used.includes(p)) used.push(p);
  if (used.some((p) => !padNames.includes(p))) return undefined;
  const port = (pad: string) => `p${used.indexOf(pad) + 1}`;
  const models: string[] = [];
  const cards = dev.units.flatMap((u, i) => unitCards(u, i + 1, port, models));
  const name = dev.mpn.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    type: 'subckt',
    ports: used,
    spice: [`.subckt ${name} ${used.map(port).join(' ')}`, ...models, ...cards, '.ends'].join('\n'),
    note: `${dev.mpn}: ${dev.description}${dev.verified ? ` (datasheet-verified: ${dev.source})` : ' (estimated values, unverified)'}`,
  };
}

// ---------------- board-level pin resolution ----------------

export interface PadNets { padNames: string[]; netOf: (pad: string) => string | undefined }

const isGround = (n: string | undefined) => !!n && /^(GND|VSS|AGND|DGND|PGND|GND_[A-Z0-9_]+)$/i.test(n);

export interface DiodeConvention {
  /** Which terminal pad "1" is on this board's two-pin diode footprints. */
  pad1: 'A' | 'K';
  votesAnode: number;
  votesCathode: number;
  /** Parts whose evidence contradicts the majority (worth checking by hand). */
  conflicts: string[];
}

/**
 * Infers the board's two-pin diode footprint convention from circuit context:
 * protection / zener / catch diodes tied to ground are reverse-biased in normal operation
 * (cathode on the positive side), LEDs tied to ground conduct (cathode on ground).
 */
export function inferDiodeConvention(parts: { ref: string; kind: DiodeSpec['kind'] | 'unknown'; pads: [string | undefined, string | undefined] }[]): DiodeConvention {
  let a = 0, k = 0;
  const evidence: { ref: string; pad1: 'A' | 'K' }[] = [];
  for (const p of parts) {
    const [n1, n2] = p.pads;
    if (isGround(n1) === isGround(n2) || p.kind === 'tvs-bi') continue;
    const gndOn1 = isGround(n1);
    // LED to ground: cathode on ground. Anything else to ground: anode on ground.
    const pad1: 'A' | 'K' = p.kind === 'led' ? (gndOn1 ? 'K' : 'A') : (gndOn1 ? 'A' : 'K');
    evidence.push({ ref: p.ref, pad1 });
    if (pad1 === 'A') a++; else k++;
  }
  const pad1 = a >= k ? 'A' : 'K';
  return { pad1, votesAnode: a, votesCathode: k, conflicts: evidence.filter((e) => e.pad1 !== pad1).map((e) => e.ref) };
}

/** Pin map for a unit on a concrete footprint, honouring the board diode convention. */
function boardPins(u: UnitSpec, conv: DiodeConvention | undefined, twoPin: boolean): UnitSpec {
  if (!twoPin || !('A' in u.pins) || !conv) return u;
  return { ...u, pins: conv.pad1 === 'A' ? { A: '1', K: '2' } : { K: '1', A: '2' } } as UnitSpec;
}

/**
 * Resolves a device onto a footprint: maps pins, then checks the map against the board nets
 * (a MOSFET gate must not share a net with its own drain/source, a BJT base not with its emitter).
 * Returns the PartSpec or the reason it was rejected.
 */
export function resolveDevice(dev: DeviceDef, fp: PadNets, conv?: DiodeConvention): { spec?: PartSpec; reason?: string } {
  const twoPin = fp.padNames.length === 2;
  const units = dev.units.map((u) => boardPins(u, conv, twoPin));
  for (const u of units) {
    if (u.kind === 'nmos' || u.kind === 'pmos') {
      const g = fp.netOf(u.pins.G), d = fp.netOf(u.pins.D), s = fp.netOf(u.pins.S);
      if (g && (g === d || g === s)) return { reason: `${dev.mpn}: gate pad ${u.pins.G} shares net ${g} with drain/source — pinout mismatch` };
      if (isGround(g)) return { reason: `${dev.mpn}: gate pad ${u.pins.G} on ground — pinout mismatch` };
    } else if (u.kind === 'npn' || u.kind === 'pnp') {
      const b = fp.netOf(u.pins.B), e = fp.netOf(u.pins.E), c = fp.netOf(u.pins.C);
      if (b && b === e) return { reason: `${dev.mpn}: base shares net with emitter — pinout mismatch` };
      if (b && b === c && dev.units.length === 1 && !/diode|sense/i.test(dev.description)) return { reason: `${dev.mpn}: base tied to collector — pinout mismatch` };
    }
  }
  const spec = deviceSpec({ ...dev, units }, fp.padNames);
  return spec ? { spec } : { reason: `${dev.mpn}: footprint lacks pads ${[...new Set(units.flatMap((u) => Object.values(u.pins)))].filter((p) => !fp.padNames.includes(p)).join(',')}` };
}
