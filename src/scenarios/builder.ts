import type { Board, Component, LedColor, Pad, Side, V2 } from '../types';
import { rot } from '../geom';

export function emptyBoard(w: number, h: number): Board {
  return { w, h, thickness: 1.6, components: [], traces: [], vias: [], blobs: [], jumpers: [], zones: [], silk: [], texts: [], nextId: 1 };
}

const tht = (name: string, at: V2, d = 1.8, shape: Pad['shape'] = 'circle', drill = 0.9): Pad =>
  ({ name, at, size: [d, d], shape, layers: 'FB', drill });

type CompInit = Omit<Component, 'id' | 'state' | 'side'> & { side?: Side; closed?: boolean };

/** Small DSL for authoring boards in code. */
export class Builder {
  b: Board;
  constructor(w: number, h: number) { this.b = emptyBoard(w, h); }

  private comp(c: CompInit): Component {
    const { closed, ...rest } = c;
    const comp: Component = {
      id: 'c' + (this.b.nextId++).toString(36), side: 'F',
      state: { populated: true, reversed: false, burnt: false, cold: [], closed: !!closed },
      ...rest,
    };
    this.b.components.push(comp);
    return comp;
  }

  resistor(ref: string, ohms: number, at: V2, r = 0, pitch = 10.16) {
    return this.comp({
      ref, kind: 'resistor', value: ohms, at, rot: r,
      pads: [tht('1', [-pitch / 2, 0]), tht('2', [pitch / 2, 0])], pins: { '1': '1', '2': '2' },
      body: { shape: 'axial', w: 6.3, h: 2.5, z: 3.4 },
    });
  }

  led(ref: string, color: LedColor, at: V2, r = 0) {
    return this.comp({
      ref, kind: 'led', value: 0, color, at, rot: r,
      pads: [tht('1', [-1.27, 0], 1.8, 'rect'), tht('2', [1.27, 0])], pins: { A: '2', K: '1' },
      body: { shape: 'led', w: 5, h: 5, z: 8.6 },
    });
  }

  diode(ref: string, at: V2, r = 0, pitch = 10.16) {
    return this.comp({
      ref, kind: 'diode', value: 0.7, at, rot: r,
      pads: [tht('1', [-pitch / 2, 0], 1.9, 'rect'), tht('2', [pitch / 2, 0])], pins: { A: '2', K: '1' },
      body: { shape: 'axial', w: 5.2, h: 2.7, z: 2.8 },
    });
  }

  coin(ref: string, volts: number, at: V2) {
    return this.comp({
      ref, kind: 'battery', value: volts, label: 'CR2032', at, rot: 0,
      pads: [tht('1', [-12, 0], 2.6, 'rect', 1.2), tht('2', [12, 0], 2.6, 'circle', 1.2)], pins: { '+': '1', '-': '2' },
      body: { shape: 'coin', w: 20, h: 20, z: 3.4 },
    });
  }

  header(ref: string, volts: number, at: V2, r = 0, label = 'DC IN') {
    return this.comp({
      ref, kind: 'battery', value: volts, label, at, rot: r,
      pads: [tht('1', [0, -1.27], 1.7, 'rect', 1.0), tht('2', [0, 1.27], 1.7, 'circle', 1.0)], pins: { '+': '1', '-': '2' },
      body: { shape: 'header', w: 2.54, h: 5.08, z: 8.5 },
    });
  }

  tactile(ref: string, at: V2) {
    return this.comp({
      ref, kind: 'switch', value: 0, at, rot: 0, closed: false,
      pads: [tht('1', [-3.25, -2.25], 2, 'circle', 1), tht('1', [-3.25, 2.25], 2, 'circle', 1),
        tht('2', [3.25, -2.25], 2, 'circle', 1), tht('2', [3.25, 2.25], 2, 'circle', 1)],
      pins: { '1': '1', '2': '2' },
      body: { shape: 'tactile', w: 6, h: 6, z: 5 },
    });
  }

  fuse(ref: string, amps: number, at: V2, r = 0, pitch = 12.7) {
    return this.comp({
      ref, kind: 'fuse', value: amps, at, rot: r,
      pads: [tht('1', [-pitch / 2, 0], 2), tht('2', [pitch / 2, 0], 2)], pins: { '1': '1', '2': '2' },
      body: { shape: 'fuse', w: 8.5, h: 2.6, z: 3.6 },
    });
  }

  testpoint(ref: string, at: V2, label?: string) {
    return this.comp({
      ref, kind: 'testpoint', value: 0, label, at, rot: 0,
      pads: [tht('1', [0, 0], 2.0, 'circle', 1.0)], pins: { '1': '1' },
      body: { shape: 'pin', w: 1.4, h: 1.4, z: 4 },
    });
  }

  pad(c: Component, name: string): V2 {
    const p = c.pads.find((q) => q.name === name)!;
    const r = rot(p.at, c.rot);
    return [c.at[0] + r[0], c.at[1] + r[1]];
  }

  track(layer: Side, pts: V2[], w = 0.8, net?: string): string[] {
    const ids: string[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const id = 't' + (this.b.nextId++).toString(36);
      ids.push(id);
      this.b.traces.push({ id, layer, a: pts[i], b: pts[i + 1], w, net });
    }
    return ids;
  }

  via(at: V2, net?: string) {
    this.b.vias.push({ id: 'v' + (this.b.nextId++).toString(36), at, d: 1.2, drill: 0.6, net });
  }

  text(at: V2, text: string, size = 1.6, side: Side = 'F') {
    this.b.texts.push({ at, text, size, side });
  }

  trace(id: string) { return this.b.traces.find((t) => t.id === id)!; }
}
