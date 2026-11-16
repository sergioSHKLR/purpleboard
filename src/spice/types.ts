// SPICE circuit intermediate representation. Mirrors the subset of the SPICE3/ngspice
// netlist language that the engine understands, so a Circuit round-trips through
// `writeSpice` / `parseSpice` and runs identically here and in ngspice.

/** Node names are SPICE node names; "0" is ground. */
export type NodeName = string;

export type Waveform =
  | { type: 'dc'; v: number }
  | { type: 'pulse'; v1: number; v2: number; td: number; tr: number; tf: number; pw: number; per: number }
  | { type: 'sin'; vo: number; va: number; freq: number; td: number; theta: number }
  | { type: 'pwl'; pts: [number, number][] };

export type ModelType = 'D' | 'NMOS' | 'PMOS' | 'NPN' | 'PNP' | 'SW';

export interface Model {
  name: string;
  type: ModelType;
  params: Record<string, number>;
}

interface Base {
  /** Full SPICE instance name, first letter is the element letter (e.g. "R7788"). */
  name: string;
  /** Free-text comment emitted after the card (provenance, pad mapping…). */
  note?: string;
}

export type Element =
  | (Base & { kind: 'R'; n: [NodeName, NodeName]; value: number })
  | (Base & { kind: 'C'; n: [NodeName, NodeName]; value: number; ic?: number })
  | (Base & { kind: 'L'; n: [NodeName, NodeName]; value: number; ic?: number })
  | (Base & { kind: 'V'; n: [NodeName, NodeName]; wave: Waveform })
  | (Base & { kind: 'I'; n: [NodeName, NodeName]; wave: Waveform })
  | (Base & { kind: 'D'; n: [NodeName, NodeName]; model: string; area?: number })
  | (Base & { kind: 'M'; n: [NodeName, NodeName, NodeName, NodeName]; model: string; w?: number; l?: number })
  | (Base & { kind: 'Q'; n: [NodeName, NodeName, NodeName]; model: string; area?: number })
  | (Base & { kind: 'S'; n: [NodeName, NodeName, NodeName, NodeName]; model: string; on?: boolean })
  | (Base & { kind: 'E'; n: [NodeName, NodeName, NodeName, NodeName]; gain: number })
  | (Base & { kind: 'G'; n: [NodeName, NodeName, NodeName, NodeName]; gain: number })
  | (Base & { kind: 'X'; n: NodeName[]; subckt: string })
  /** Behavioral source (ngspice B): V={expr} (voltage) or I={expr} (current n+ → n−). */
  | (Base & { kind: 'B'; n: [NodeName, NodeName]; mode: 'V' | 'I'; expr: string });

export type ElementKind = Element['kind'];

export interface Subckt {
  name: string;
  ports: NodeName[];
  elements: Element[];
  models: Model[];
  note?: string;
}

export type Analysis =
  | { type: 'op' }
  | { type: 'dc'; src: string; start: number; stop: number; step: number }
  | { type: 'tran'; tstep: number; tstop: number; tstart?: number; tmax?: number; uic?: boolean };

export interface Circuit {
  title: string;
  elements: Element[];
  models: Model[];
  subckts: Subckt[];
  analyses: Analysis[];
  /** `.option` values (lower-case keys), e.g. reltol, abstol, vntol, gmin, rshunt, itl1. */
  options: Record<string, number>;
  /** Header comment lines (without the leading "*"). */
  comments?: string[];
}

export function emptyCircuit(title = 'untitled'): Circuit {
  return { title, elements: [], models: [], subckts: [], analyses: [], options: {}, comments: [] };
}
