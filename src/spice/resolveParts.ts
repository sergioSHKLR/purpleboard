// Source-independent device resolution: any board + a refdes → part-number map (from a
// schematic, a BOM CSV, a netlist…) → SPICE PartSpecs for every known discrete device.
import type { Component } from '../types';
import type { PartSpec } from './board';
import { findDevice, inferDiodeConvention, resolveDevice, type DiodeConvention, type DiodeSpec } from './devicelib';

export interface DeviceResolution {
  parts: Record<string, PartSpec>;
  convention: DiodeConvention;
  report: { ref: string; partNumber: string; status: 'modelled' | 'unknown-part' | 'rejected'; detail: string }[];
}

export function resolveDevices(comps: Component[], partNumbers: Record<string, string>, skip: (ref: string) => boolean = () => false): DeviceResolution {
  const netOf = (c: Component) => (pad: string) => c.pads.find((p) => p.name === pad)?.net;
  const padNames = (c: Component) => [...new Set(c.pads.map((p) => p.name))];

  // Board footprint convention for two-pin diodes, from every two-pad part that looks like a diode.
  const diodeLike = comps
    .filter((c) => padNames(c).length === 2 && !skip(c.ref) && (c.kind === 'diode' || c.kind === 'led' || /^(D|LED|ZD|TVS)\d/i.test(c.ref)))
    .map((c) => {
      const dev = findDevice(partNumbers[c.ref]);
      const kind = (dev?.units[0] as DiodeSpec | undefined)?.kind ?? (c.kind === 'led' ? 'led' : 'unknown');
      return { ref: c.ref, kind, pads: [netOf(c)('1'), netOf(c)('2')] as [string | undefined, string | undefined] };
    });
  const convention = inferDiodeConvention(diodeLike as Parameters<typeof inferDiodeConvention>[0]);

  const parts: Record<string, PartSpec> = {};
  const report: DeviceResolution['report'] = [];
  for (const c of comps) {
    const pn = partNumbers[c.ref];
    if (!pn || skip(c.ref)) continue;
    const dev = findDevice(pn);
    if (!dev) { report.push({ ref: c.ref, partNumber: pn, status: 'unknown-part', detail: 'not in device library' }); continue; }
    const r = resolveDevice(dev, { padNames: padNames(c), netOf: netOf(c) }, convention);
    if (r.spec) { parts[c.ref] = r.spec; report.push({ ref: c.ref, partNumber: pn, status: 'modelled', detail: dev.description }); }
    else report.push({ ref: c.ref, partNumber: pn, status: 'rejected', detail: r.reason ?? '' });
  }
  return { parts, convention, report };
}
