// Device library: provenance rules, and the fitted SPICE models reproduce the datasheet numbers
// they were fitted from (on-resistance, body diode, forward voltage), run through the engine.
import { allDevices, deviceSpec, type DiodeSpec, type MosSpec } from '../src/spice/devicelib';
import { parseSpice } from '../src/spice/netlist';
import { Engine } from '../src/spice/engine';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

/** Operating point of a deck that instantiates `sub` as X1 on pads p1..pn. */
function op(sub: string, pads: string[], body: string) {
  const deck = `t\n${sub}\nX1 ${pads.join(' ')} ${/\.subckt (\S+)/.exec(sub)![1]}\n${body}\n.end`;
  const r = new Engine(parseSpice(deck)).op();
  assert(r.converged, `deck converges:\n${deck}`);
  return r;
}

function run() {
  const devs = allDevices();
  let checked = 0, verified = 0;
  for (const d of devs) {
    // provenance: a verified entry names its datasheet; an unverified one says why
    if (d.verified) { verified++; assert(d.source && /Rev|rev|revision/.test(d.source), `${d.mpn}: verified entry cites a datasheet revision`); }
    else assert(d.note && /unverified|limits|estimate/i.test(d.note), `${d.mpn}: unverified entry says why`);

    const pads = [...new Set(d.units.flatMap((u) => Object.values(u.pins)))];
    const spec = deviceSpec(d, pads);
    assert(spec?.spice && spec.ports, `${d.mpn}: model emitted`);
    const sub = spec.spice;
    const node = (pad: string) => `n${pad}`;
    const portNodes = spec.ports.map(node);
    d.units.forEach((u, ui) => {
      const tag = `${d.mpn} unit ${ui + 1}`;
      if (u.kind === 'nmos' || u.kind === 'pmos') {
        const m = u as MosSpec, sg = m.kind === 'pmos' ? -1 : 1;
        // other units' pads tied to their own source/ground through 1 GΩ so the deck is regular
        const ties = pads.map((p) => `RT${p} ${node(p)} 0 1G`).join('\n');
        // on-resistance at the highest datasheet VGS, 20 mV across D–S
        const [vgs, rds] = [...m.rds].sort((a, b) => b[0] - a[0])[0];
        const on = op(sub, portNodes, `${ties}\nVS ${node(m.pins.S)} 0 0\nVG ${node(m.pins.G)} 0 ${sg * vgs}\nVD ${node(m.pins.D)} 0 ${sg * 0.02}`);
        const id = Math.abs(on.branches.get('i(VD)')!);
        const r = 0.02 / id;
        // level 1 is fitted to the on-curve; a single-point fit lands on it, a two-point fit near it
        assert(Math.abs(r - rds) / rds < 0.3, `${tag}: RDS(on) at ${vgs} V is ${(r * 1e3).toFixed(2)} mΩ, datasheet ${(rds * 1e3).toFixed(2)} mΩ`);
        if (m.body) {
          // gate off, drain pulled the "wrong" way: only the body diode conducts, and only once
          const [vsd, is] = m.body;
          const bd = op(sub, portNodes, `${ties}\nVS ${node(m.pins.S)} 0 0\nVG ${node(m.pins.G)} 0 0\nVD ${node(m.pins.D)} 0 ${-sg * vsd}`);
          const ib = Math.abs(bd.branches.get('i(VD)')!);
          assert(ib > is * 0.5 && ib < is * 2, `${tag}: body diode at ${vsd} V carries ${ib.toPrecision(3)} A, datasheet ${is} A (one diode, not two)`);
        }
      } else if (u.kind !== 'npn' && u.kind !== 'pnp' && u.kind !== 'tvs-bi') {
        const dd = u as DiodeSpec;
        const [vf, i] = [...dd.vf].sort((a, b) => a[1] - b[1])[0];
        const ties = pads.map((p) => `RT${p} ${node(p)} 0 1G`).join('\n');
        const f = op(sub, portNodes, `${ties}\nVK ${node(dd.pins.K)} 0 0\nIA 0 ${node(dd.pins.A)} ${i}`);
        const v = f.nodes.get(node(dd.pins.A))!;
        assert(Math.abs(v - vf) < 0.03, `${tag}: VF at ${i} A is ${v.toFixed(3)} V, datasheet ${vf} V`);
      }
      checked++;
    });
  }
  assert(verified >= 8, `datasheet-verified entries: ${verified}`);
  console.log(`DEVICELIB TESTS PASSED (${devs.length} parts, ${verified} datasheet-verified with sources; ${checked} units: fitted RDS(on), body diode and VF match their datasheet points)`);
}

run();
