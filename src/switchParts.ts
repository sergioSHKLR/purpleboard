// Changeover (SPDT) switches whose contacts a datasheet names. A three-terminal switch footprint
// says nothing about which throw is normally open: the part's drawing does. Matched by the part
// number in the value or by the design's LCSC order code, like the other part libraries.
export interface SwitchPartDef {
  /** Part-number prefix as printed in board values. */
  mpn: string;
  lcsc?: string[];
  /** Pad names of the common, normally-open and normally-closed terminals. */
  pins: { COM: string; NO: string; NC: string };
  source: string;
  note?: string;
}

const SWITCH_PARTS: SwitchPartDef[] = [
  { mpn: 'CMI126603D08', lcsc: ['C400256'], pins: { COM: '1', NO: '2', NC: '3' },
    source: 'Kailh CMI126603D08 (20M micro switch) drawing KHA-MI1266-001EN, rev. C, 2015-08-10',
    note: 'terminals in a row at 5.08 mm: 1 COM, 2 NO, 3 NC (circuit diagram and PCB layout); contact resistance 100 mΩ max; DC 30 V 0.1 A' },
];

/** The changeover switch a board part is: by its value, else by its LCSC order code. */
export function switchPartOf(c: { label?: string; lcsc?: string }): SwitchPartDef | undefined {
  const v = (c.label ?? '').toUpperCase().replace(/\s+/g, '');
  return SWITCH_PARTS.find((d) => v.startsWith(d.mpn)) ?? (c.lcsc ? SWITCH_PARTS.find((d) => d.lcsc?.includes(c.lcsc!)) : undefined);
}

export function allSwitchParts(): readonly SwitchPartDef[] { return SWITCH_PARTS; }
