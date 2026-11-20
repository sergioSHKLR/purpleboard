// Generated parts of the mod documentation, so they never drift from the code:
//  - docs/MOD_REFERENCE.md: every official mod and its items (boards, solvers, devices, fault
//    classes, rules, the meter), with their addresses;
//  - docs/CODE_MODS.md: the plug-in API's type definitions.
// scripts/build-docs.ts writes them between <!-- generated:NAME --> markers (npm run docs);
// test/docs.test.ts fails when a doc is out of date.
import type { Scenario } from '../types';
import { OFFICIAL_MODS, officialBoardAddress } from './official';
import { SOLVERS } from './solvers';
import { allDevices } from '../spice/devicelib';
import { deviceItemId } from './devices';
import { FAULT_LABELS, severityHint } from '../faults';
import { FAULT_CLASSES } from './puzzles';
import { officialFaultAddress } from './faulttypes';
import { OFFICIAL_RULES, OFFICIAL_RULES_MOD, ruleAddress } from './rules';
import { GENERIC_DMM } from '../spice/dmm';
import { OFFICIAL_METER } from './meters';
import { apiPackageFiles } from './api/package';
import { API_VERSION } from './api/version';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

export function officialItemsMarkdown(scenarios: Scenario[], demos: { id: string; title: string }[]): string {
  const out: string[] = [];
  out.push('### Official mods', '', table(['Mod', 'Version', 'What it holds'], OFFICIAL_MODS.map((m) => [`\`${m.id}\``, m.version, m.description])));
  out.push('', '### Boards (`official-boards`)', '', table(['Address', 'Board'], [
    ...scenarios.map((s) => [`\`${officialBoardAddress(s.id)}\``, s.meta.title]),
    ...demos.map((d) => [`\`${officialBoardAddress(d.id)}\``, `${d.title} (demo, loads when opened)`]),
  ]));
  out.push('', '### Solvers (`official-solvers`)', '', table(['Address', 'Short name', 'Solver'], SOLVERS.map((s) => [`\`${s.address}\``, `\`${s.id}\``, `${s.name}: ${s.description}`])));
  out.push('', '### Device library (`official-solvers`)', '', 'Patch an entry by its address. Numbers are the datasheet quantities; see [Devices](#devices).', '', table(['Address', 'Part number', 'Units', 'Verified'], allDevices().map((d) => [
    `\`official-solvers/devices/${deviceItemId(d.mpn)}\``, d.mpn, d.units.map((u) => u.kind).join(', '), d.verified ? 'yes' : 'no',
  ])));
  out.push('', '### Fault classes (`official-faults`)', '', 'Only `range` can be patched; see [Fault types](#fault-types).', '', table(['Address', 'Fault', 'Severity range'], FAULT_CLASSES.map((c) => {
    const h = severityHint(c);
    const unit = h?.unit.startsWith('flex') ? '(flex level, 0 = still, 1 = hard)' : h?.unit;
    return [`\`${officialFaultAddress(c)}\``, FAULT_LABELS[c], h ? `${h.min}–${h.max} ${unit}` : '—'];
  })));
  out.push('', '### Rules (`official-rules`)', '', table(['Address', 'When', 'Suspects', 'Weight'], OFFICIAL_RULES.map((r) => [
    `\`${ruleAddress(OFFICIAL_RULES_MOD, r.id)}\``, `\`${r.when}\``, `\`${r.suspect.where}\`${r.suspect.kinds ? ` (${r.suspect.kinds.join(', ')})` : ''}`, String(r.weight ?? 5),
  ])));
  const m = GENERIC_DMM;
  out.push('', `### Meter (\`${OFFICIAL_METER}\`)`, '', table(['Field', 'Value'], [
    ['`name`', m.name], ['`counts`', String(m.counts)], ['`vInputOhms`', String(m.vInputOhms)], ['`vGainError`', String(m.vGainError)],
    ['`noiseCounts`', String(m.noiseCounts)], ['`ohmRanges`', m.ohmRanges.map((r) => `${r.fullScale} Ω (${r.itest} A, ${r.voc} V)`).join('; ')],
    ['`leadOhms`', String(m.leadOhms)], ['`contactOhms`', `[${m.contactOhms.join(', ')}]`], ['`beepOhms`', String(m.beepOhms)],
    ['`diode`', `itest ${m.diode.itest} A, voc ${m.diode.voc} V, olVolts ${m.diode.olVolts} V`],
  ]));
  return out.join('\n');
}

export function apiTypesMarkdown(typesSource: string): string {
  return [`Plug-in API ${API_VERSION}, as \`@deadboard/mod-api\` ships it (\`index.d.ts\`):`, '', '```ts', apiPackageFiles(typesSource)['index.d.ts'].trim(), '```'].join('\n');
}

/** Replaces the block between <!-- generated:NAME --> and <!-- /generated:NAME --> markers. */
export function fillGenerated(doc: string, name: string, body: string): string {
  const open = `<!-- generated:${name} -->`, close = `<!-- /generated:${name} -->`;
  const a = doc.indexOf(open), b = doc.indexOf(close);
  if (a < 0 || b < a) throw new Error(`markers for "${name}" not found`);
  return `${doc.slice(0, a + open.length)}\n<!-- Written by npm run docs from the code; edit the code, not this block. -->\n\n${body}\n\n${doc.slice(b)}`;
}
