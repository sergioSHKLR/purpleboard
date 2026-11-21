// Regulator datasheet values (verified against the named documents; numbers are transcribed
// facts, no datasheet text copied). The power tree's behavioral models are universal templates:
// a part listed here sharpens them with its real reference / fixed output / current limit.
// Parts not listed keep the per-class estimates (CURRENT_LIMIT, rail-name targets).

export interface RegulatorDef {
  /** Part-number prefix as printed in board values (longest match wins). */
  mpn: string;
  /** Feedback reference (V) of an adjustable part: Vout = Vref / divider ratio. */
  vref?: number;
  /** Fixed output voltage (V) of a fixed-output part. */
  fixedOut?: number;
  /** Output current limit used by the model (A): the datasheet's switch current limit (which one is in `note`). */
  ilim?: number;
  /** Operating quiescent current, not switching (A). Data only; far below the estimated rail loads. */
  iq?: number;
  /** Pad names by role (datasheet pinout), for nets the design leaves unnamed: FB on "Net-(C6-Pad2)". */
  pins?: { fb?: string };
  /** A linear single-cell Li-ion charger (CC/CV) rather than a regulator. */
  charger?: ChargerDef;
  source: string;
  note?: string;
}

/** Linear Li-ion charger, as its datasheet states it. Typical values unless noted. */
export interface ChargerDef {
  /** Pad names by role (datasheet pinout). */
  pins: { in: string; bat: string; prog: string; stat?: string };
  /** Constant-voltage (float) regulation (V). */
  vfloat: number;
  /** Constant charge current = kprog / R_PROG (A·Ω), e.g. 1000 V for "I = 1000 · V_PROG / R_PROG" at V_PROG = 1 V. */
  kprog: number;
  /** Input under-voltage lockout, rising (V). */
  uvlo: number;
  /** Charging needs the input this far above BAT (V). */
  headroom: number;
  /** Below this BAT voltage it trickle-charges (V)… */
  trickleV: number;
  /** …at this fraction of the set current. */
  trickleFrac: number;
}

const REGULATORS: RegulatorDef[] = [
  { mpn: 'LMR16006YQ3', fixedOut: 3.3, ilim: 1.2, iq: 28e-6, source: 'TI SNVSAC1 (LMR16006Y-Q1), Jun 2015',
    note: 'fixed 3.3 V version (3.201–3.399 V); ilim = minimum peak current limit (1.2–1.7 A); EN floating = enabled (internal pull-up, LMR16006 datasheet)' },
  { mpn: 'LMR16006', vref: 0.765, source: 'TI SNVSAC1, Jun 2015', note: 'adjustable version: FB 0.747–0.782 V' },
  { mpn: 'TLV62568', vref: 0.6, ilim: 1.5, iq: 35e-6, source: 'TI SLVSD89B, rev. Nov 2017', note: 'VFB 0.588–0.612 V; ilim = high-side FET current limit (typ.)' },
  { mpn: 'LM62460', vref: 1.0, source: 'TI SNVSBZ4A, rev. Nov 2021', note: 'adjustable (1 V FB) versions: 0.99–1.01 V' },
  { mpn: 'LM62440', ilim: 7, iq: 9e-6, source: 'TI SNVSAW8E, rev. Apr 2022', note: 'ilim = high-side switch current limit, typ. (6–8.1 A); FB tied to VOUT = fixed 3.3 V / 5 V trim option' },
  { mpn: 'SIC477', vref: 0.8, iq: 156e-6, source: 'Vishay doc. 77113 Rev. I, 17-Nov-2025', note: 'VFB 0.796–0.804 V at 25 °C; current limit set by a board resistor (not modelled per part)' },
  { mpn: 'SY8089', pins: { fb: '5' }, vref: 0.6, ilim: 3.5, iq: 55e-6, source: 'Silergy AN_SY8089/A Rev. 0.9A',
    note: 'VREF 0.588–0.612 V; ilim = PFET current limit (minimum); EN must not float (datasheet); SY8089A: hiccup protection' },
  { mpn: 'HX6211A332', fixedOut: 3.3, ilim: 0.5, iq: 55e-6, source: 'HX6211 datasheet (LCSC C296224, Chinese, 2014)',
    note: 'fixed 3.3 V ±2 %; ilim = maximum output current at VIN = VOUT + 1 V (typ.; short-circuit foldback 150 mA); dropout 120 mV at 100 mA, 260 mV at 200 mA; CE high ≥ 1.0 V' },
  { mpn: 'SY8088', pins: { fb: '5' }, vref: 0.6, ilim: 1.3, iq: 40e-6, source: 'Silergy AN_SY8088 Rev. 0.1',
    note: 'VREF 0.588–0.612 V; ilim = PFET current limit (minimum); VIN 2.5–5.5 V, UVLO ≤ 2.5 V; EN must not float' },
  ...['MCP73831-2AC', 'MCP73831T-2AC'].map((mpn) => ({ mpn, source: 'Microchip MCP73831/2 datasheet DS20001984G (rev. G)',
    charger: { pins: { stat: '1', bat: '3', in: '4', prog: '5' }, vfloat: 4.2, kprog: 1000, uvlo: 3.45, headroom: 0.05, trickleV: 2.793, trickleFrac: 0.1 },
    note: '-2 = VREG 4.168–4.232 V; I_REG = 1000 V / R_PROG (90–110 mA at 10 k); option AC: precondition 10 % below 66.5 % of VREG (2.793 V), termination 7.5 %; VSTART 3.3–3.6 V (3.45 typ.); headroom 50 mV is an estimate (the sheet gives sleep below VBAT − 50 mV); PROG floating = no charge' })),
  { mpn: 'TP4054', source: 'ShenZhen TPOWER TP4054 datasheet, rev. V2.2 (Chinese)',
    charger: { pins: { stat: '1', bat: '3', in: '4', prog: '5' }, vfloat: 4.2, kprog: 1000, uvlo: 3.7, headroom: 0.1, trickleV: 2.9, trickleFrac: 0.12 },
    note: 'VFLOAT 4.158–4.242 V; R_PROG = 1000 V / I_BAT (VPROG 1.0 V); UVLO 3.5–3.9 V rising; charges once VCC > BAT + 100 mV; trickle 60 mA of 500 mA (R_PROG 2 k) below 2.9 V; C/10 termination; CHRG open drain, low while charging' },
  { mpn: 'BL4054B', source: 'Belling BL4054/BL4054B Rev 1.4, 5/2009',
    charger: { pins: { stat: '1', bat: '3', in: '4', prog: '5' }, vfloat: 4.2, kprog: 1000, uvlo: 3.9, headroom: 0.03, trickleV: 2.9, trickleFrac: 0.1 },
    note: '-42 option: VFLOAT 4.158–4.242 V; I_BAT = 1000 · V_PROG / R_PROG (V_PROG 0.93–1.07 V; 93–107 mA at 10 k); UVLO 3.7–4.1 V rising; VCC − BAT 30 mV rising; trickle 10 mA at 10 k below 2.9 V; PROG open = shutdown; CHRGb open drain' },
];

const sorted = [...REGULATORS].sort((a, b) => b.mpn.length - a.mpn.length);

/** The regulator a board value names ("TLV62568DBV", "SIC477ED-T1-GE3"…), if listed. */
export function findRegulator(value: string | undefined): RegulatorDef | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase().replace(/\s+/g, '');
  return sorted.find((r) => v.startsWith(r.mpn));
}

export function allRegulators(): readonly RegulatorDef[] { return REGULATORS; }
