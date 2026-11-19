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
  source: string;
  note?: string;
}

const REGULATORS: RegulatorDef[] = [
  { mpn: 'LMR16006YQ3', fixedOut: 3.3, ilim: 1.2, iq: 28e-6, source: 'TI SNVSAC1 (LMR16006Y-Q1), Jun 2015',
    note: 'fixed 3.3 V version (3.201–3.399 V); ilim = minimum peak current limit (1.2–1.7 A); EN floating = enabled (internal pull-up, LMR16006 datasheet)' },
  { mpn: 'LMR16006', vref: 0.765, source: 'TI SNVSAC1, Jun 2015', note: 'adjustable version: FB 0.747–0.782 V' },
  { mpn: 'TLV62568', vref: 0.6, ilim: 1.5, iq: 35e-6, source: 'TI SLVSD89B, rev. Nov 2017', note: 'VFB 0.588–0.612 V; ilim = high-side FET current limit (typ.)' },
  { mpn: 'LM62460', vref: 1.0, source: 'TI SNVSBZ4A, rev. Nov 2021', note: 'adjustable (1 V FB) versions: 0.99–1.01 V' },
  { mpn: 'LM62440', ilim: 7, iq: 9e-6, source: 'TI SNVSAW8E, rev. Apr 2022', note: 'ilim = high-side switch current limit, typ. (6–8.1 A); FB tied to VOUT = fixed 3.3 V / 5 V trim option' },
  { mpn: 'SIC477', vref: 0.8, iq: 156e-6, source: 'Vishay doc. 77113 Rev. I, 17-Nov-2025', note: 'VFB 0.796–0.804 V at 25 °C; current limit set by a board resistor (not modelled per part)' },
];

const sorted = [...REGULATORS].sort((a, b) => b.mpn.length - a.mpn.length);

/** The regulator a board value names ("TLV62568DBV", "SIC477ED-T1-GE3"…), if listed. */
export function findRegulator(value: string | undefined): RegulatorDef | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase().replace(/\s+/g, '');
  return sorted.find((r) => v.startsWith(r.mpn));
}

export function allRegulators(): readonly RegulatorDef[] { return REGULATORS; }
