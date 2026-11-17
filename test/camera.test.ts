// 3D orbit is grab-and-turn: on screen, the edge of the board nearest the viewer follows a
// horizontal drag, in every pose (top side, Bottom button, orbited over the edge to look up at
// the underside). With the invert toggle it moves against the drag.
import { Camera } from '../src/render/camera';
import { transform4 } from '../src/geom';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const W = 1200, H = 800, THICK = 1.6;
const settle = (c: Camera) => { for (let i = 0; i < 400; i++) c.tick(0.05); };

/** The board point 8 mm from the target toward the viewer, on the viewed face. */
function nearEdge(c: Camera): [number, number, number] {
  const { eye, isBack } = c.matrices(W, H);
  const hx = eye[0] - c.tx, hy = eye[1] - c.ty, hl = Math.hypot(hx, hy) || 1;
  return [c.tx + (hx / hl) * 8, c.ty + (hy / hl) * 8, (isBack ? -1 : 1) * THICK / 2];
}

/** Screen x (NDC) of a board point. */
function screenX(c: Camera, p: [number, number, number]): number {
  const [x, , , w] = transform4(c.matrices(W, H).viewProj, p[0], p[1], p[2], 1);
  return x / w;
}

/** How the board's near edge moves on screen for a small drag to the right (same point tracked). */
function dragRight(c: Camera): number {
  settle(c);
  const p = nearEdge(c);
  const before = screenX(c, p);
  c.orbit(6, 0);
  settle(c);
  return screenX(c, p) - before;
}

function fresh(invert = false): Camera {
  const c = new Camera();
  c.invertOrbit = invert;
  c.fitBoard(60, 40);
  c.setMode('3d');
  settle(c);
  return c;
}

/** Drag upward until the camera has gone over the board's edge to the underside. */
function orbitUnder(c: Camera) {
  for (let i = 0; i < 40 && c.side === 'F'; i++) { c.orbit(0, c.invertOrbit ? 20 : -20); settle(c); }
  assert(c.side === 'B' && c.matrices(W, H).isBack, 'orbiting over the edge reaches the underside');
  c.orbit(0, c.invertOrbit ? 20 : -20); // a little further under, well clear of edge-on
}

function run() {
  for (const invert of [false, true]) {
    const want = invert ? -1 : 1;
    const name = invert ? 'invert toggle' : 'grab';
    {
      const c = fresh(invert);
      assert(Math.sign(dragRight(c)) === want, `${name}: top side, near edge ${invert ? 'against' : 'follows'} the drag`);
    }
    {
      const c = fresh(invert);
      c.setSide('B');
      assert(Math.sign(dragRight(c)) === want, `${name}: Bottom button, near edge ${invert ? 'against' : 'follows'} the drag`);
    }
    {
      // top side tilted past face-on (negative pitch): the near edge is now at the top of the screen
      const c = fresh(invert);
      for (let i = 0; i < 4; i++) { c.orbit(0, invert ? -50 : 50); settle(c); }
      assert(c.side === 'F' && !c.matrices(W, H).isBack, 'still looking at the top side');
      assert(Math.sign(dragRight(c)) === want, `${name}: top side tilted past face-on, near edge ${invert ? 'against' : 'follows'} the drag`);
    }
    {
      const c = fresh(invert);
      orbitUnder(c);
      // several drags in a row: the direction must not flip back and forth
      for (let k = 0; k < 3; k++) assert(Math.sign(dragRight(c)) === want, `${name}: looking up at the underside, near edge ${invert ? 'against' : 'follows'} the drag (drag ${k + 1})`);
    }
  }
  console.log('CAMERA TESTS PASSED (grab orbit: top side, tilted past face-on, Bottom button, underside after orbiting over the edge, invert toggle)');
}

run();
