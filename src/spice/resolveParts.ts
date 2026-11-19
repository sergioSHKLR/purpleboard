// Source-independent device resolution: any board + a refdes → part-number map (from a
// schematic, a BOM CSV, a netlist…) → SPICE PartSpecs for every known discrete device.
import type { Component } from '../types';
import type { PartSpec } from './board';
import { diodeModelParams, findDevice, inferDiodeConvention, resolveDevice, type DiodeConvention, type DiodeSpec } from './devicelib';

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
    const r = resolveDevice(dev, { padNames: padNames(c), netOf: netOf(c) }, convention, c.pins);
    if (r.spec) { parts[c.ref] = r.spec; report.push({ ref: c.ref, partNumber: pn, status: 'modelled', detail: dev.description }); }
    else report.push({ ref: c.ref, partNumber: pn, status: 'rejected', detail: r.reason ?? '' });
  }
  return { parts, convention, report };
}

/**
 * Device-library models for any board, from the part numbers printed on its parts (the component
 * label: KiCad value field, BOM part number, boardview text). Parts with a library entry get the
 * datasheet model; a single two-terminal diode becomes a plain D element (with its anode / cathode
 * roles, so reversal, current read-back and overload work as for any diode); everything else is a
 * subcircuit (MOSFETs with body diode and capacitances, arrays, dual parts).
 */
export function boardDevices(comps: Component[], skip: (ref: string) => boolean = () => false): DeviceResolution {
  const labels: Record<string, string> = {};
  for (const c of comps) if (c.label && !skip(c.ref) && findDevice(c.label)) labels[c.ref] = c.label;
  const res = resolveDevices(comps, labels, skip);
  for (const c of comps) {
    const spec = res.parts[c.ref];
    const dev = spec && findDevice(labels[c.ref]);
    if (!spec || !dev) continue;
    spec.device = dev.mpn;
    const u = dev.units[0] as DiodeSpec;
    const pads = [...new Set(c.pads.map((p) => p.name))];
    if (dev.units.length !== 1 || pads.length !== 2 || !['diode', 'schottky', 'zener', 'led'].includes(u.kind)) continue;
    // pad roles: the board's own (emitted through them, so a reversed part stays reversed), else
    // the footprint convention the resolver inferred
    const known = c.pins.A !== undefined && c.pins.K !== undefined && c.pins.A !== c.pins.K;
    const anode = res.convention.pad1 === 'A' ? '1' : '2';
    res.parts[c.ref] = {
      type: u.kind === 'led' ? 'LED' : 'D', model: diodeModelParams(u), device: dev.mpn, note: spec.note,
      ...(!known && { pins: { A: anode, K: anode === '1' ? '2' : '1' } }),
    };
  }
  return res;
}
