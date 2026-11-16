// Walkthrough scripts for the premade scenes. Each scene has two takes:
//   approach — how a technician attacks it: symptoms, measurements, where to look (no fix shown)
//   solution — the repair, ending with the test bench passing (the flag itself is blurred)
// Captions are short, in the DEADBOARD voice; ``**text**`` is highlighted.
import type { Take } from './director';

export interface Scene { id: string; approach: (t: Take) => Promise<void>; solution: (t: Take) => Promise<void> }

/** Final step of every solution: run the bench, show the result; refuses to claim a pass it did not see. */
const runTests = async (t: Take, step = 'Verify') => {
  await t.say('Run the test bench (Run tests).', {
    step, why: 'It powers the board, checks every objective, and only decrypts the flag if the circuit now matches the original design: a fix that merely works around a fault does not count.',
  });
  await t.clickEl('#btn-verify');
  await t.wait(800);
  await t.clickEl('[data-tab="mission"]');
  if (!(await t.page.locator('.flag-box').count())) throw new Error('solution take did not capture the flag');
  await t.highlightEl('.flag-box', 'flag captured (blurred)');
  await t.say('All objectives **pass** and the flag is captured. Earn your own: it is blurred here.', { step, hold: 3600 });
  await t.clear();
};

/** Reads the meter, checks it against `re` (fails the take otherwise) and points at the display. */
const meter = async (t: Take, re: RegExp, what: string) => {
  const v = await t.expect('.dmm-val', re, what);
  await t.highlightEl('.dmm-lcd', v);
  return v;
};
/** Same for the bench-supply current readout. */
const supplyAmps = async (t: Take, re: RegExp, what = 'supply current') => {
  const v = await t.expect('#psu-a', re, what);
  await t.highlightEl('#psu-a', v);
  return v;
};

