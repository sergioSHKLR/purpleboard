// Oscilloscope. The board is solved as DC operating points with averaged (behavioral)
// regulators, so fast waveforms are not simulated cycle by cycle; they are SYNTHESIZED from
// the solved state and the converter model and labelled as such:
//   - a running buck/boost's switch node: square wave 0 … Vin, duty = Vout/Vin (buck),
//     at a typical switching frequency (estimate);
//   - regulated rails: DC + switching ripple (estimate);
//   - clock / crystal nets whose name states a frequency (32K, 24M, 100MHZ…) and whose
//     driver has power: a clock of that frequency.
// Slow behaviour (power-up ramps, sequencing, boot loops) is real simulated data, recorded
// by the caller from successive solves (roll mode).
import type { PowerTree } from './spice/powertree';

export type SignalKind = 'dc' | 'switch' | 'clock';

export interface ScopeSignal {
  kind: SignalKind;
  /** Average / DC level (V). */
  dc: number;
  /** Peak-to-peak amplitude of the AC part (V). */
  pp: number;
  /** Hz (0 for DC). */
  freq: number;
  /** Switch / clock duty cycle 0..1. */
  duty: number;
  /** What the trace is and how much of it is synthesized. */
  note: string;
}

/** Typical switching frequency of a laptop-class converter (Hz). Estimate. */
export const FSW = 600e3;
/** Output ripple as a fraction of the rail voltage (estimate). */
export const RIPPLE_FRACTION = 0.008;

/** Frequency stated in a net name (32K → 32.768 kHz, 24M / 24MHZ → 24 MHz, 100MHZ, 19P2M → 19.2 MHz). */
export function nameFrequency(net: string): number | null {
  const n = net.toUpperCase();
  if (!/(CLK|XTAL|OSC|XIN|XOUT|RTC|CRYSTAL|_X\d|X32K)/.test(n) && !/\d+K(HZ)?\b|\d+M(HZ)?\b/.test(n)) return null;
  if (/32K|32\.768|32768/.test(n)) return 32768;
  const m = /(\d+)(?:P(\d+))?(K|M)(?:HZ)?(?![A-Z])/.exec(n) ?? /(\d+)(?:P(\d+))?(K|M)HZ/.exec(n);
  if (!m) return null;
  const v = parseFloat(`${m[1]}.${m[2] ?? 0}`) * (m[3] === 'M' ? 1e6 : 1e3);
  return v >= 1e3 && v <= 2e9 ? v : null;
}

/**
 * What the scope shows on a net. `volt(net)` reads the solved voltage of a net by name
 * (undefined: not in the solution). `clockSupply`: highest powered supply rail (V) of a chip on
 * this net — a clock only runs while its driver has power (0 / undefined: none powered).
 */
export function signalOn(netName: string, v: number, tree: PowerTree | null, volt: (n: string) => number | undefined, clockSupply = 0): ScopeSignal {
  const dc = (note: string): ScopeSignal => ({ kind: 'dc', dc: v, pp: 0, freq: 0, duty: 0, note });
  if (tree) {
    const conv = tree.sources.find((s) => s.switchNode === netName && (s.kind === 'buck' || s.kind === 'boost'));
    if (conv) {
      const vin = conv.input ? volt(conv.input) ?? 0 : 0, vout = volt(conv.output) ?? 0;
      const target = conv.vTarget ?? 0;
      const running = vin > 1 && target > 0 && vout > 0.8 * target;
      if (!running) return dc(`${conv.ref} switch node — converter not switching (output ${vout.toFixed(2)} V)`);
      const duty = conv.kind === 'buck' ? Math.min(0.95, vout / vin) : Math.min(0.95, 1 - vin / vout);
      const high = conv.kind === 'buck' ? vin : vout;
      return { kind: 'switch', dc: high * duty, pp: high, freq: FSW, duty, note: `${conv.ref} switch node: ${conv.kind} running, duty ${(duty * 100).toFixed(0)} % — waveform synthesized (fsw ${FSW / 1e3} kHz typical, estimate)` };
    }
    const reg = tree.sources.find((s) => s.output === netName && (s.kind === 'buck' || s.kind === 'boost'));
    if (reg && reg.vTarget && v > 0.8 * reg.vTarget) {
      return { kind: 'switch', dc: v, pp: Math.max(0.002, v * RIPPLE_FRACTION), freq: FSW, duty: 0.5, note: `${netName}: ${reg.kind} output, ripple synthesized (${(RIPPLE_FRACTION * 100).toFixed(1)} % p-p at ${FSW / 1e3} kHz, estimate)` };
    }
  }
  const f = nameFrequency(netName);
  if (f) {
    // a clock only runs while the chip driving it has power
    if (clockSupply < 0.8) return dc(`${netName}: clock net (${fmtHz(f)} by name) — no oscillation: no powered chip on this net`);
    const crystal = f < 1e6 || /XTAL|XIN|XOUT|CRYSTAL/i.test(netName);
    const pp = crystal ? 0.6 * clockSupply : clockSupply; // crystal pins swing less than logic clocks
    return { kind: 'clock', dc: crystal ? clockSupply / 2 : pp / 2, pp, freq: f, duty: 0.5, note: `${netName}: ${fmtHz(f)} ${crystal ? 'crystal' : 'clock'} (frequency from the net name; waveform synthesized)` };
  }
  return dc(`${netName}: DC level from the simulation`);
}

export const fmtHz = (f: number) => (f >= 1e6 ? `${+(f / 1e6).toPrecision(4)} MHz` : f >= 1e3 ? `${+(f / 1e3).toPrecision(4)} kHz` : `${f.toFixed(0)} Hz`);

/** Samples a signal over [t0, t0 + span] with a little front-end noise (deterministic per seed). */
export function sampleSignal(s: ScopeSignal, t0: number, span: number, n: number, seed = 1): Float64Array {
  const out = new Float64Array(n);
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
  const noise = 0.004 + Math.abs(s.dc) * 0.002;
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / (n - 1);
    let v = s.dc;
    if (s.kind === 'switch' && s.pp > 0) {
      const ph = (t * s.freq) % 1;
      if (s.pp > s.dc * 0.5) {
        // switch node: square wave with finite edges and ringing on the rising edge
        const edge = 0.02;
        const lvl = ph < edge ? ph / edge : ph < s.duty ? 1 : ph < s.duty + edge ? 1 - (ph - s.duty) / edge : 0;
        const ring = ph < s.duty && ph > edge ? 0.12 * Math.exp(-(ph - edge) * 60) * Math.sin((ph - edge) * 220) : 0;
        v = s.pp * (lvl + ring);
      } else {
        v = s.dc + (s.pp / 2) * (ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph); // triangular ripple
      }
    } else if (s.kind === 'clock') {
      const ph = (t * s.freq) % 1;
      // crystals look sinusoidal, logic clocks square-ish: soften with a sine blend
      const sq = ph < s.duty ? 1 : -1, sn = Math.sin(ph * Math.PI * 2);
      v = s.dc + (s.pp / 2) * (s.freq < 1e6 ? sn : 0.6 * sq + 0.4 * sn);
    }
    out[i] = v + noise * rnd() * 2;
  }
  return out;
}
