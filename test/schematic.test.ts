// Schematic PDF extraction tests (820-00165). Checks known parts, BOM semantics, and
// physics-based consistency of every extracted value so association errors are caught.
import { PdfDocument } from '../src/io/pdf';
import { extractSchematic, isStuffed, parseFarads, parseHenries, parseInductor, parseOhms, resolveOptions } from '../src/io/schematic';
import { schematicToLibrary } from '../src/io/schematicLibrary';
import { parseBrd } from '../src/io/brd';
import { buildConnectivity } from '../src/connectivity';
import { boardToCircuit, type PartLibrary } from '../src/spice/board';
import { Engine } from '../src/spice/engine';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg}: expected ${String(b)}, got ${String(a)}`);

interface Fs { readFileSync(p: URL): Uint8Array; existsSync(p: URL): boolean }
interface Zlib { inflateSync(d: Uint8Array): Uint8Array }

async function run() {
  // ---- value grammar ----
  eq(parseOhms('301K'), 301e3, '301K'); eq(parseOhms('4.7K'), 4.7e3, '4.7K'); eq(parseOhms('1M'), 1e6, 'Apple 1M = 1 MΩ');
  eq(parseOhms('0'), 0, '0 Ω'); eq(parseOhms('100KOHM'), 100e3, '100KOHM'); eq(parseOhms('4K7'), 4.7e3, '4K7');
  const f = parseFarads('62UF-0.023OHM')!; assert(Math.abs(f.f - 62e-6) < 1e-15 && f.esr === 0.023, 'polymer cap with ESR');
  assert(Math.abs(parseFarads('150UF-0.018OHM-1.8A')!.f - 150e-6) < 1e-15, 'cap with ripple rating');
  assert(Math.abs(parseFarads('0.1uF')!.f - 1e-7) < 1e-18, 'lower-case unit');
  const i1 = parseInductor('2.2UH-240MA-0.221OHM')!; assert(Math.abs(i1.h! - 2.2e-6) < 1e-15 && Math.abs(i1.amps! - 0.24) < 1e-12 && i1.dcr === 0.221, 'L with Isat + DCR');
  const i2 = parseInductor('1.0UH-1.6A-55MOHM')!; assert(Math.abs(i2.dcr! - 0.055) < 1e-12, 'mΩ DCR');
  const i3 = parseInductor('10UH-20%-0.85A-0.46OHM')!; assert(i3.tol === '20%' && i3.dcr === 0.46, 'L with tolerance');
  const b1 = parseInductor('FERR-1000-OHM-450MA')!; assert(b1.beadOhms === 1000 && Math.abs(b1.amps! - 0.45) < 1e-12, 'ferrite bead');
  assert(parseInductor('PIMB053T-SM') === undefined, 'part number is not a value');
  const h = parseHenries('15UH-2.8A')!; assert(Math.abs(h.h - 15e-6) < 1e-15 && h.amps === 2.8, 'inductor with Isat');

  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
  const zlib = (await import(/* @vite-ignore */ 'node:' + 'zlib')) as Zlib;
  const pdfUrl = new URL('../board_schemas/schematic-macbook-j113-82000165-05100385.pdf', import.meta.url);
  if (!fs.existsSync(pdfUrl)) { console.log('SCHEMATIC TESTS SKIPPED (schematic PDF not present)'); return; }

  const t0 = performance.now();
  const pages = new PdfDocument(new Uint8Array(fs.readFileSync(pdfUrl)), (d) => new Uint8Array(zlib.inflateSync(d))).pages();
  eq(pages.length, 76, 'sheet count');
  const brd = parseBrd(new Uint8Array(fs.readFileSync(new URL('../board_schemas/J113  820-00165.brd', import.meta.url))));
  const comps = brd.board.components.filter((c) => !c.ref.startsWith('J_'));
  const nets = new Set(comps.flatMap((c) => c.pads.map((p) => p.net).filter((n): n is string => !!n)));
  const sch = extractSchematic(pages, { refs: comps.map((c) => c.ref), nets });
  const ms = performance.now() - t0;

  // ---- known parts (backlight circuit, sheet 56) ----
  const P = (r: string) => sch.parts.get(r)!;
  eq(P('R7788').value, 301e3, 'R7788'); eq(P('R7788').tolerance, '1%', 'R7788 tol'); eq(P('R7788').power, '1/20W', 'R7788 power');
  eq(P('R7789').value, 147e3, 'R7789');
  assert(Math.abs(P('C7140').value! - 62e-6) < 1e-12 && P('C7140').esr === 0.023 && P('C7140').voltage === '11V', 'C7140 62uF/23mΩ/11V');
  assert(Math.abs(P('L7701').value! - 15e-6) < 1e-12 && P('L7701').irated === 2.8, 'L7701 15uH/2.8A');
  eq(P('Q7706').partNumber, 'FDC638APZ_SBMS001', 'Q7706 part'); eq(P('Q7707').partNumber, 'DMN5L06VK-7', 'Q7707 part');
  eq(P('D7701').partNumber, 'RB160M-60G', 'D7701 part'); eq(P('F7700').partNumber, '3AMP-32V-467', 'F7700 part');
  eq(P('R1310').value, 33, 'inline-value template (R1310 = 33 Ω)');
  eq(P('R0610').value, 62, 'offset-column template (R0610 = 62 Ω)');
  assert(Math.abs(P('R5490').value! - 0.02) < 1e-12 && P('R5490').shortFootprint, 'inverted template + SHORT footprint (R5490 0.020 Ω)');
  eq(P('R4006').valueKind, 'C', 'cap fitted on an R footprint (R4006 = 100 pF)');

  // ---- BOM semantics ----
  eq(sch.bom.products.length, 21, 'product configurations');
  const opts = resolveOptions(sch.bom, '639-00623');
  for (const o of ['BKLT:PROD', 'ISNS:ENG', 'DDR3:HYNIX_4GB', 'CPU:2.1GHZ', 'MLB_COMMON']) assert(opts.has(o), `639-00623 resolves ${o}`);
  eq(isStuffed(P('C1061'), opts), false, 'NO STUFF part'); eq(isStuffed(P('R0640'), opts), false, 'NOSTUFF part');
  eq(isStuffed(P('R5115'), opts), false, 'OMIT part'); eq(isStuffed(P('R7788'), opts), true, 'plain part fitted');

  // ---- physics consistency of every extracted value ----
  const railV = (n: string): number | null => {
    if (/^(PPBUS|PPDCIN|PPVBAT)/.test(n)) return 8.6;
    const m = /^PP(\d+)V(\d*)/.exec(n);
    return m ? parseFloat(`${m[1]}.${m[2] || 0}`) : null;
  };
  let rated = 0;
  for (const c of comps.filter((x) => /^C\d/.test(x.ref))) {
    const p = P(c.ref);
    if (!p.voltage) continue;
    const vs = c.pads.map((x) => (x.net ? railV(x.net) : null)).filter((x): x is number => x !== null);
    if (!vs.length) continue;
    rated++;
    assert(parseFloat(p.voltage) >= Math.max(...vs) * 0.95, `${c.ref}: ${p.voltage} cap on a ${Math.max(...vs)} V rail — wrong association?`);
  }
  assert(rated > 400, `voltage-rating check covers ${rated} caps`);
  const PKG_POWER: Record<string, RegExp> = { '1/20W': /^0?201$/, '1/16W': /^0?402$/, '1/10W': /^0?603$/, '1/4W': /^1206$/, '1W': /0612/ };
  let pp = 0;
  for (const p of sch.parts.values()) {
    if (!/^R\d/.test(p.ref) || !p.power || !p.pkg || !PKG_POWER[p.power]) continue;
    pp++;
    assert(PKG_POWER[p.power].test(p.pkg), `${p.ref}: ${p.power} on package ${p.pkg} — mixed-up properties?`);
  }
  assert(pp > 400, `power/package check covers ${pp} resistors`);

  // ---- coverage floors ----
  const cov = (re: RegExp) => {
    const list = comps.filter((c) => re.test(c.ref));
    return list.filter((c) => P(c.ref).value !== undefined || P(c.ref).bomOption || P(c.ref).shortFootprint).length / list.length;
  };
  assert(cov(/^R\d/) >= 0.98, `resistor coverage ${cov(/^R\d/)}`);
  assert(cov(/^C\d/) >= 0.98, `capacitor coverage ${cov(/^C\d/)}`);
  assert(cov(/^L\d/) >= 0.85, `inductor coverage ${cov(/^L\d/)}`); // rest: part-number-only and 4-pad chokes

  // ---- library → SPICE ----
  const lib = schematicToLibrary(sch, comps, '639-00623');
  const nl = boardToCircuit(brd.board, buildConnectivity(brd.board), { library: lib.library as PartLibrary, infer: true });
  const inferred = nl.report.filter((r) => r.source === 'inferred').length;
  assert(inferred < 80, `values still inferred with schematic library: ${inferred}`);
  const e = new Engine(nl.circuit);
  const op = e.op();
  assert(op.converged, 'schematic-backed board converges');

  // ---- discrete devices: resolved by part number, pin maps net-checked ----
  const devStat = lib.devices.report.reduce<Record<string, number>>((m, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {});
  assert((devStat.modelled ?? 0) >= 60, `discrete devices modelled: ${devStat.modelled}`);
  eq(devStat.rejected ?? 0, 0, 'device pin maps rejected by net checks');
  eq(lib.devices.convention.pad1, 'A', 'this board: diode pad 1 = anode');
  // Backlight enable chain from device physics: Q7707 (series dual N-FET) → R7788/R7789 → Q7706 P-FET.
  const chain = (drive: [string, number][]) => {
    const c = structuredClone(nl.circuit);
    drive.forEach(([n, v], i) => c.elements.push({ kind: 'V', name: `VDRV${i}`, n: [n, '0'], wave: { type: 'dc', v } }));
    const en = new Engine(c), o = en.op();
    assert(o.converged, 'enable-chain op converges');
    if (drive.length === 2) {
      const div = en.voltage(o.x, 'LCDBKLT_EN_DIV_L')!;
      assert(Math.abs(div - 8.6 * 147 / 448) < 0.02, `enabled: real 301k/147k gate divider, got ${div}`);
    }
    return en.voltage(o.x, 'PPVIN_S0SW_LCDBKLT_FET')!;
  };
  assert(chain([]) < 0.1, 'load switch off with enables undriven');
  assert(chain([['EDP_BKLT_EN', 3.3]]) < 0.1, 'load switch off with only EDP_BKLT_EN (series AND)');
  assert(chain([['EDP_BKLT_EN', 3.3], ['BKLT_PLT_RST_L', 3.3]]) > 8.5, 'load switch on with both enables');

  console.log(`SCHEMATIC TESTS PASSED (${sch.parts.size} parts in ${ms.toFixed(0)} ms; ${rated} cap ratings + ${pp} R power/package pairs consistent; ${inferred} values left inferred)`);
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
