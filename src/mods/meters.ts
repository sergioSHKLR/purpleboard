// Multimeter profiles as mod items. The official meter (src/spice/dmm.ts GENERIC_DMM) is
// official-instruments/meters/generic and can be patched; a mod adds meters (a cheap meter that
// reads 1 % low, a bench meter with 1 GΩ input…) and the player picks one in the bench menu.
// Every number is checked, so a profile can't break a measurement.
import { GENERIC_DMM, type DmmProfile } from '../spice/dmm';
import { itemAddress } from './address';
import type { LoadedMod } from './mods';
import { applyPatches, type PatchEntry, type PatchResult } from './patches';

export const OFFICIAL_INSTRUMENTS_MOD = 'official-instruments';
export const OFFICIAL_METER = itemAddress(OFFICIAL_INSTRUMENTS_MOD, 'meters', 'generic');
export const METER_FIELDS = ['name', 'counts', 'vInputOhms', 'vGainError', 'noiseCounts', 'ohmRanges', 'leadOhms', 'contactOhms', 'beepOhms', 'diode'] as const;

export interface MeterDef extends DmmProfile { id: string }
type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);
const n = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Problems with a meter profile (empty = valid). */
export function meterProblems(m: Raw): string[] {
  const p: string[] = [];
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) p.push('"name" must be text (1–60 characters)');
  if (!(Number.isInteger(m.counts) && n(m.counts, 400, 1e6))) p.push('"counts" must be a whole number, 400–1000000 (e.g. 6000)');
  if (!n(m.vInputOhms, 1e5, 1e12)) p.push('"vInputOhms" must be the voltage input impedance, 1e5–1e12 Ω');
  if (!n(m.vGainError, 0, 0.1)) p.push('"vGainError" must be a fraction of the reading, 0–0.1');
  if (!n(m.noiseCounts, 0, 100)) p.push('"noiseCounts" must be 0–100');
  if (!Array.isArray(m.ohmRanges) || !m.ohmRanges.length || m.ohmRanges.length > 10) p.push('"ohmRanges" must list 1–10 ranges');
  else {
    let last = 0;
    m.ohmRanges.forEach((r, i) => {
      if (!isObj(r) || !n(r.fullScale, 1, 1e10) || (r.fullScale as number) <= last || !n(r.itest, 1e-12, 0.1) || !n(r.voc, 0.1, 10)) p.push(`"ohmRanges[${i}]" must be { fullScale (increasing), itest (A), voc (V) }`);
      else last = r.fullScale as number;
    });
  }
  if (!n(m.leadOhms, 0, 10)) p.push('"leadOhms" must be 0–10 Ω');
  if (!(Array.isArray(m.contactOhms) && m.contactOhms.length === 2 && n(m.contactOhms[0], 0, 100) && n(m.contactOhms[1], m.contactOhms[0] as number, 100))) p.push('"contactOhms" must be [min, max] in Ω, 0–100');
  if (!n(m.beepOhms, 0, 1000)) p.push('"beepOhms" must be 0–1000 Ω');
  const d = m.diode;
  if (!isObj(d) || !n(d.itest, 1e-5, 0.1) || !n(d.voc, 0.5, 10) || !n(d.olVolts, 0.3, typeof d.voc === 'number' ? d.voc : 10)) p.push('"diode" must be { itest (A), voc (V), olVolts (≤ voc) }');
  return p;
}

/** Reads one entry of a mod's `meters` list. Fields left out come from the official meter. */
export function parseMeter(raw: unknown, at: string, errs: string[], warnings: string[]): MeterDef | null {
  if (!isObj(raw)) { errs.push(`${at} must be an object`); return null; }
  for (const k of Object.keys(raw)) if (k !== 'id' && !(METER_FIELDS as readonly string[]).includes(k)) warnings.push(`${at}: unknown field "${k}" (ignored)`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) { errs.push(`${at}.id must be 2-64 lowercase letters, digits, ".", "-" or "_"`); return null; }
  const m: Raw = structuredClone({ ...GENERIC_DMM, ...Object.fromEntries(Object.entries(raw).filter(([k]) => k === 'id' || (METER_FIELDS as readonly string[]).includes(k))) });
  const problems = meterProblems(m);
  if (problems.length) { errs.push(...problems.map((x) => `${at}: ${x}`)); return null; }
  return m as unknown as MeterDef;
}

export interface MeterInfo { address: string; modId: string; profile: DmmProfile }
export interface MeterRegistry { meters: MeterInfo[]; log: Map<string, { title: string; res: PatchResult }>; addresses: Set<string> }

/** The official meter (patched by running mods) and the meters they add. */
export function buildMeterRegistry(active: LoadedMod[]): MeterRegistry {
  const items = new Map<string, { modId: string; profile: DmmProfile }>([[OFFICIAL_METER, { modId: OFFICIAL_INSTRUMENTS_MOD, profile: structuredClone(GENERIC_DMM) }]]);
  for (const m of active) for (const d of m.manifest.meters) {
    const { id: _id, ...profile } = d; void _id;
    items.set(itemAddress(m.manifest.id, 'meters', d.id), { modId: m.manifest.id, profile });
  }
  const entries = new Map<string, PatchEntry[]>();
  for (const m of active) for (const patch of m.manifest.patches) {
    if (patch.target.includes('/meters/')) entries.set(patch.target, [...(entries.get(patch.target) ?? []), { modId: m.manifest.id, modName: m.manifest.name, patch }]);
  }
  const log = new Map<string, { title: string; res: PatchResult }>();
  for (const [addr, es] of entries) {
    const it = items.get(addr);
    if (!it) continue;
    const { value, result } = applyPatches(it.profile, es, METER_FIELDS, (v) => meterProblems(v));
    log.set(addr, { title: it.profile.name, res: result });
    it.profile = value;
  }
  return { meters: [...items].map(([address, x]) => ({ address, ...x })), log, addresses: new Set(items.keys()) };
}
