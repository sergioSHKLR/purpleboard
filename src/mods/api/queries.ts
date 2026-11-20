// The board query layer (plug-in API v1, `api.queries`): read-only answers over the latest netlist
// and net voltages a code mod has seen. Pure and synchronous; never throws (a missing part gives
// near matches, which is what lets a coach refuse to invent a designator).
import type { NetPart, Netlist, Queries } from './types';

export interface QueryState { netlist: Netlist | null; volts: Map<string, number> | null }

const splitRef = (r: string) => { const m = /^([A-Za-z_]*)(\d*)/.exec(r)!; return { letters: m[1].toUpperCase(), n: m[2] ? Number(m[2]) : NaN }; };

export function makeQueries(state: QueryState): Queries {
  const parts = () => state.netlist?.parts ?? [];
  const netId = (net: string | number): number => {
    if (typeof net === 'number') return net;
    return state.netlist?.nets.find((n) => n.name === net)?.id ?? -1;
  };
  return {
    findRef(q) {
      const want = String(q ?? '').trim();
      const exact = parts().find((p) => p.ref.toUpperCase() === want.toUpperCase());
      if (exact) return { found: true, part: exact };
      const w = splitRef(want);
      const matches = parts()
        .filter((p) => { const s = splitRef(p.ref); return w.letters && s.letters === w.letters; })
        .sort((a, b) => Math.abs(splitRef(a.ref).n - w.n || 0) - Math.abs(splitRef(b.ref).n - w.n || 0))
        .slice(0, 5);
      return { found: false, matches };
    },
    parts: () => [...parts()],
    pinsOfNet(net) {
      const id = netId(net);
      if (id < 0) return [];
      return parts().flatMap((p: NetPart) => p.pins.filter((x) => x.net === id).map((x) => ({ ref: p.ref, pad: x.pad, ...(x.role && { role: x.role }) })));
    },
    netOfPin(ref, pad) {
      const p = parts().find((x) => x.ref === ref);
      const pin = p?.pins.find((x) => x.pad === String(pad));
      if (!pin || pin.net < 0) return null;
      return state.netlist?.nets[pin.net]?.name ?? pin.net;
    },
    railState(net) {
      const v = state.volts?.get(net);
      return { volts: v ?? null, powered: !!state.volts };
    },
  };
}
