// Touch support: the gesture recogniser (tap / drag / pinch), the mobile-layout switch, and the
// touch wording of every tutorial step (no clicks, right-clicks or keyboard shortcuts left).
import { TouchGestures, touchCopy, wantsMobileLayout, type GestureSink } from '../src/ui/touch';
import { BEGINNER_PRIMER_HTML, TUTORIALS_BY_SCENARIO, TUTORIAL_STEPS } from '../src/ui/tutorial';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

type Ev = [string, ...number[]];
function rig(mode: 'pan' | 'orbit' = 'pan') {
  const ev: Ev[] = [];
  const sink: GestureSink = {
    tap: (x, y) => ev.push(['tap', x, y]),
    pan: (dx, dy) => ev.push(['pan', dx, dy]),
    orbit: (dx, dy) => ev.push(['orbit', dx, dy]),
    zoom: (f, x, y) => ev.push(['zoom', f, x, y]),
  };
  return { g: new TouchGestures(sink, () => mode, 10), ev };
}
const kinds = (ev: Ev[]) => ev.map((e) => e[0]);

// a still touch is a tap at the lift point
{
  const { g, ev } = rig();
  g.down(1, 100, 100); g.move(1, 104, 103); g.up(1, 104, 103);
  assert(kinds(ev).join() === 'tap', `tap expected, got ${kinds(ev)}`);
  assert(ev[0][1] === 104 && ev[0][2] === 103, 'tap at the lift point');
  assert(!g.active, 'no fingers left');
}

// past the slop it is a drag: pans by each move's delta (from the slop point on), never taps
{
  const { g, ev } = rig();
  g.down(1, 100, 100); g.move(1, 115, 100); g.move(1, 125, 110); g.up(1, 125, 110);
  assert(kinds(ev).join() === 'pan,pan', `pan,pan expected, got ${kinds(ev)}`);
  assert(ev[1][1] === 10 && ev[1][2] === 10, 'second pan carries the move delta');
}

// in 3D, one finger orbits
{
  const { g, ev } = rig('orbit');
  g.down(1, 0, 0); g.move(1, 30, 0); g.up(1, 30, 0);
  assert(kinds(ev).join() === 'orbit', `orbit expected, got ${kinds(ev)}`);
}

// two fingers: spreading them zooms in (factor < 1) about the midpoint, moving them pans
{
  const { g, ev } = rig();
  g.down(1, 100, 100); g.down(2, 200, 100);
  g.move(2, 300, 100); // distance 100 → 200, midpoint 150 → 200
  const z = ev.find((e) => e[0] === 'zoom')!;
  assert(z && Math.abs(z[1] - 0.5) < 1e-9, `zoom factor 0.5 expected, got ${z?.[1]}`);
  assert(z[2] === 200 && z[3] === 100, 'zoom about the new midpoint');
  const p = ev.find((e) => e[0] === 'pan')!;
  assert(p[1] === 50 && p[2] === 0, 'midpoint moved 50 px right');
  // lifting one finger, moving the other, lifting it: no pan jump, no tap
  const n = ev.length;
  g.up(1); g.move(2, 340, 120); g.up(2);
  assert(ev.length === n, `leftover finger after a pinch must do nothing, got ${kinds(ev.slice(n))}`);
}

// a quick two-finger touch without movement is not a tap
{
  const { g, ev } = rig();
  g.down(1, 10, 10); g.down(2, 50, 10); g.up(2); g.up(1);
  assert(!kinds(ev).includes('tap'), 'two-finger touch must not tap');
}

// a cancelled touch never taps, and the next touch starts clean
{
  const { g, ev } = rig();
  g.down(1, 10, 10); g.cancel(1);
  assert(ev.length === 0 && !g.active, 'cancel ends silently');
  g.down(1, 10, 10); g.up(1, 10, 10);
  assert(kinds(ev).join() === 'tap', 'fresh touch after a cancel taps');
}

