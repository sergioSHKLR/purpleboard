// What a mod importer returned, turned into a scenario by the app's own importers (KiCad text, or a
// .pcbfix.json object): an importer never builds the app's structures directly, and everything it
// produces goes through the same checks as a file the player dropped.
import type { Scenario } from '../../types';
import { importScenarioOrPcb } from '../../io/kicad';

const MAX = 64 * 1024 * 1024;

export function scenarioFromImport(out: unknown, fileName: string, modName: string): Scenario {
  const base = fileName.replace(/\.[^.]+$/, '') || 'board';
  const o = out as { kicadPcb?: unknown; pcbfix?: unknown } | null;
  let sc: Scenario;
  if (o && typeof o === 'object' && typeof o.kicadPcb === 'string') {
    if (o.kicadPcb.length > MAX) throw new Error('the importer returned more than 64 MB');
    if (!o.kicadPcb.trim().startsWith('(kicad_pcb')) throw new Error('the importer\'s kicadPcb text is not a KiCad board');
    sc = importScenarioOrPcb(`${base}.kicad_pcb`, o.kicadPcb);
  } else if (o && typeof o === 'object' && o.pcbfix && typeof o.pcbfix === 'object') {
    const text = JSON.stringify(o.pcbfix);
    if (text.length > MAX) throw new Error('the importer returned more than 64 MB');
    sc = importScenarioOrPcb(`${base}.pcbfix.json`, text);
  } else {
    throw new Error('the importer returned neither { kicadPcb: "…" } nor { pcbfix: { … } }');
  }
  sc.meta.credits = [sc.meta.credits, `Imported by the mod "${modName}".`].filter(Boolean).join(' ');
  return sc;
}
