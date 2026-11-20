// Host side of the solver API: the board as a plain netlist for a solver mod (built from the app's
// own connectivity, so a mod never needs geometry), and a mod's result turned back into the app's
// Sim. A result comes from untrusted code: every number is checked, anything odd reads as 0.
import type { Board, SwitchMap } from '../../types';
import type { Conn } from '../../connectivity';
import type { Sim, CompSim } from '../../sim';
import { LED_INFO, batteryRint, rolePadName } from '../../model';
import type { Netlist, NetPart, NetPin, SolveResult } from './types';

export function buildNetlist(board: Board, conn: Conn, title: string, switches?: SwitchMap): Netlist {
  const parts: NetPart[] = board.components.map((c) => {
    const items = conn.padItem.get(c) ?? [];
    const st = c.state;
    const roleOf = new Map<string, string>();
    for (const r of Object.keys(c.pins)) { const pad = rolePadName(c, r); if (pad !== undefined && !roleOf.has(pad)) roleOf.set(pad, r); }
    const pins: NetPin[] = c.pads.map((p, i) => {
      const item = items[i];
      const net = item === undefined ? -1 : conn.net[item];
      const cold = st.cold.includes(i);
      const ohms = cold ? st.coldOhms?.[i] : undefined;
      const open = (cold && ohms === undefined) || !!st.lifted?.includes(i) || !!st.netBreak?.includes(i);
      return { pad: p.name, net, ...(roleOf.has(p.name) && { role: roleOf.get(p.name) }), ...(open && { open: true }), ...(ohms !== undefined && !open && { ohms }) };
    });
    const pads = [...new Set(c.pads.map((p) => p.name))];
    const drifted = (c.kind === 'resistor' || c.kind === 'capacitor') && st.drift ? c.value * st.drift : c.value;
    return {
      ref: c.ref, kind: c.kind, value: drifted, pins,
      populated: st.populated, burnt: st.burnt,
      ...(c.valueGuessed && { valueGuessed: true }),
      ...(c.label && { label: c.label }),
      ...(c.kind === 'led' && c.color && { color: c.color, vf: LED_INFO[c.color].vf }),
      ...(c.kind === 'battery' && { rint: batteryRint(c.value) }),
      ...(c.kind === 'resistor' && { rating: c.rating ?? 0.5 }),
      ...(c.kind === 'switch' && { closed: switches?.[c.ref] ?? st.closed ?? false }),
      ...(st.leak && { leak: { ohms: st.leak.ohms, a: st.leak.a ?? pads[0], b: st.leak.b ?? pads[1] ?? pads[0] } }),
    };
  });
  return { title, nets: conn.netNames.map((name, id) => ({ id, name: name || null })), parts };
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** A solver mod's result as the app's Sim (unknown nets / parts ignored, bad numbers as 0). */
export function simFromResult(board: Board, conn: Conn, res: SolveResult): Sim {
  const nodeOfNet = new Map<number, number>();
  const volts: number[] = [];
  const nets = res && typeof res === 'object' && res.nets && typeof res.nets === 'object' ? res.nets : {};
  for (const [id, v] of Object.entries(nets)) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 0 || n >= conn.netCount || typeof v !== 'number' || !Number.isFinite(v)) continue;
    nodeOfNet.set(n, volts.length);
    volts.push(v);
  }
  const comps = new Map<string, CompSim>();
  const parts = res && typeof res === 'object' && res.parts && typeof res.parts === 'object' ? res.parts : {};
  for (const c of board.components) {
    const r = (parts as Record<string, unknown>)[c.ref] as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    comps.set(c.id, {
      i: num(r.i), v: num(r.v), p: num(r.p), on: r.on === true,
      bright: Math.max(0, Math.min(1, typeof r.bright === 'number' && Number.isFinite(r.bright) ? r.bright : r.on === true ? 1 : 0)),
      over: r.over === true,
      ...(typeof r.overMsg === 'string' && { overMsg: r.overMsg.slice(0, 200) }),
    });
  }
  return { nodeOfNet, V: Float64Array.from(volts), ground: -1, comps, source: res?.source !== false };
}
