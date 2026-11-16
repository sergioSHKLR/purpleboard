declare module 'earcut' {
  /** Triangulates a flat [x0, y0, x1, y1, …] polygon (optionally with holes); returns vertex index triples. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
}
