# Learn board-level PCB repair

Board-level repair is the craft of diagnosing a dead circuit board down to the exact failed trace, solder joint, capacitor, resistor, or regulator and fixing it — instead of swapping the whole board.

**DEADBOARD** pairs written troubleshooting guides with a SPICE-based repair bench that runs in your browser. Every meter reading, boot current, thermal hot spot, and power-up ramp comes from simulating the circuit rather than a scripted multiple-choice quiz.

> **Prefer to learn hands-on right away?** [Launch the 5-minute interactive tutorial](./app.html?tutorial=1) on the bench, or follow the written curriculum below and open each lab board as you go.

## How a circuit board is put together

Before probing a board, know the five physical elements you are looking at:

| Part of the board | What it does | What goes wrong |
|---|---|---|
| **Substrate (FR-4)** | Rigid fibreglass plate that supports components and insulates copper layers. | Flex cracks, delamination from excessive rework heat (`> 300 °C`). |
| **Copper traces & planes** | Flat copper tracks carrying signals and power; wide internal or outer **planes** (`GND`, power) distribute current and sink heat. | Hairline open cracks, corrosion from spills, accidental copper slivers shorting adjacent tracks. |
| **Pads & vias** | Exposed gold/tinned rings where part leads solder (**pads**); plated holes connecting **Top**, **Bottom**, and internal layers (**vias**). | Cold solder joints, bridged pads, lifted/torn pads, corroded vias. |
| **Solder mask & silkscreen** | Insulating coating over copper, plus printed labels (`R1`, `D1`, `K`, `+`, pin-1 dots). | Reversed polarised parts when silkscreen `K` (cathode) or pin-1 markers are ignored. |
| **Components** | Resistors, ceramic capacitors (MLCCs), diodes/LEDs, fuses, inductors, linear/buck regulators, ICs. | Dead-short MLCCs, blown fuses, drifted resistors, leaky/shorted ICs, missing parts. |

## The four-step troubleshooting loop

Experienced technicians rarely guess and rarely start by heating parts. Follow the same sequence on every board, from a 3-part flashlight to a 522-part laptop mainboard:

1. **Inspect both sides before powering on (`1` Select, `F` Flip)** — Examine Top and Bottom under light/magnification. Check silkscreen polarity (`K` bar on diodes/LEDs, pin-1 dots on ICs), missing footprints, burnt parts or blown fuses, liquid residue, dull grainy cold joints, and unwanted solder blobs.
2. **Check for rail shorts, then watch power-up current (`P` Power, Bench Supply)** — On an unknown dead board, check `Ω` to `GND` on main rails first (power off) or power up through a **current limit (`OCP`)** so a hard short does not burn copper. `0.0 mA` points to an open path or dead input; hitting current limit points to a short; pulsing current points to a boot loop.
3. **Measure and isolate (`2` Meter, `O` Scope, `9`/`0`/`R` Thermal)** — Measure **Voltage (`V⎓`)** with power **on**; turn power **off** and let capacitors discharge before measuring **Resistance (`Ω`)**, **Diode (`•◄|`)**, or **Capacitance (`CAP`)**. On a shorted rail, use low-voltage current-limited injection with **Thermal view**, **Freeze spray (`9`)**, **IPA (`0`)**, or **Rosin (`R`)** to make the hot part reveal itself.
4. **Rework and verify (`3`–`8`, `H`, `Run tests`)** — Reflow cold joints, wick bridges, jump open traces or lifted pads, replace failed parts, clean flux residue, then power up and verify both electrical readings and circuit behaviour.

## Study guides by topic

Work through the four field guides in order, or jump straight to the diagnostic skill you need:

1. **[Multimeter & Ohm’s law](MULTIMETER.md)** — DC voltage (`10 MΩ` loading), resistance and continuity (why power must be off), diode mode (`2.5–3 V` compliance vs. blue LEDs), why in-circuit capacitance reads high or `OL`, SMD & 4-band resistor codes, and voltage dividers.
2. **[Finding short circuits](SHORTS.md)** — Separating dead shorts from leaks and opens, splitting a circuit at a fuse or inductor, safe low-voltage current injection (and the high-side FET trap), IR emissivity pitfalls, freeze spray, IPA, and the rosin method.
3. **[Power rails, boot current & oscilloscope](POWER_RAILS.md)** — Reading `G3H` and `S5 → S4 → S3 → S0` boot current, LDO vs. buck converter vs. Li-ion charger faults, oscilloscope Roll vs. Auto mode (and AC coupling / ripple), boardviews, and flex/thermal intermittent faults.
4. **[PCB soldering & rework](REWORK.md)** — Spotting and reflowing cold joints, clearing solder bridges with wick, jumping broken traces and lifted pads, flux chemistry, ground-plane heat sinking, bottom preheaters, and hot-air MLCC thermal shock.

## Interactive curriculum on the bench

Every lesson below opens directly on the DEADBOARD bench. The beginner track walks you step by step; the training challenges combine multiple faults; the open-hardware demos run real KiCad boards under SPICE.

### Track 1: Beginner fundamentals (guided labs)

