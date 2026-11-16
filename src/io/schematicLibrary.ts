// Extracted schematic + boardview → SPICE part library (src/spice/board.ts PartLibrary).
import type { Component } from '../types';
import type { PartLibrary, PartSpec } from '../spice/board';
import { isStuffed, resolveOptions, type Schematic, type SchematicPart } from './schematic';
import { resolveDevices, type DeviceResolution } from '../spice/resolveParts';

export type LibSource = 'schematic' | 'schematic+rule' | 'not-fitted' | 'unresolved';

export interface LibraryEntryReport {
  ref: string;
  source: LibSource;
  spec?: PartSpec['type'];
  detail: string;
}

export interface SchematicLibrary {
  library: PartLibrary;
  report: LibraryEntryReport[];
  /** Part numbers of semiconductors/ICs, for device-model lookup. */
  partNumbers: Record<string, string>;
  /** Ratings kept for realism features (power/voltage/current derating, fuse I²t…). */
  ratings: Record<string, { tolerance?: string; power?: string; voltage?: string; dielectric?: string; pkg?: string; irated?: number; esr?: number; dcr?: number }>;
  product: string | null;
  options: string[];
  devices: DeviceResolution;
}

/** Typical ferrite-bead DC resistance from its impedance and current rating (vendor-catalogue trend). */
function beadDcr(z: number | undefined, amps: number | undefined): number {
  const i = amps ?? 0.5;
  const r = 0.03 * Math.pow(Math.max(z ?? 120, 10) / 120, 0.6) / Math.pow(Math.max(i, 0.05) / 1.5, 1.2);
  return +Math.min(2, Math.max(0.005, r)).toPrecision(2);
}

const near = (c: Component, a: string, b: string) => {
  const pa = c.pads.find((p) => p.name === a)!, pb = c.pads.find((p) => p.name === b)!;
  return Math.hypot(pa.at[0] - pb.at[0], pa.at[1] - pb.at[1]);
};

/** Fuse rating from "3AMP-32V-467" style part strings. */
function fuseRating(s: string | undefined): number | undefined {
  const m = s && /^(\d+(?:\.\d+)?)A(?:MP)?\b/.exec(s);
  return m ? parseFloat(m[1]) : undefined;
}

/**
 * Builds a part library for the boardview parts from the extracted schematic.
 * `product` selects the BOM configuration (e.g. "639-00623"); null = ignore option labels
 * except NO STUFF / OMIT.
 */