// layout choice: touch-only devices get the mobile layout, anything with a mouse / trackpad does not
{
  const mq = (coarse: boolean, fine: boolean) => (q: string) => (q === '(pointer: coarse)' ? coarse : q === '(any-pointer: fine)' ? fine : false);
  assert(wantsMobileLayout('', mq(true, false)), 'phone → mobile');
  assert(!wantsMobileLayout('', mq(false, true)), 'desktop → desktop');
  assert(!wantsMobileLayout('', mq(true, true)), 'tablet with trackpad → desktop');
  assert(wantsMobileLayout('?mobile=1', mq(false, true)), '?mobile=1 forces mobile');
  assert(!wantsMobileLayout('?mobile=0', mq(true, false)), '?mobile=0 forces desktop');
}

// touch wording: every tutorial text reads for touch
{
  const mouse = /\bclick|Click|Shift\+|\bleft dock\b|press Tab|\((?:[0-9]|[PFHROB])\)/;
  const steps = [...TUTORIAL_STEPS, ...Object.values(TUTORIALS_BY_SCENARIO).flat()];
  let n = 0;
  for (const s of steps) {
    for (const txt of [s.title, s.concept, s.task, s.quickAction?.label ?? '']) {
      const t = touchCopy(txt);
      assert(!mouse.test(t), `mouse wording left in: "${t}"`);
      n++;
    }
  }
  const primer = touchCopy(BEGINNER_PRIMER_HTML);
  assert(!/<code>F<\/code> key/.test(primer), 'primer keeps no F-key hint');
  assert(/— \(1\) Visually/.test(primer), 'numbered list items keep their numbers');
  assert(touchCopy('Select (1)') === 'Select' && touchCopy('Rotate 180° (5)') === 'Rotate 180°', 'shortcut keys removed');
  assert(touchCopy('probe R1.1 (left-click) and R1.2 (right-click)') === 'probe R1.1 (Red probe) and R1.2 (Black probe)', 'probe wording');
  assert(touchCopy('then click Run tests') === 'then tap Run tests', 'click → tap');
  console.log(`touch: gestures, layout switch, ${n} tutorial texts in touch wording — ok`);
}

// phone text: every tutorial step has a short task in touch wording; toasts split at sentences
{
  const { splitLead, TOOL_TIP_PHONE, TOOL_SHORT } = await import('../src/ui/touch');
  const mouse = /\bclick|Click|Shift\+|left dock|press Tab|top bar|\d+(?:\.\d+)?, \d+(?:\.\d+)? mm/;
  const steps = [...TUTORIAL_STEPS, ...Object.values(TUTORIALS_BY_SCENARIO).flat()];
  for (const s of steps) {
    assert(s.phone, `tutorial step "${s.title}" has no phone task`);
    assert(s.phone.length <= 70, `phone task too long (${s.phone.length}): "${s.phone}"`);
    assert(s.phone.length < s.task.length, `phone task is not shorter: "${s.phone}"`);
    assert(!mouse.test(s.phone), `mouse wording or coordinates in phone task: "${s.phone}"`);
  }
  for (const id of Object.keys(TOOL_SHORT)) if (id !== 'inspect') assert(TOOL_TIP_PHONE[id] && TOOL_TIP_PHONE[id].length <= 80, `phone tip for ${id}`);
  const v = splitLead('Voltage injection: place the red probe on the shorted rail, then power on. The faulty part heats up.');
  assert(v.lead === 'Voltage injection: place the red probe on the shorted rail, then power on.' && v.rest === 'The faulty part heats up.', 'lead / rest split');
  assert(splitLead('Inject 3.3 V onto the rail and watch the part with the thermal camera. 3.3 V is enough for most rails here.').lead === 'Inject 3.3 V onto the rail and watch the part with the thermal camera.', 'no split inside a number');
  assert(splitLead('Done. Next one.').rest === '', 'no split after a short opener');
  assert(splitLead('Multimeter: Tap pads to probe. Tap a probe tag on the meter to switch red / black.').rest === '', 'short messages stay whole');
  console.log(`touch: ${steps.length} phone tasks ≤ 70 chars, tool tips, toast split — ok`);
}