| Lab | Concepts & instruments | Open on bench |
|---|---|---|
| **First Light** | Traces & pads, `V⎓` vs. `Ω` continuity, bridging a cut trace with the soldering iron | [Start First Light →](./app.html?board=builtin-first-light&tutorial=1) |
| **Cold Joint 101** | Flipping to the Bottom side (`F`), spotting dull cold joints, reflowing with `3` Iron | [Start Cold Joint 101 →](./app.html?board=builtin-tut-cold-joint&tutorial=1) |
| **Solder Bridge 101** | Short vs. open circuit, reading supply current (`~28 mA`), removing bridges with `4` Wick | [Start Solder Bridge 101 →](./app.html?board=builtin-tut-solder-bridge&tutorial=1) |
| **One-Way LED** | Anode (`+`) vs. Cathode (`K`), testing polarity in Diode mode, `5` Rotate 180° | [Start One-Way LED →](./app.html?board=builtin-tut-polarity&tutorial=1) |
| **Resistor & Ohm’s Law** | Calculating LED current `I = (Vsupply − Vled) / R`, reading 4-band colour codes, `8` Parts bin | [Start Resistor & Ohm’s Law →](./app.html?board=builtin-tut-resistor&tutorial=1) |
| **Voltage Divider 101** | Test points (`TP1`), `Vout = Vin × R2 / (R1 + R2)`, populating a missing footprint | [Start Voltage Divider 101 →](./app.html?board=builtin-tut-divider&tutorial=1) |

### Track 2: Multi-fault training challenges

| Challenge | What you diagnose | Open on bench |
|---|---|---|
| **Bridge Troll** | Two-fault through-hole board combining a cold joint and a solder bridge on the bottom side | [Open Bridge Troll →](./app.html?board=builtin-bridge-troll) |
| **Backwards Day** | Wrong resistor reel, reversed LED polarity, and a hidden broken trace on the bottom copper layer | [Open Backwards Day →](./app.html?board=builtin-backwards-day) |
| **Smoke Test** | Blown fuse (`F1`), reversed protection diode (`D1`), and a shorted rail requiring `100 mA` current limit | [Open Smoke Test →](./app.html?board=builtin-smoke-test) |
| **Ghost Short** | Blown fuse protecting a 5 V reference rail with a hairline copper sliver shorting `+5V` to `GND` | [Open Ghost Short →](./app.html?board=builtin-ghost-short) |
| **The Sagging Rail** | Wrong resistor divider value plus a broken bottom ground return path through a via | [Open The Sagging Rail →](./app.html?board=builtin-sagging-rail) |

### Track 3: Real open-hardware boards

| Board | Parts | Symptom on the bench | Open on bench |
|---|---|---|---|
| **Olimex ESP32-DevKit-LiPo** | 50 | Dead on USB after the cable got yanked; battery never seemed to charge | [Open Olimex ESP32 →](./app.html?board=demo-olimex-esp32-devkit-lipo) |
| **Rana Tadpole V1** | 56 | Pocket RP2040 controller dead on USB over flat cable; nothing gets warm | [Open Tadpole V1 →](./app.html?board=demo-rana-tadpole-v1) |
| **Olimex ESP32-C3-DevKit-Lipo** | 49 | Gets warm on USB and chip never starts; wrong 3.3 V rail from swapped reels | [Open Olimex ESP32-C3 →](./app.html?board=demo-olimex-esp32-c3-devkit-lipo) |
| **ESP32-C3 Rust board** | 55 | Rails look fine, chip stays asleep after a spill; worked only on battery | [Open Rust ESP32-C3 →](./app.html?board=demo-esp32-c3-rust-board) |
| **Rana Tadpole V2** | 147 | Dead on USB, warm in the middle around RP2040, plus one dead switch (`SW2`) | [Open Tadpole V2 →](./app.html?board=demo-rana-tadpole-v2) |
| **Antmicro Jetson baseboard** | 369 | Fed 12 V: 3.3 V rail missing and 5 V rail drops out when handled | [Open Antmicro baseboard →](./app.html?board=demo-antmicro-jetson-nano-bb) |
| **MNT Reform 2 mainboard** | 522 | Laptop mainboard powers up on `30V_GATE`, yet the 3.3 V rail never comes up | [Open MNT Reform 2 →](./app.html?board=demo-mnt-reform2-mb30) |

## Frequently asked questions

### Can I learn board-level repair in a browser without physical equipment?

Yes — for troubleshooting methodology, instrument interpretation, power-tree reasoning, and schematic/boardview workflow, a physics-based simulator lets you build real habits before buying a bench supply, thermal camera, or hot-air station. You still need hands-on practice with real solder and tweezers for physical muscle memory, so treat DEADBOARD as your flight simulator for diagnostics and rework sequencing.

### How is DEADBOARD different from an electronics quiz?

DEADBOARD solves the circuit with a SPICE-style engine, a 2D finite-volume thermal plate, and realistic instrument models (`10 MΩ` DMM input impedance, probe contact resistance, IR surface emissivity, solder liquidus, and flux burnout). Challenges are verified against electrical checks and encrypted to the repaired circuit topology, so there are no scripted answers or shortcuts.

### Why do some boards say a value is an estimate or a waveform is synthesized?

Every model value in DEADBOARD comes from board files, component datasheets, or design intent. Where real-world datasheet parameters or cycle-by-cycle switching traces are unavailable, the bench labels estimates explicitly and marks synthesized oscilloscope waveforms as such rather than pretending they are lab measurements.

### Can I practice on my own KiCad or boardview boards?

Yes. Drop a KiCad `.kicad_pcb`, boardview `.brd` / `.tvw`, or shared `.pcbfix.json` file straight onto the bench, or package your boards, BOM, schematic, and repair challenges into a [DEADBOARD mod](../MODDING.md).