export const SCENES: Scene[] = [
  {
    id: 'builtin-first-light',
    approach: async (t) => {
      await t.card('FIRST LIGHT · HOW TO APPROACH', 'A flashlight that will not light', [
        'The circuit: coin cell (3 V) → push button **SW1** → resistor **R1** → red LED **D1** → back to the cell.',
        'You will learn: why one break stops a series circuit, continuity testing in **Ω mode**, what **OL** means, and how to **half-split** a fault.',
        'Tools: Select (1) · Multimeter (2)',
      ]);
      await t.highlightPart('SW1', 'SW1');
      await t.clickPart('SW1');
      await t.say('Press SW1. D1 stays dark.', {
        step: 'Step 1 · Symptom', why: 'In a series loop the same current flows through every part. A single break anywhere, and nothing in the loop conducts.',
      });
      await t.clear();
      await t.highlightEl('#psu-a', 'no current');
      await t.say('The supply panel confirms it: **0.0 mA** while the button is pressed.', {
        step: 'Step 1 · Symptom', why: 'A dead LED alone would still let you measure… nothing either, but a short would draw a lot. Zero current points at an open circuit.',
      });
      await t.clear();
      await t.clickPart('SW1');
      await t.say('Turn the power **off** (P), take the multimeter (2), and switch it to **Ω**.', {
        step: 'Step 2 · Measure', why: 'An ohmmeter pushes its own small test current through the part. On a powered circuit the board\'s voltages corrupt the reading, and can damage the meter.',
      });
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.highlightPad('R1', '2', 'red probe');
      await t.clickPad('R1', '2');
      await t.clear();
      await t.highlightPad('D1', '2', 'black probe');
      await t.clickPad('D1', '2', { button: 'right' });
      await t.clear();
      await t.highlightEl('.dmm-lcd', 'OL');
      await t.say('R1\'s right pad to D1\'s anode: the meter reads **OL**.', {
        step: 'Step 3 · Interpret', why: 'OL = "over limit": the test current found no path. These two pads are joined by one copper trace on paper, where you would expect about 0 Ω, so that copper is broken.',
      });
      await t.clear();
      await t.say('Now **half-split**: move the red probe to the middle of the trace and measure again.', {
        step: 'Step 4 · Narrow it down', why: 'Each measurement halves the stretch that can contain the break. On a long trace, three or four readings find it.',
      });
      await t.highlightBoard(62, 24, 1.5, 'probe here');
      await t.clickBoard(62, 24, 'F');
      await t.clear();
      await t.highlightEl('.dmm-lcd', 'still OL');
      await t.say('Still **OL**: the break lies between this point and D1.', { step: 'Step 4 · Narrow it down' });
      await t.clear();
      await t.highlightBoard(62, 14, 1.5, 'probe here');
      await t.clickBoard(62, 14, 'F');
      await t.clear();
      await t.highlightEl('.dmm-lcd', '≈ 0 Ω');
      await t.say('Near **0 Ω** here: this point is still connected to D1.', {
        step: 'Step 4 · Narrow it down', why: 'So the break sits between the two probe points. Zoom into that stretch and look closely: the solution video shows the repair.',
      });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Find an open circuit', [
        'A series circuit with **no current** and no heat usually has an **open**: a cracked trace, a cold joint, a missing part.',
        'Measure resistance with the **power off**. **OL** on a path that should be copper means it is broken.',
        '**Half-split**: probe the middle of the suspect stretch; the reading tells you which half to keep.',
      ]);
    },
    solution: async (t) => {
      await t.card('FIRST LIGHT · SOLUTION', 'Bridging a broken trace', [
        'Diagnosis (see "How to approach"): R1 → D1 reads **OL**, and half-splitting puts the break on the right-hand trace.',
        'Fix: bridge the gap with solder, check the LED, then verify on the test bench.',
        'Tools: Soldering iron (3) · Select (1) · Run tests',
      ]);
      await t.focus(62, 19, 6, 'F');
      await t.highlightBoard(62, 19, 1.2, 'the gap', true);
      await t.say('Here it is: a hairline gap in the copper.', {
        step: 'Step 1 · Locate', why: 'Flexing, a scratch or corrosion can crack a trace. The gap is tiny, but no current crosses it.',
      });
      await t.clear();
      await t.key('3');
      await t.clickBoard(62, 19, 'F');
      await t.say('Soldering iron (3): click the gap to flow a **solder bridge** across it.', {
        step: 'Step 2 · Repair', why: 'Solder conducts. A blob that wets the copper on both sides restores the path. For wider gaps on a real board you would add a short piece of wire.',
      });
      await t.fit();
      await t.key('1');
      await t.clickPart('SW1');
      await t.highlightEl('#psu-a', '≈ 10 mA');
      await t.say('Press SW1: **D1 lights**, and the supply now shows about **10 mA**.', {
        step: 'Step 3 · Check', why: 'Ohm\'s law: the cell gives 3 V, the red LED drops about 1.9 V, so about 1.1 V is left across R1 (100 Ω): 1.1 V / 100 Ω ≈ 11 mA.',
      });
      await t.clear();
      await t.clickPart('SW1');
      await runTests(t, 'Step 4 · Verify');
      await t.card('WHAT YOU LEARNED', 'Repair and prove it', [
        'A broken trace is bridged with **solder** (small gaps) or a **jumper wire** (long ones).',
        'Check the repair with a number you can predict: here **I = V / R** gives the LED current.',
        'Finish on the **test bench**: it proves the circuit, not just the symptom.',
      ]);
    },
  },
  {
    id: 'builtin-bridge-troll',
    approach: async (t) => {
      await t.card('BRIDGE TROLL · HOW TO APPROACH', 'Two LEDs, one button, both dark', [
        'The circuit: coin cell (3 V) → **SW1** → a bus feeding two branches: **R1 → D1** (red) and **R2 → D2** (green), both back to ground.',
        'You will learn: what supply current tells you, reading **solder joints**, and the **diode test** on an LED.',
        'Tools: Select (1) · Multimeter (2) · Flip (F)',
      ]);
      await t.highlightPart('SW1', 'SW1');
      await t.clickPart('SW1');
      await t.clear();
      const a = await supplyAmps(t, /^[1-9]\d*\.\d mA$/);
      await t.say(`SW1 pressed: neither LED lights, yet the supply delivers **${a}**.`, {
        step: 'Step 1 · Symptom', why: 'Current is flowing, but no LED glows. An LED that conducts lights up, so the current must be taking a path around the LEDs: a short.',
      });
      await t.clear();
      await t.clickPart('SW1');
      await t.say('Hand-soldered, through-hole: every joint was made on the **bottom**. Flip the board (F).', {
        step: 'Step 2 · Inspect', why: 'Leads go through the board and are soldered underneath. Rushed hand soldering leaves bridges between pins and dull, grainy cold joints there.',
      });
      await t.flipTo('B');
      await t.focusPart('D2', 7);
      await t.highlightBoard(40, 14, 2.2, 'D2 legs', true);
      await t.say('Look between **D2**\'s two legs: something joins them.', {
        step: 'Step 2 · Inspect', why: 'Good joints are shiny cones, one per lead, with clean board between them. Any solder spanning two pads is a bridge.',
      });
      await t.clear();
      await t.say('Confirm with the meter: power **off** (P), Multimeter (2), **Diode** mode, red on the anode, black on the cathode.', {
        step: 'Step 3 · Measure', why: 'The diode test pushes about 1 mA through the part and shows the voltage it needs. A healthy green LED reads roughly 1.8–2.3 V.',
      });
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-diode');
      await t.clickPad('D2', '2');
      await t.clickPad('D2', '1', { button: 'right' });
      const d = await meter(t, /^0\.\d+ V$/, 'diode test across bridged D2');
      await t.say(`D2 reads **${d}**: far below an LED's forward voltage.`, {
        step: 'Step 3 · Interpret', why: 'Near 0 V means the test current found a path with no junction in it: the bridge shorts D2 out. That is also where the supply current went: through R2 straight to ground.',
      });
      await t.clear();
      await t.focusPart('R1', 7);
      await t.highlightPad('R1', '1', 'this joint', true);
      await t.say('Now D1\'s branch. No bridge here, but compare **R1**\'s two joints.', {
        step: 'Step 4 · Second fault', why: 'One is dull and grainy: a cold joint. The solder never got hot enough to wet both pad and lead, so the branch is open even though the part looks attached.',
      });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Read the board, then the meter', [
        '**Current but no light** points to a short; **no current at all** points to an open.',
        'On through-hole boards, inspect the **bottom**: look for bridges between pins and **dull, grainy** cold joints.',
        'Diode test: an LED reads about **1.8–3 V**; **~0 V** means it is shorted out.',
      ]);
    },
    solution: async (t) => {
      await t.card('BRIDGE TROLL · SOLUTION', 'Two soldering faults, two fixes', [
        'Diagnosis (see "How to approach"): a **solder bridge** shorts D2, and a **cold joint** on R1 opens D1\'s branch.',
        'Fix: wick the bridge, reflow the cold joint, check both LEDs, then verify on the test bench.',
        'Tools: Desolder wick (4) · Soldering iron (3) · Multimeter (2) · Select (1)',
      ]);
      await t.flipTo('B');
      await t.focusPart('D2', 6);
      await t.highlightBoard(40, 14, 1.6, 'solder bridge', true);
      await t.say('Desolder wick (4): click the bridge between D2\'s legs.', {
        step: 'Step 1 · Remove the bridge', why: 'Wick is braided copper soaked in flux. Heated on the blob, it pulls molten solder into the braid by capillary action and leaves the two pads separate.',
      });
      await t.clear();
      await t.key('4');
      await t.clickBoard(40, 14, 'B');
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-diode');
      await t.clickPad('D2', '2');
      await t.clickPad('D2', '1', { button: 'right' });
      const d = await meter(t, /^[1-3]\.\d+ V$/, 'diode test across D2 after wick');
      await t.say(`Power off, diode test again: D2 now reads **${d}**, a healthy LED.`, { step: 'Step 1 · Check' });
      await t.clear();
      await t.focusPart('R1', 6);
      await t.highlightPad('R1', '1', 'cold joint', true);
      await t.say('Soldering iron (3): click R1\'s cold joint to **reflow** it.', {
        step: 'Step 2 · Reflow', why: 'Reheating with fresh flux lets the solder melt fully and wet both pad and lead. A good joint ends up shiny with a concave fillet.',
      });
      await t.clear();
      await t.key('3');
      await t.clickPad('R1', '1');
      await t.flipTo('F');
      await t.fit();
      await t.key('1');
      await t.key('p');
      await t.clickPart('SW1');
      const a = await supplyAmps(t, /^1[3-8]\.\d mA$/);
      await t.say(`Power on, press SW1: **both LEDs** light and the supply shows **${a}**.`, {
        step: 'Step 3 · Check', why: 'Each branch carries (3 V − LED voltage) / 100 Ω. Both LEDs drop about 2 V, and the coin cell\'s own ~8 Ω internal resistance costs a little more: about 8 mA each, ~16 mA together.',
      });
      await t.clear();
      await t.clickPart('SW1');
      await runTests(t, 'Step 4 · Verify');
      await t.card('WHAT YOU LEARNED', 'Rework, then re-measure', [
        '**Wick** removes excess solder; the **iron** with flux reflows a cold joint.',
        'Re-test the part you fixed: the same diode test that found the short proves it is gone.',
        'Predict the current with **I = (V − V_LED) / R** and compare it with the supply.',
      ]);
    },
  },
  {
    id: 'builtin-backwards-day',
    approach: async (t) => {
      await t.card('BACKWARDS DAY · HOW TO APPROACH', 'Wrong parts, wrong way round', [
        'The circuit: USB 5 V on **J1** feeds **R1 (330 Ω) → D1** (yellow) and **R2 (150 Ω) → D2** (blue). D2\'s anode trace runs on the **bottom** layer.',
        'You will learn: checking parts against the design, resistance **in-circuit**, LED **polarity** with the diode test, following a trace across layers.',
        'Tools: Select (1) · Multimeter (2) · Flip (F)',
      ]);
      const a = await supplyAmps(t, /^0\.0 mA$/);
      await t.say(`5 V applied, both LEDs dark, and the supply reads **${a}**.`, {
        step: 'Step 1 · Symptom', why: 'No current at all: every path is open or blocked. Two dark branches on a carelessly built board usually means a separate fault in each, so check every part.',
      });
      await t.clear();
      await t.highlightPart('R1', 'R1');
      await t.clickPart('R1');
      await t.say('Select **R1** and read its colour bands in the Inspector: yellow-violet-orange is **47 kΩ**. The design calls for **330 Ω**.', {
        step: 'Step 2 · Check the parts', why: 'With 47 kΩ, D1 could get at most (5 − 2) V / 47 kΩ ≈ 0.06 mA: far too little to see. A part from the wrong reel is a classic assembly fault.',
      });
      await t.clear();
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.clickPad('R1', '1');
      await t.clickPad('R1', '2', { button: 'right' });
      const r = await meter(t, /^4[67](\.\d+)? ?kΩ$/, 'R1 in circuit');
      await t.say(`Power off, Ω across R1: **${r}**. The bands were right.`, {
        step: 'Step 2 · Measure', why: 'In-circuit readings can be pulled low by parallel paths. Nothing else parallels R1 here, so the meter sees the part itself.',
      });
      await t.clear();
      await t.focusPart('D1', 6);
      await t.clickEl('#dmm-diode');
      await t.highlightPad('D1', '2', 'silkscreen anode');
      await t.clickPad('D1', '2');
      await t.clear();
      await t.clickPad('D1', '1', { button: 'right' });
      const fwd = await meter(t, /^OL$/, 'D1 forward per silkscreen');
      await t.say(`Diode test on D1, red on the **silkscreen anode**, black on the cathode: **${fwd}**.`, {
        step: 'Step 3 · Polarity', why: 'An LED only conducts from anode to cathode; a good one reads about 2 V this way. OL means it is open… or fitted backwards. Swap the probes to tell which.',
      });
      await t.clear();
      await t.clickPad('D1', '1');
      await t.clickPad('D1', '2', { button: 'right' });
      const rev = await meter(t, /^[1-3]\.\d+ V$/, 'D1 probes swapped');
      await t.say(`Probes swapped: **${rev}**. The LED works, it is fitted **backwards**.`, {
        step: 'Step 3 · Polarity', why: 'Compare the flat edge of the LED body (cathode) with the silkscreen outline: they point opposite ways.',
      });
      await t.clear();
      await t.fit();
      await t.clickEl('#dmm-ohm');
      await t.clickPad('R2', '2');
      await t.clickPad('D2', '2', { button: 'right' });
      const o = await meter(t, /^OL$/, 'R2 to D2 anode');
      await t.say(`D2\'s anode should connect straight to R2. Ω between them: **${o}**.`, {
        step: 'Step 4 · Third fault', why: 'There is no trace for it on the top: the connection runs on the bottom layer. Flip the board and follow it from pad to pad.',
      });
      await t.clear();
      await t.flipTo('B');
      await t.highlightBoard(32, 24, 5, 'follow this trace');
      await t.say('On the bottom, R2 → D2 is this one trace. Zoom in along it: the solution video shows the break.', { step: 'Step 4 · Locate' });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Check every part against the design', [
        'Read **colour bands** or measure with the power off: a wrong value is as bad as a missing part.',
        'Diode test **both ways**: OL one way and ~2 V the other = good LED, **reversed**. OL both ways = open.',
        'A trace with no copper on top lives on the **bottom**: flip the board and follow it.',
      ]);
    },
    solution: async (t) => {
      await t.card('BACKWARDS DAY · SOLUTION', 'Three faults, three fixes', [
        'Diagnosis (see "How to approach"): R1 is **47 kΩ** instead of 330 Ω, D1 is **reversed**, and D2\'s anode trace is **cut** on the bottom.',
        'Fix each one, check the current, then verify on the test bench.',
        'Tools: Select (1) · Rotate (5) · Soldering iron (3)',
      ]);
      await t.highlightPart('R1', 'R1');
      await t.clickPart('R1');
      await t.clear();
      await t.fill('#inp-res-val', '330');
      await t.clickEl('#act-install-res');
      await t.say('Select R1, enter **330** in the Inspector and fit the right resistor.', {
        step: 'Step 1 · Replace R1', why: '330 Ω sets D1\'s current to about (5 − 2) V / 330 Ω ≈ 9 mA: bright, and well within a small LED\'s 20 mA rating.',
      });
      await t.key('5');
      await t.highlightPart('D1', 'D1');
      await t.clickPart('D1');
      await t.clear();
      await t.say('Rotate tool (5): click D1 to refit it turned 180°.', {
        step: 'Step 2 · Turn D1 around', why: 'Its flat edge (cathode) now matches the silkscreen, so the anode sits on R1 and the cathode on ground.',
      });
      await t.flipTo('B');
      await t.focus(34, 24, 6, 'B');
      await t.highlightBoard(34, 24, 1.4, 'cut', true);
      await t.say('On the bottom: a cut across D2\'s anode trace. Soldering iron (3): bridge it with solder.', {
        step: 'Step 3 · Bridge the trace', why: 'Solder wets the exposed copper on both sides and closes the gap. For a longer break you would lay a short wire along the trace.',
      });
      await t.clear();
      await t.key('3');
      await t.clickBoard(34, 24, 'B');
      await t.flipTo('F');
      await t.fit();
      await t.key('1');
      const a = await supplyAmps(t, /^(1[5-9]|2\d|3\d)\.\d mA$/);
      await t.say(`**Both LEDs** light; the supply shows **${a}**.`, {
        step: 'Step 4 · Check', why: 'Yellow: (5 − ~2.0) V / 330 Ω ≈ 9 mA. Blue drops more, about 3 V: (5 − 3) V / 150 Ω ≈ 13 mA. About 21 mA together.',
      });
      await t.clear();
      await runTests(t, 'Step 5 · Verify');
      await t.card('WHAT YOU LEARNED', 'Assembly faults stack up', [
        'Several faults can hide behind one symptom: keep checking after the first find.',
        'Fix **value**, **orientation** and **connection** faults, then predict the current and compare.',
      ]);
    },
  },
  {
    id: 'builtin-ghost-short',
    approach: async (t) => {
      await t.card('GHOST SHORT · HOW TO APPROACH', 'Blown fuse: find the cause first', [
        'The circuit: 5 V on **J1** → fuse **F1** (0.5 A) → power LED **D1** (via R3) and a divider **R1/R2** that must put **2.5 V** on TP1.',
        'It came back with F1 **blown** and R2 **missing**.',
        'You will learn: why a blown fuse is a symptom, checking for a **short** before powering up, and finding a short that is not a part.',
      ]);
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.clickPad('F1', '1');
      await t.clickPad('F1', '2', { button: 'right' });
      const f = await meter(t, /^OL$/, 'across F1');
      await t.say(`Power off, Ω across the fuse: **${f}**. F1 is open.`, {
        step: 'Step 1 · The fuse', why: 'A fuse is a deliberate weak link that melts above its rating, here 0.5 A. Something drew that much current, and a new fuse fitted blindly would blow again.',
      });
      await t.clear();
      await t.clickPad('J1', '1');
      await t.clickPad('TP2', '1', { button: 'right' });
      const r = await meter(t, /^\d\.\d Ω$/, 'J1+ to GND');
      await t.say(`J1\'s + pin to ground (TP2): **${r}**. The 5 V input is **shorted** to ground.`, {
        step: 'Step 2 · Look for a short', why: 'A healthy input reads high here: the loads draw only milliamps. Under 10 Ω, a 5 V supply would push amps: that is what blew the fuse.',
      });
      await t.clear();
      await t.highlightPart('F1', 'open', 3.5);
      await t.say('F1 is open, so nothing **behind** it is in this reading. The short sits between J1 and the fuse.', {
        step: 'Step 3 · Narrow it down', why: 'The blown fuse splits the board for you: every part downstream is disconnected. Only J1 and its two traces remain.',
      });
      await t.clear();
      await t.focusPart('J1', 6);
      await t.highlightBoard(9, 22, 2.4, 'look here');
      await t.say('No part here can short. Zoom in between J1\'s pins and look at the **copper** itself.', {
        step: 'Step 3 · Narrow it down', why: 'Shorts are not always parts: a sliver of copper left over from etching, a whisker of solder or a stray wire strand can join two nets.',
      });
      await t.clear();
      await t.fit();
      await t.highlightPart('R2', 'empty', 3.5);
      await t.say('One more: R2\'s footprint is **empty**. The divider gives V = 5 V × R2 / (R1 + R2), and R1 is 10 kΩ.', {
        step: 'Step 4 · Missing part', why: 'Without R2, TP1 would sit at the full 5 V. Work out which R2 gives 2.5 V.',
      });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Never just replace the fuse', [
        'A blown fuse is a **symptom**: measure Ω across the input to ground **before** fitting a new one.',
        'An open fuse **isolates** the circuit behind it: use it to narrow down where the short can be.',
        'When no part can explain a short, inspect the **copper**: slivers, whiskers, bridges.',
      ]);
    },
    solution: async (t) => {
      await t.card('GHOST SHORT · SOLUTION', 'Cut the sliver, then fit the fuse', [
        'Diagnosis (see "How to approach"): a hairline **copper sliver** shorts +5 V to ground at J1, F1 is blown, R2 is missing.',
        'Order matters: remove the short, prove it is gone, **then** fit a new fuse.',
        'Tools: Trace cutter (7) · Multimeter (2) · Soldering iron (3) · Select (1)',
      ]);
      await t.focus(8.5, 22, 4, 'F');
      await t.highlightBoard(8.5, 22, 1.6, 'copper sliver', true);
      await t.say('A hairline of copper runs from the +5 V trace to the ground trace.', { step: 'Step 1 · Locate' });
      await t.clear();
      await t.key('7');
      await t.clickBoard(8.5, 22, 'F');
      await t.say('Trace cutter (7): cut through the sliver.', {
        step: 'Step 2 · Remove the short', why: 'On a real board you would scrape it away with a scalpel and check under magnification that no copper bridges the gap.',
      });
      await t.fit();
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.clickPad('J1', '1');
      await t.clickPad('TP2', '1', { button: 'right' });
      const r = await meter(t, /^(OL|\d+\.\d+ [kM]Ω)$/, 'J1+ to GND after cut');
      await t.say(`Power off, J1 + to ground again: **${r}**. The short is gone.`, {
        step: 'Step 3 · Prove it', why: 'Never power up on hope. With the short proven gone, a new fuse will survive.',
      });
      await t.clear();
      await t.key('3');
      await t.clickPart('F1');
      await t.say('Soldering iron (3) on F1: fit a fresh **0.5 A** fuse.', { step: 'Step 4 · New fuse' });
      await t.key('1');
      await t.clickPart('R2');
      await t.fill('#inp-res-val', '10k');
      await t.clickEl('#act-install-res');
      await t.say('Select R2\'s empty footprint and fit **10 kΩ**.', {
        step: 'Step 5 · Fit R2', why: 'Equal resistors split the voltage in half: 5 V × 10k / (10k + 10k) = 2.5 V.',
      });
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-v');
      await t.clickPad('TP1', '1');
      const v = await meter(t, /^2\.[3-7]\d* V$/, 'TP1');
      await t.say(`Power on: TP1 reads **${v}**, and the power LED D1 is lit.`, { step: 'Step 6 · Check' });
      await t.clear();
      await runTests(t, 'Step 7 · Verify');
      await t.card('WHAT YOU LEARNED', 'Order of a safe repair', [
        '**Find** the short → **remove** it → **prove** it is gone with Ω → only then replace the fuse.',
        'A divider of two equal resistors gives exactly **half** the input.',
      ]);
    },
  },
  {
    id: 'builtin-smoke-test',
    approach: async (t) => {
      await t.card('SMOKE TEST · HOW TO APPROACH', 'The fuse is the victim', [
        'The circuit: 5 V on **J1** → fuse **F1** → series protection diode **D1** (1N4007) → rail **TP1** → R1 → green LED **D2**.',
        'F1 is blown and the rail is dead.',
        'You will learn: testing a rail for a short, the **diode test** on a silicon diode, and checking polarity against the silkscreen.',
      ]);
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.highlightPart('TP1', 'rail');
      await t.clickPad('TP1', '1');
      await t.clear();
      await t.clickPad('TP2', '1', { button: 'right' });
      const r = await meter(t, /^\d\.\d Ω$/, 'TP1 to TP2');
      await t.say(`Power off, Ω from the rail (TP1) to ground (TP2): **${r}**.`, {
        step: 'Step 1 · Short check', why: 'This rail feeds R1 (220 Ω) and an LED, so it should read hundreds of ohms or open. A few ohms is a short: a new fuse would blow at once.',
      });
      await t.clear();
      await t.focusPart('D1', 7);
      await t.clickEl('#dmm-diode');
      await t.highlightPad('D1', '2', 'silkscreen anode');
      await t.clickPad('D1', '2');
      await t.clear();
      await t.clickPad('D1', '1', { button: 'right' });
      const fwd = await meter(t, /^OL$/, 'D1 forward per silkscreen');
      await t.say(`Diode test on D1, red on the anode, black on the **band** end per the silkscreen: **${fwd}**.`, {
        step: 'Step 2 · The diode', why: 'A good silicon diode reads about 0.5–0.7 V from anode to cathode. OL means open or reversed: swap the probes.',
      });
      await t.clear();
      await t.clickPad('D1', '1');
      await t.clickPad('D1', '2', { button: 'right' });
      const rev = await meter(t, /^0\.[4-8]\d* V$/, 'D1 probes swapped');
      await t.say(`Swapped: **${rev}**. D1 is fine, but fitted **backwards**: its band does not match the silkscreen.`, {
        step: 'Step 2 · The diode', why: 'Reversed, the series diode blocks the supply. Even with a new fuse and no short, the rail would stay dead.',
      });
      await t.clear();
      await t.fit();
      await t.flipTo('B');
      await t.highlightBoard(45, 19, 4, 'rail next to ground');
      await t.say('Now the short. The rail also runs on the **bottom**, right next to a ground trace. Inspect that area closely.', {
        step: 'Step 3 · Find the short', why: 'Shorts hide where two nets run close together: look for solder or debris spanning the gap.',
      });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Protect the next fuse', [
        'A blown fuse is a **symptom**: check the rail for a short before replacing it.',
        'Diode test: **~0.6 V** one way and **OL** the other = good. OL both ways = open; ~0 both ways = shorted.',
        'On a real bench: set the supply **current limit** (e.g. 100 mA) and use a **thermal camera** to see where a short heats up.',
      ]);
    },
    solution: async (t) => {
      await t.card('SMOKE TEST · SOLUTION', 'Short, diode, then fuse', [
        'Diagnosis (see "How to approach"): a **solder blob** on the bottom shorts the rail to ground, D1 is **reversed**, F1 is blown.',
        'Fix the cause, prove it, and fit the fuse last.',
        'Tools: Desolder wick (4) · Multimeter (2) · Rotate (5) · Soldering iron (3)',
      ]);
      await t.flipTo('B');
      await t.focus(45, 19, 5, 'B');
      await t.highlightBoard(45, 19.1, 1.8, 'solder blob', true);
      await t.say('A blob of solder bridges the rail via and the ground trace.', { step: 'Step 1 · Locate' });
      await t.clear();
      await t.key('4');
      await t.clickBoard(45, 19.1, 'B');
      await t.say('Desolder wick (4): soak up the blob.', { step: 'Step 2 · Remove the short' });
      await t.flipTo('F');
      await t.fit();
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.clickPad('TP1', '1');
      await t.clickPad('TP2', '1', { button: 'right' });
      const r = await meter(t, /^(OL|\d+\.\d+ [kM]Ω|\d{3}\.\d Ω)$/, 'TP1 to TP2 after wick');
      await t.say(`Power off, rail to ground: **${r}**. No more short.`, {
        step: 'Step 3 · Prove it', why: 'What is left is R1 and the LED, which only conduct once the LED\'s forward voltage is reached: a meter sees a high resistance.',
      });
      await t.clear();
      await t.key('5');
      await t.clickPart('D1');
      await t.say('Rotate tool (5): turn D1 so its band matches the silkscreen.', { step: 'Step 4 · Fix polarity' });
      await t.key('3');
      await t.clickPart('F1');
      await t.say('Only now, soldering iron (3) on F1: a fresh **0.5 A** fuse.', { step: 'Step 5 · New fuse' });
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-v');
      await t.clickPad('TP1', '1');
      const v = await meter(t, /^4\.[0-5]\d* V$/, 'TP1 powered');
      await t.say(`Power on: TP1 reads **${v}**, and D2 lights.`, {
        step: 'Step 6 · Check', why: 'Not 5 V: the series diode drops about 0.6–0.7 V. That drop is the price of reverse-polarity protection.',
      });
      await t.clear();
      await runTests(t, 'Step 7 · Verify');
      await t.card('WHAT YOU LEARNED', 'Cause first, fuse last', [
        'Remove the short, **prove** it with Ω, fix the polarity, and only then replace the fuse.',
        'A rail behind a series diode sits about **0.7 V** below the input.',
      ]);
    },
  },
  {
    id: 'builtin-sagging-rail',
    approach: async (t) => {
      await t.card('THE SAGGING RAIL · HOW TO APPROACH', 'A divider that sags', [
        'The circuit: 5 V USB on **J1**. **R1/R2** divide it to **2.50 V** at TP1; **R3 → D1** (blue) is a power light whose ground return runs on the **bottom** layer.',
        'Symptoms: TP1 reads far too low and D1 stays dark.',
        'You will learn: the **voltage divider**, reading **colour bands**, and tracing a return path across layers.',
      ]);
      await t.key('2');
      await t.clickEl('#dmm-v');
      await t.clickPad('J1', '1');
      const vin = await meter(t, /^4\.9\d* V$|^5\.0\d* V$/, 'J1 input');
      await t.say(`Start at the input: J1 + reads **${vin}**. The supply is fine.`, {
        step: 'Step 1 · Measure', why: 'Always check the source first. If the input were low, everything after it would be too.',
      });
      await t.clear();
      await t.clickPad('TP1', '1');
      const v = await meter(t, /^0\.[3-6]\d* V$/, 'TP1');
      await t.say(`TP1 reads **${v}** instead of 2.50 V.`, {
        step: 'Step 1 · Measure', why: 'A divider gives Vout = Vin × R2 / (R1 + R2). Equal resistors give exactly half. Far too low means R2 is too small for R1, or R1 too large.',
      });
      await t.clear();
      await t.key('1');
      await t.highlightPart('R1', 'R1');
      await t.clickPart('R1');
      await t.clear();
      await t.say('Select R1: brown-black-**orange**, 10 × 1 000 = **10 kΩ**.', {
        step: 'Step 2 · Read the bands', why: 'First two bands are digits, the third is the multiplier: black ×1, brown ×10, red ×100, orange ×1 000.',
      });
      await t.highlightPart('R2', 'R2');
      await t.clickPart('R2');
      await t.clear();
      await t.say('R2: brown-black-**red**, 10 × 100 = **1 kΩ**.', {
        step: 'Step 2 · Read the bands', why: `5 V × 1k / (10k + 1k) = 0.45 V: that is the ${v} you measured. For 2.50 V, R2 must equal R1: 10 kΩ.`,
      });
      await t.key('p');
      await t.key('2');
      await t.clickEl('#dmm-ohm');
      await t.clickPad('D1', '1');
      await t.clickPad('TP2', '1', { button: 'right' });
      const o = await meter(t, /^OL$/, 'D1 cathode to GND');
      await t.say(`D1 stays dark even though it has its own resistor. Power off, Ω from D1\'s cathode to ground: **${o}**.`, {
        step: 'Step 3 · The LED', why: 'An LED\'s cathode must reach ground to complete its loop. OL means its return path is broken.',
      });
      await t.clear();
      await t.flipTo('B');
      await t.highlightBoard(49, 8, 6, 'D1 return');
      await t.say('The cathode drops through a via to the **bottom** layer and runs to TP2. Inspect this trace.', {
        step: 'Step 3 · Follow the return', why: 'A via carries a net from one copper layer to the other. A trace you cannot see from the top can still be the broken link.',
      });
      await t.clear();
      await t.card('WHAT YOU LEARNED', 'Do the maths, then trace it', [
        'Divider: **Vout = Vin × R2 / (R1 + R2)**. A wrong reading tells you which resistor to suspect.',
        'Colour bands: digit, digit, **multiplier** (×100 red, ×1 000 orange).',
        'Every loop needs a return: follow it through **vias** onto the other layer.',
      ]);
    },
    solution: async (t) => {
      await t.card('THE SAGGING RAIL · SOLUTION', 'Right resistor, whole return path', [
        'Diagnosis (see "How to approach"): R2 is **1 kΩ** instead of 10 kΩ, and D1\'s ground return is **cut** on the bottom layer.',
        'Tools: Select (1) · Soldering iron (3) · Multimeter (2)',
      ]);
      await t.highlightPart('R2', 'R2');
      await t.clickPart('R2');
      await t.clear();
      await t.fill('#inp-res-val', '10k');
      await t.clickEl('#act-install-res');
      await t.say('Select R2 and fit **10 kΩ**.', { step: 'Step 1 · Replace R2' });
      await t.key('2');
      await t.clickEl('#dmm-v');
      await t.clickPad('TP1', '1');
      const v = await meter(t, /^2\.[4-6]\d* V$/, 'TP1 after R2');
      await t.say(`TP1 now reads **${v}**.`, { step: 'Step 1 · Check', why: '5 V × 10k / (10k + 10k) = 2.50 V.' });
      await t.clear();
      await t.flipTo('B');
      await t.focus(49, 8, 5, 'B');
      await t.highlightBoard(49, 8, 1.4, 'cut', true);
      await t.say('On the bottom: the return trace is cut. Soldering iron (3): bridge it.', { step: 'Step 2 · Bridge the return' });
      await t.clear();
      await t.key('3');
      await t.clickBoard(49, 8, 'B');
      await t.flipTo('F');
      await t.fit();
      await t.key('1');
      await t.say('D1 lights: its loop to ground is closed again.', {
        step: 'Step 3 · Check', why: 'Current: (5 − ~3 V for blue) / 330 Ω ≈ 6 mA.',
      });
      await runTests(t, 'Step 4 · Verify');
      await t.card('WHAT YOU LEARNED', 'Two layers, one loop', [
        'Swap a wrong resistor and confirm with the divider maths.',
        'Bridge a broken trace on whichever layer it lives on.',
      ]);
    },
  },
  {
    id: 'demo-mnt-reform2-mb30',
    approach: async (t) => {
      await t.card('MNT REFORM 2 · HOW TO APPROACH', 'A real laptop mainboard that will not start', [
        'An open-hardware laptop board: **529 parts**, a 30 V input stage, and converters making **+5V**, **+3V3** and **+1V2**.',
        'Symptom: it draws power but the system never starts.',
        'You will learn: reading a power sequence, measuring rails at **capacitors**, and finding a shorted rail with the **thermal camera**.',
      ]);
      await t.highlightEl('#psu-box', 'bench supply');
      await t.say('Watch the bench supply while the board powers up: it steps through power states.', {
        step: 'Step 1 · Power-up', why: 'A mainboard turns its rails on in order. If a rail fails, the controller stops or retries, and the supply current shows it.',
      });
      await t.clear();
      await t.wait(3000);
      await t.key('2');
      await t.focusPart('C35', 5);
      await t.highlightPart('C35', 'C35 on +5V', 2);
      await t.clickPad('C35', '1');
      await t.clear();
      const v5 = await meter(t, /^4\.\d+ V$|^5\.\d+ V$/, '+5V at C35');
      await t.say(`Measure each rail at a decoupling capacitor. **+5V** at C35: **${v5}**. Fine.`, {
        step: 'Step 2 · Measure the rails', why: 'Every rail has capacitors right next to the parts it feeds. Their pads are the easiest place to probe a rail.',
      });
      await t.clear();
      await t.focusPart('C29', 5);
      await t.highlightPart('C29', 'C29 on +3V3', 2);
      await t.clickPad('C29', '1');
      await t.clear();
      const v33 = await meter(t, /^0\.\d+ V$|^1\.\d+ V$/, '+3V3 at C29');
      await t.say(`**+3V3** at C29: **${v33}**, far below 3.3 V.`, {
        step: 'Step 2 · Measure the rails', why: 'A converter that is running but cannot hold its voltage is being dragged down: something on the rail draws more current than it can deliver.',
      });
      await t.clear();
      await t.say('A rail pulled low by a short turns that current into **heat** at the shorted part.', {
        step: 'Step 3 · Find the short', why: 'Power = I² × R. The fault carries amps, so it warms up faster than anything else on the rail.',
      });
      await t.fit();
      await t.page.selectOption('#viz-select', 'thermal');
      await t.say('Switch the view to **Thermal** and give it a few seconds: look for the spot that heats first.', { step: 'Step 3 · Find the short', hold: 6500 });
      await t.card('WHAT YOU LEARNED', 'Rails first, then heat', [
        'Measure every rail at its capacitors: a **low** rail with a running converter means **overload**.',
        'A short is a heater: use the **thermal** view, freeze spray, IPA or rosin (R) to see which part warms first.',
        'Many parts share one rail: the heat points to the one that matters.',
      ]);
    },
    solution: async (t) => {
      await t.card('MNT REFORM 2 · SOLUTION', 'Replace the shorted capacitor, clean the board', [
        'Diagnosis: **C173**, a 22 µF capacitor on +3V3, is a dead short. Liquid residue near **C97** leaks current too.',
        'Tools: Desolder wick (4) · Select (1) · IPA (0)',
      ]);
      await t.wait(3000);
      await t.focusPart('C173', 4);
      await t.highlightPart('C173', 'C173', 1.5, true);
      await t.say('C173 is the hot spot. Ceramic capacitors fail short when they crack.', {
        step: 'Step 1 · Remove', why: 'Board flex or thermal shock cracks the ceramic; the layers inside touch and the cap becomes a near-0 Ω path across the rail.',
      });
      await t.clear();
      await t.key('4');
      await t.clickPart('C173');
      await t.say('Wick (4) removes the shorted cap.', { step: 'Step 1 · Remove' });
      await t.key('1');
      await t.clickPart('C173');
      await t.fill('#inp-cap-val', '22u');
      await t.clickEl('#act-install-cap');
      await t.say('Select the empty footprint and fit a fresh **22 µF** from the Inspector.', {
        step: 'Step 2 · Replace', why: 'Match the value and the voltage rating. Decoupling caps keep the rail stable; leaving one out can make the converter ring.',
      });
      await t.focusPart('C97', 4);
      await t.highlightPart('C97', 'residue', 2, true);
      await t.say('Next to C97: dried liquid residue. It conducts a little, and corrodes over time.', {
        step: 'Step 3 · Clean', why: 'Residue from a spill bridges pads with a few hundred ohms: a slow leak that drains rails and confuses measurements.',
      });
      await t.clear();
      await t.key('0');
      for (let k = 0; k < 4; k++) { const p = await t.part('C97'); await t.clickBoard(p.x, p.y, 'F'); await t.wait(500); }
      await t.say('IPA (0): scrub until it is clean. Each pass removes about half.', { step: 'Step 3 · Clean' });
      await t.fit();
      await t.key('2');
      await t.focusPart('C29', 5);
      await t.clickPad('C29', '1');
      const v = await meter(t, /^3\.[1-4]\d* V$/, '+3V3 after repair');
      await t.say(`+3V3 at C29: **${v}**. The rail is back.`, { step: 'Step 4 · Check' });
      await t.clear();
      await t.fit();
      await t.key('1');
      await runTests(t, 'Step 5 · Verify');
    },
  },
  {
    id: 'demo-antmicro-jetson-nano-bb',
    approach: async (t) => {
      await t.card('ANTMICRO BASEBOARD · HOW TO APPROACH', 'No 3.3 V, and a 5 V that drops out', [
        'A carrier board for a compute module: **12 V** in, switching converters make **5 V** and **3.3 V**.',
        'Symptoms: the module will not start, and 5 V "sometimes" drops out when the board is handled.',
        'You will learn: rail checks, the **oscilloscope** on a converter\'s switch node, and hunting an **intermittent** fault.',
      ]);
      await t.wait(2000);
      await t.key('2');
      await t.focusPart('C32', 5);
      await t.highlightPart('C32', 'C32 on 5 V', 2);
      await t.clickPad('C32', '1');
      await t.clear();
      const v5 = await meter(t, /^4\.\d+ V$|^5\.\d+ V$/, '5 V at C32');
      await t.say(`5 V rail at C32: **${v5}**. Fine right now.`, { step: 'Step 1 · Measure the rails' });
      await t.clear();
      await t.focusPart('C26', 5);
      await t.highlightPart('C26', 'C26 on 3.3 V', 2);
      await t.clickPad('C26', '1');
      await t.clear();
      const v33 = await meter(t, /^(0\.\d+ V|[\d.]+ mV)$/, '3.3 V at C26');
      await t.say(`3.3 V rail at C26: **${v33}**. Dead, not sagging.`, {
        step: 'Step 1 · Measure the rails', why: '0 V (not a low voltage) and no heat: nothing is overloading the rail. The converter is simply not producing anything.',
      });
      await t.clear();
      const sw = await t.padOnNet('L1', /3V3_SW/);
      await t.focus(sw.x, sw.y, 5, sw.side);
      await t.key('o');
      await t.highlightPad('L1', (await t.page.evaluate((r) => (window as any).deadboard.pads(r), 'L1') as { name: string; net: string }[]).find((q) => /3V3_SW/.test(q.net))!.name, 'switch node');
      await t.clickBoard(sw.x, sw.y, sw.side);
      await t.clear();
      await t.say('Oscilloscope (O) on the 3.3 V converter\'s **switch node**, where its inductor L1 is driven: a **flat line**.', {
        step: 'Step 2 · Is it switching?', why: 'A buck converter chops its input on and off hundreds of thousands of times a second. No square wave here means the controller IC is not running.',
      });
      const sw5 = await t.padOnNet('L4', /5V_SW/);
      await t.focus(sw5.x, sw5.y, 5, sw5.side);
      await t.clickBoard(sw5.x, sw5.y, sw5.side);
      await t.say('Compare the working 5 V converter: a clean square wave.', {
        step: 'Step 2 · Compare', why: 'Same input, same kind of circuit. When one converter switches and its twin does not, suspect the dead one\'s controller IC.',
      });
      await t.card('WHAT YOU LEARNED', 'Dead rail vs. dragged rail; finding the intermittent', [
        'Rail at **0 V and cold** → the source is dead. Rail **low and hot** → something is overloading it.',
        'Scope the **switch node**: a square wave means the converter runs; flat means it does not.',
        'For "sometimes" faults: watch the rail and **press or flex** the board (B) near suspect joints, starting at the input filter.',
      ]);
    },
    solution: async (t) => {
      await t.card('ANTMICRO BASEBOARD · SOLUTION', 'New converter, reflowed ferrite', [
        'Diagnosis: the 3.3 V converter **U2** is dead, and input ferrite **FB1** has a cracked joint that opens when the board flexes.',
        'Tools: Desolder wick (4) · Select (1) · Soldering iron (3) · Multimeter (2)',
      ]);
      await t.wait(2000);
      await t.focusPart('U2', 5);
      await t.highlightPart('U2', 'U2', 2.5, true);
      await t.key('4');
      await t.clickPart('U2');
      await t.clear();
      await t.say('Wick (4) U2 off its pads.', {
        step: 'Step 1 · Remove U2', why: 'On a real board you would use hot air for a multi-pin IC, then clean the pads with wick and flux.',
      });
      await t.key('1');
      await t.clickPart('U2');
      await t.clickEl('#act-fit');
      await t.say('Select the empty footprint and fit a new converter from the Inspector.', { step: 'Step 2 · Fit a new one' });
      await t.key('2');
      await t.focusPart('C26', 5);
      await t.clickPad('C26', '1');
      const v = await meter(t, /^3\.[1-4]\d* V$/, '3.3 V after U2');
      await t.say(`3.3 V at C26: **${v}**.`, { step: 'Step 2 · Check' });
      await t.clear();
      await t.flipTo((await t.part('FB1')).side);
      await t.focusPart('FB1', 5);
      await t.highlightPart('FB1', 'FB1', 2, true);
      await t.key('3');
      await t.say('FB1 opens when the board flexes. Soldering iron (3): **reflow** its joint, even though it conducts right now.', {
        step: 'Step 3 · Cure the intermittent', why: 'A cracked joint can touch at rest and separate under stress. Reflowing re-forms the joint; waiting for it to fail on the bench wastes time.',
      });
      await t.clear();
      await t.clickPad('FB1', '1');
      await t.flipTo('F');
      await t.fit();
      await t.key('1');
      await runTests(t, 'Step 4 · Verify');
    },
  },
];