export function schematicToLibrary(sch: Schematic, comps: Component[], product: string | null): SchematicLibrary {
  const options = product ? resolveOptions(sch.bom, product) : null;
  const parts: Record<string, PartSpec> = {};
  const report: LibraryEntryReport[] = [];
  const partNumbers: Record<string, string> = {};
  const ratings: SchematicLibrary['ratings'] = {};

  for (const c of comps) {
    const p: SchematicPart | undefined = sch.parts.get(c.ref);
    if (!p || !p.pages.length) { report.push({ ref: c.ref, source: 'unresolved', detail: 'refdes not found in schematic' }); continue; }
    const src = `sheet ${p.pages.join(',')}`;
    if (p.partNumber) partNumbers[c.ref] = p.partNumber;
    if (p.tolerance || p.power || p.voltage || p.dielectric || p.pkg || p.irated || p.esr || p.dcr) {
      ratings[c.ref] = { tolerance: p.tolerance, power: p.power, voltage: p.voltage, dielectric: p.dielectric, pkg: p.pkg, irated: p.irated, esr: p.esr, dcr: p.dcr };
    }
    const pads = [...new Set(c.pads.map((x) => x.name))];
    const prefix = c.ref.replace(/\d.*$/, '');
    const stuffed = isStuffed(p, options);

    // Two-terminal mapping; 4-pad Kelvin resistors get their sense pads tied to the nearest force pad.
    const kelvin = (prefix === 'R') && pads.length === 4;
    const twoTerminal = (type: 'R' | 'short', value?: number): PartSpec => {
      if (!kelvin) return { type, ...(value !== undefined && { value }) };
      const tie3 = near(c, '3', '1') <= near(c, '3', '2') ? 'p1' : 'p2';
      const tie4 = tie3 === 'p1' ? 'p2' : 'p1';
      const r = type === 'short' ? 1e-3 : value!;
      return {
        type: 'subckt', ports: ['1', '2', '3', '4'],
        spice: `.subckt KELVIN p1 p2 p3 p4\nRF p1 p2 ${r}\nRS3 p3 ${tie3} 1m\nRS4 p4 ${tie4} 1m\n.ends`,
        note: `4-terminal sense resistor, sense pads tied to nearest force pad (3→${tie3.slice(1)}, 4→${tie4.slice(1)})`,
      };
    };

    if (!stuffed) {
      if (p.shortFootprint && (prefix === 'R' || prefix === 'XW')) {
        parts[c.ref] = { ...twoTerminal('short'), note: `not fitted (${p.bomOption}); SHORT footprint conducts through copper — ${src}` };
        report.push({ ref: c.ref, source: 'schematic+rule', spec: 'short', detail: `${p.bomOption} on SHORT footprint → copper short` });
      } else {
        parts[c.ref] = { type: 'open', note: `not fitted (${p.bomOption}) — ${src}` };
        report.push({ ref: c.ref, source: 'not-fitted', spec: 'open', detail: p.bomOption ?? '' });
      }
      continue;
    }

    if (prefix === 'XW' || prefix === 'SL') {
      if (pads.length >= 2) {
        parts[c.ref] = { type: 'short', note: `net tie — ${src}` };
        report.push({ ref: c.ref, source: 'schematic', spec: 'short', detail: 'net tie' });
      }
      continue;
    }
    if (prefix === 'F') {
      const rating = fuseRating(p.partNumber);
      parts[c.ref] = { type: 'fuse', value: rating ?? 3, note: `${p.partNumber ?? 'fuse'} — ${src}` };
      report.push({ ref: c.ref, source: rating ? 'schematic' : 'schematic+rule', spec: 'fuse', detail: p.partNumber ?? '' });
      continue;
    }
    if (p.value !== undefined && p.valueKind && (prefix === 'R' || prefix === 'C' || prefix === 'L')) {
      if (pads.length > 2 && !kelvin) {
        report.push({ ref: c.ref, source: 'unresolved', detail: `${pads.length}-pad ${prefix} (${p.valueText}) needs a pin model` });
        continue;
      }
      const tag = `${p.valueText}${p.tolerance ? ' ' + p.tolerance : ''}${p.voltage ? ' ' + p.voltage : ''}${p.dielectric ? ' ' + p.dielectric : ''}${p.pkg ? ' ' + p.pkg : ''} — ${src}`;
      if (p.valueKind === 'R') {
        const spec = p.value === 0 ? twoTerminal('short') : twoTerminal('R', p.value);
        parts[c.ref] = { ...spec, note: spec.note ? `${spec.note}; ${tag}` : tag };
        report.push({ ref: c.ref, source: 'schematic', spec: spec.type, detail: p.valueText ?? '' });
      } else if (p.valueKind === 'C') {
        parts[c.ref] = { type: 'C', value: p.value, ...(p.esr !== undefined && { esr: p.esr }), note: tag };
        report.push({ ref: c.ref, source: 'schematic', spec: 'C', detail: p.valueText ?? '' });
      } else if (p.valueKind === 'L') {
        parts[c.ref] = {
          type: 'L', value: p.value, ...(p.dcr !== undefined && { dcr: p.dcr }),
          note: `${tag}${p.irated ? `; rated ${p.irated} A` : ''}${p.dcr === undefined ? '; DCR not in schematic' : ''}`,
        };
        report.push({ ref: c.ref, source: 'schematic', spec: 'L', detail: p.valueText ?? '' });
      } else {
        // Ferrite bead: at DC (and for this simulator's purposes) a small resistance.
        const dcr = p.dcr ?? beadDcr(p.value, p.irated);
        parts[c.ref] = { type: 'R', value: dcr, note: `ferrite bead ${p.value} Ω@100MHz${p.irated ? `, ${p.irated} A` : ''}; DC ${p.dcr === undefined ? 'resistance estimated' : 'resistance'} ${dcr} Ω — ${src}` };
        report.push({ ref: c.ref, source: p.dcr === undefined ? 'schematic+rule' : 'schematic', spec: 'R', detail: `bead ${p.valueText}` });
      }
      continue;
    }
    report.push({
      ref: c.ref, source: 'unresolved',
      detail: p.partNumber ? `part ${p.partNumber}: needs device model` : 'no value printed',
    });
  }
  // Discrete semiconductors by part number (source-independent resolver).
  const devices = resolveDevices(comps, partNumbers, (ref) => ref in parts);
  for (const [ref, spec] of Object.entries(devices.parts)) {
    parts[ref] = spec;
    const i = report.findIndex((r) => r.ref === ref);
    const entry: LibraryEntryReport = { ref, source: 'schematic', spec: 'subckt', detail: `device model ${partNumbers[ref]}` };
    if (i >= 0) report[i] = entry; else report.push(entry);
  }
  for (const d of devices.report) {
    if (d.status === 'rejected') {
      const i = report.findIndex((r) => r.ref === d.ref);
      if (i >= 0) report[i] = { ...report[i], detail: d.detail };
    }
  }
  return { library: { parts }, report, partNumbers, ratings, product, options: options ? [...options].sort() : [], devices };
}
