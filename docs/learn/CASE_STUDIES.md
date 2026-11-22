# Real open-hardware PCB repair case studies

Reading theory is only half the skill — real boards have 50 to 500+ parts, multiple power domains, connectors that get yanked, and spills that creep under fine-pitch pins.

Below are **spoiler-free diagnostic game plans** for all seven open-hardware boards shipped in DEADBOARD. Each walkthrough tells you the customer complaint, the power architecture, and the first measurements a technician makes on the bench — without spoiling the exact faulty component or flag.

> **Want rail-by-rail reference voltages inside the bench?** Open **Boards → Mods → Community** and install **Board notes**, which adds expected rail voltages and probe notes for every shipped board.

## 1. Olimex ESP32-DevKit-LiPo · dead on USB, won’t charge

- **Hardware:** 50-part ESP32 development board with USB power and an on-board Li-ion battery charger (no battery plugged in on the bench).
- **Customer complaint:** Stopped doing anything on USB after the cable was yanked; before that, the battery *"never seemed to charge"*.
- **Diagnostic plan (no spoilers):**
  1. **Start at the mechanical stress point:** A yanked USB cable points straight at connector pads, traces leaving `VBUS`, and nearby protection components. Inspect both sides (`F`) and test **Press / flex (`B`)** around the USB input.
  2. **Follow `VBUS` into the 3.3 V regulator:** With power on (`P`), probe `V⎓` from the USB input toward the 3.3 V LDO `VIN` and `VOUT`.
  3. **Inspect the charger circuit separately:** A board can boot on USB while its Li-ion charger still refuses to charge. Check the charger IC's `VIN`, `BAT`, and especially its current-programming resistor (`PROG`) with power **off** in `Ω` mode.
- **Launch lab:** [Open Olimex ESP32-DevKit-LiPo on the bench →](./app.html?board=demo-olimex-esp32-devkit-lipo)

## 2. Rana Tadpole V1 · dead on USB

- **Hardware:** 56-part RP2040 pocket controller with 20 mouse-switch buttons; USB enters from a breakout board over a flat cable (`U2`).
- **Customer complaint:** Plugged into USB, the host sees nothing, and nothing gets warm.
- **Diagnostic plan (no spoilers):**
  1. **Read bench current first:** *"Nothing gets warm"* usually rules out a dead short and points to an **open path**, missing rail, or unpowered regulator (`0.0 mA` or near-zero draw).
  2. **Trace power out of `U2`:** With power on, probe `V⎓` from the flat-cable input pins to the `3.3 V` regulator input (`VIN`), enable (`EN`), and output (`VOUT`).
  3. **Check continuity (`Ω`, power off) wherever voltage stops:** A single open joint, missing component, or broken trace between `VBUS` and `3.3 V` silences the entire RP2040.
- **Launch lab:** [Open Rana Tadpole V1 on the bench →](./app.html?board=demo-rana-tadpole-v1)

## 3. Olimex ESP32-C3-DevKit-Lipo · hot board, wrong 3.3 V

- **Hardware:** 49-part ESP32-C3 board with USB and Li-ion charger (no battery connected).
- **Customer complaint:** Fresh off a small production run — gets warm on USB and the chip never starts. The assembler suspects two component reels were swapped.
- **Diagnostic plan (no spoilers):**
  1. **Measure the `3.3 V` rail immediately (`V⎓`):** Don't assume *"warm"* always means a dead `0 Ω` short — a rail running at the wrong voltage (too high or too low) also heats regulators and prevents the MCU from booting.
  2. **Use Thermal view (`Thermal`) to locate heat:** Note *what* is getting warm (the regulator itself, a resistor, or a cap?).
  3. **Compare feedback & support values against the schematic/BOM:** Remember that adjustable regulators set output voltage via their feedback divider (`Vout = Vref × (1 + R_top / R_bot)`). If two resistor or part reels were swapped in assembly, inspect values carefully!
- **Launch lab:** [Open Olimex ESP32-C3-DevKit-Lipo on the bench →](./app.html?board=demo-olimex-esp32-c3-devkit-lipo)

## 4. ESP32-C3 Rust board · rails fine, chip asleep

