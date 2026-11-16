// Sparse LU for MNA systems (unsymmetric, structurally zero diagonals on branch rows).
// Right-looking Gaussian elimination with Markowitz pivot selection under a relative
// threshold, like Kundert's Sparse 1.3 used by SPICE3. The pivot sequence found on the
// first factorisation is reused on later Newton iterations (same sparsity pattern) and
// only re-searched when a cached pivot fails the threshold test.

export class SparseMatrix {
  readonly rows: Map<number, number>[];
  constructor(readonly n: number) {
    this.rows = Array.from({ length: n }, () => new Map<number, number>());
  }
  /** Adds v at (i,j); negative indices are the ground row/column and are dropped. */
  add(i: number, j: number, v: number): void {
    if (i < 0 || j < 0 || v === 0) return;
    const r = this.rows[i];
    r.set(j, (r.get(j) ?? 0) + v);
  }
  get(i: number, j: number): number {
    return this.rows[i]?.get(j) ?? 0;
  }
  clear(): void {
    for (const r of this.rows) r.clear();
  }
  nnz(): number {
    let s = 0;
    for (const r of this.rows) s += r.size;
    return s;
  }
}

export interface SolveResult {
  x: Float64Array;
  /** Columns that had no usable pivot (their unknown was set to 0). */
  singular: number[];
}

const THRESHOLD = 1e-3;
const TINY = 1e-300;
const SEARCH_COLS = 4;

export class SparseLU {
  private pr: Int32Array | null = null;
  private pc: Int32Array | null = null;

  /** Forgets the cached pivot order (call when the circuit topology changes). */
  reset(): void {
    this.pr = this.pc = null;
  }

  /** Solves A·x = b. Destroys A and b. */
  solve(A: SparseMatrix, b: Float64Array): SolveResult {
    const n = A.n;
    const rows = A.rows;
    const colRows: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    for (let i = 0; i < n; i++) for (const j of rows[i].keys()) colRows[j].add(i);

    const rowActive = new Uint8Array(n).fill(1);
    const colActive = new Uint8Array(n).fill(1);
    const activeCols: number[] = Array.from({ length: n }, (_, i) => i);
    const colPos = Int32Array.from(activeCols);
    const dropCol = (c: number) => {
      colActive[c] = 0;
      const p = colPos[c], last = activeCols.pop()!;
      if (last !== c) { activeCols[p] = last; colPos[last] = p; }
    };

    const reuse = this.pr && this.pr.length === n;
    const pr = reuse ? this.pr! : new Int32Array(n);
    const pc = reuse ? this.pc! : new Int32Array(n);
    const dead = new Uint8Array(n); // step k produced no pivot
    const singular: number[] = [];
    let searching = !reuse;

    const colMax = (c: number) => {
      let m = 0;
      for (const i of colRows[c]) { const v = Math.abs(rows[i].get(c)!); if (v > m) m = v; }
      return m;
    };

    for (let k = 0; k < n; k++) {
      let r = -1, c = -1;
      if (!searching) {
        const cr = pr[k], cc = pc[k];
        if (rowActive[cr] && colActive[cc]) {
          const a = Math.abs(rows[cr].get(cc) ?? 0);
          if (a > TINY && a >= THRESHOLD * colMax(cc)) { r = cr; c = cc; }
        }
        if (r < 0) searching = true;
      }
      if (searching) {
        // Markowitz: look at the few sparsest active columns, choose the entry with the
        // smallest (rowcount-1)(colcount-1) among those passing the threshold test.
        const cand: number[] = [];
        for (const cj of activeCols) {
          const cnt = colRows[cj].size;
          if (cand.length < SEARCH_COLS) { cand.push(cj); cand.sort((x, y) => colRows[x].size - colRows[y].size); }
          else if (cnt < colRows[cand[SEARCH_COLS - 1]].size) {
            cand[SEARCH_COLS - 1] = cj;
            cand.sort((x, y) => colRows[x].size - colRows[y].size);
          }
          if (cnt <= 1 && cand.length >= 1 && colRows[cand[0]].size <= 1) {
            // a singleton column is optimal; stop scanning early
            if (cnt === 1) break;
          }
        }
        let best = Infinity, bestMag = 0;
        for (const cj of cand) {
          const cmax = colMax(cj);
          if (cmax <= TINY) continue;
          const ccnt = colRows[cj].size - 1;
          for (const i of colRows[cj]) {
            const a = Math.abs(rows[i].get(cj)!);
            if (a < THRESHOLD * cmax) continue;
            const cost = (rows[i].size - 1) * ccnt;
            if (cost < best || (cost === best && a > bestMag)) { best = cost; bestMag = a; r = i; c = cj; }
          }
          if (best === 0) break;
        }
        if (r < 0) {
          // No candidate in the sparsest columns: fall back to a full scan.
          for (const cj of activeCols) {
            const cmax = colMax(cj);
            if (cmax <= TINY) continue;
            for (const i of colRows[cj]) {
              const a = Math.abs(rows[i].get(cj)!);
              if (a < THRESHOLD * cmax) continue;
              const cost = (rows[i].size - 1) * (colRows[cj].size - 1);
              if (cost < best) { best = cost; r = i; c = cj; }
            }
          }
        }
        if (r < 0) {
          // Structurally/numerically singular: retire an empty column with the emptiest row.
          c = activeCols[0];
          let bestRow = -1, bestSize = Infinity;
          for (let i = 0; i < n; i++) if (rowActive[i] && rows[i].size < bestSize) { bestSize = rows[i].size; bestRow = i; }
          r = bestRow;
          dead[k] = 1;
          singular.push(c);
        }
      }

      pr[k] = r; pc[k] = c;
      if (!dead[k]) {
        const rowR = rows[r];
        const piv = rowR.get(c)!;
        const br = b[r];
        for (const i of colRows[c]) {
          if (i === r) continue;
          const rowI = rows[i];
          const f = rowI.get(c)! / piv;
          rowI.delete(c);
          for (const [j, v] of rowR) {
            if (j === c) continue;
            const old = rowI.get(j);
            if (old === undefined) { rowI.set(j, -f * v); colRows[j].add(i); }
            else rowI.set(j, old - f * v);
          }
          b[i] -= f * br;
        }
      }
      rowActive[r] = 0;
      for (const j of rows[r].keys()) colRows[j].delete(r);
      colRows[c].clear();
      dropCol(c);
    }

    this.pr = pr; this.pc = pc;

    const x = new Float64Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const r = pr[k], c = pc[k];
      if (dead[k]) { x[c] = 0; continue; }
      let s = b[r];
      let piv = 0;
      for (const [j, v] of rows[r]) {
        if (j === c) piv = v;
        else s -= v * x[j];
      }
      x[c] = s / piv;
    }
    if (singular.length) this.reset();
    return { x, singular };
  }
}