- **Hardware:** 55-part ESP32-C3 training board (sensors, RGB LED, Li-ion charger, USB-C; no battery on the bench).
- **Customer complaint:** Came back from a workshop after a drink spill; another participant noted it *"only really worked on the battery"* before that. On USB it now stays silent, even though rails look fine.
- **Diagnostic plan (no spoilers):**
  1. **Verify the power path on USB (`VBUS` → `3.3 V`):** Confirm why USB power differed from battery power (check input diodes, jumpers, and joints on the USB side).
  2. **Think like a microcontroller:** When `3.3 V` is present yet the chip stays asleep, check the **reset / enable (`EN` / `CHIP_PU`)** pin and pull-up network!
  3. **Treat the liquid spill (`0` Isopropyl):** Dried drink residue creates leaky parasitic resistance between adjacent pads or pins — pulling an `EN` or strap line low without looking like a `0 Ω` dead short. Inspect closely and clean residue with **IPA (`0`)**.
- **Launch lab:** [Open ESP32-C3 Rust board on the bench →](./app.html?board=demo-esp32-c3-rust-board)

## 5. Rana Tadpole V2 · dead controller, warm chips, one dead button

- **Hardware:** 147-part RP2040 pocket controller with USB-C and 20 mouse-switch buttons.
- **Customer complaint:** Host sees nothing on USB, the middle of the board gets warm (is the RP2040 itself dead?), and before it died, button `SW2` had stopped registering.
- **Diagnostic plan (no spoilers):**
  1. **Don't condemn the main IC prematurely:** A warm area near the RP2040 does not prove the RP2040 is dead — a shorted decoupling MLCC or struggling LDO right beside it produces the same symptom.
  2. **Check `Ω` to `GND` on the `3.3 V` rail (power off), then pinpoint the hot spot:** Use **Thermal view**, **Freeze spray (`9`)**, **IPA (`0`)**, or **Rosin (`R`)** under current limit / `1 V` injection to see which exact part heats up first.
  3. **Track down `SW2` separately:** Once the controller powers up, select `SW2` (`1`) and trace its two pads (`Ω` power off, and press `SW2` while probing) to see why that single switch never reaches the MCU/GND.
- **Launch lab:** [Open Rana Tadpole V2 on the bench →](./app.html?board=demo-rana-tadpole-v2)

## 6. Antmicro Jetson Nano baseboard · no 3.3 V, flaky 5 V

- **Hardware:** 369-part compute-module carrier board powered from `12 V`.
- **Customer complaint:** The compute module never starts: `3.3 V` is missing, and the `5 V` rail *"sometimes"* drops out when the board is handled.
- **Diagnostic plan (no spoilers):**
  1. **Map the power tree (`12 V` → `5 V` → `3.3 V`):** Use the **Schematic** and click pads to trace how the `5 V` and `3.3 V` converters receive `VIN` and `EN`.
  2. **Reproduce the "flaky when handled" fault (`B` Press / flex + `O` Scope Roll):** Clip the oscilloscope (`O`) in **Roll mode** onto the `5 V` rail and probe/flex around the `5 V` converter and passive path (`B`) to catch the cracked joint or intermittent drop.
  3. **Diagnose missing `3.3 V` methodically:** Power off → check `3.3 V` rail `Ω` to `GND` for a short. Power on → check `3.3 V` regulator `VIN`, `EN`, and switch node (`SW`) on the scope.
- **Launch lab:** [Open Antmicro baseboard on the bench →](./app.html?board=demo-antmicro-jetson-nano-bb)

## 7. MNT Reform 2 mainboard · dead 3.3 V rail

- **Hardware:** 522-part open-hardware laptop mainboard; bench supply clipped to `30V_GATE` (`30 V`).
- **Customer complaint:** The board powers up on the bench supply, yet the system never starts because the `3.3 V` rail is missing.
- **Diagnostic plan (no spoilers):**
  1. **Check the rail hierarchy:** Compare `+5V`, `+3V3`, and `+1V2` voltages with power on (`V⎓`), and watch total current on the `30 V` bench supply.
  2. **Check `+3V3` resistance to `GND` (power off):** Is the `3.3 V` buck converter disabled/dead, or is a shorted component on `+3V3` dragging the rail down and forcing protection?
  3. **Use the oscilloscope (`O`) on the `3.3 V` switch node + thermal localization:** If the rail is shorted, inject `1 V` (via **Bench → Supply**) onto `+3V3` and scan with **Thermal view** or **Rosin (`R`)** to pinpoint the exact part out of 522 without guessing.
- **Launch lab:** [Open MNT Reform 2 mainboard on the bench →](./app.html?board=demo-mnt-reform2-mb30)
