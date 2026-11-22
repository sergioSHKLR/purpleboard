# How to test a PCB with a multimeter

A digital multimeter (DMM) is the first instrument you reach for on almost every dead board. Used properly, it tells you whether power reaches a regulator, whether a trace is broken, whether a rail is shorted to ground, and whether a diode or IC pin is blown. Used in the wrong mode — or on a live circuit — it lies or blows its fuse.

DEADBOARD models a **6000-count handheld multimeter** with real-world behaviour: a `10 MΩ` input impedance in voltage mode, probe lead (`0.2 Ω`) and contact resistance (`0.02–0.6 Ω`) in ohms mode, a `~1 mA` (`3.0 V` open-circuit, `OL` above `2.5 V`) diode test, and honest in-circuit capacitance limits.

## The five multimeter modes on a repair bench

| Mode | Board power | What it puts on the probes | What a good vs. bad reading looks like |
|---|---|---|---|
| **DC Voltage (`V⎓`)** | **ON** | High-impedance voltmeter (`10 MΩ` to black lead) | Exact rail voltage (`3.30 V`, `5.00 V`); `0.00 V` past a break or dead regulator |
| **Resistance (`Ω`)** | **OFF** | Low test voltage (`~1 V`) + range-dependent test current | `~0.2–1.0 Ω` across intact copper (`< 30 Ω` beeps); `OL` across an open trace or cold joint |
| **Diode (`•◄|`)** | **OFF** | `~1 mA` constant current (`3.0 V` open-circuit; `OL` above `2.5 V`) | `~0.6–0.7 V` (silicon), `~0.2–0.3 V` (Schottky), `~1.8–2.2 V` (red/yellow/green LED), `OL` backwards |
| **Capacitance (`CAP`)** | **OFF** | Ramp test current up to `1.0 V` across probes | Accurate for isolated caps; reads **high** or **`OL`** in-circuit due to parallel caps/resistance |
| **Current (`10 A`)** | **ON (series)** | `~0.01 Ω` shunt between probes | Must be wired **in series** with the load; never place across `VCC` and `GND` (blows fuse `> 10 A`) |

## 1. DC Voltage (`V⎓`) — Power ON

Voltage is always measured **across two points** while the circuit is energized:

- Put the **Black probe (`−` / `COM`)** on a known **Ground (`GND`)** pad or test point.
- Touch the **Red probe (`+`)** along the power path, one node at a time (`VIN` → fuse → switch → resistor → LED or regulator).
- Where voltage drops from `5.00 V` (or `3.00 V`) to `0.00 V` between two pads that should share copper, the open fault sits between them.

### Watch out for 10 MΩ meter loading

A real multimeter is not an infinite-resistance ideal probe; standard handheld meters present **`10 MΩ`** across their probes. On low-impedance power rails or `10 kΩ` dividers, `10 MΩ` shifts the reading by less than `0.1%`. On high-impedance bias or sense networks (`1 MΩ`–`10 MΩ` resistors), the meter itself forms a parallel divider to ground and pulls the measured voltage down noticeably — just as it does on the DEADBOARD bench.

## 2. Resistance (`Ω`) & Continuity — Power OFF

> **Golden rule:** Always turn bench power **OFF** (`P` on DEADBOARD) and let bulk capacitors discharge before switching to `Ω`, `Diode`, or `CAP` mode. External voltage on a powered rail fights the meter's `~1 V` test source, producing false readings (even negative or bogus values) and risking damage to a real meter.

- **Continuity & broken traces:** When both probes sit on the same unbroken copper net, a 2-wire meter reports **lead + contact resistance** (typically `0.2–1.5 Ω`, beeping below `~30 Ω`). If there is a hairline trace crack or an open **cold solder joint** between the pads, the meter reads **`OL` (Open Loop)**.
- **In-circuit resistance reads lower:** Measuring a `10 kΩ` resistor still soldered onto a board often reads *less* than `10 kΩ` because parallel paths through other components and semiconductor junctions conduct part of the meter's `~1 V` test current. Only trust an exact resistor measurement if parallel paths are open or you lift one leg of the part.

## 3. Diode Mode (`•◄|`) — Power OFF

Diode mode pushes a tiny constant current (`~1 mA`) from the **Red (`+`)** probe to the **Black (`−`)** probe and displays the forward voltage drop:

- **Testing discrete diodes and LEDs:** Put **Red** on Anode (`+`) and **Black** on Cathode (`K`, marked by a band on diodes or a flat rim / silkscreen `K` on LEDs).
  - Standard silicon diode (`1N4007`): **`~0.60–0.70 V`** forward, **`OL`** reversed.
  - Schottky diode: **`~0.20–0.35 V`** forward, **`OL`** reversed.
  - Red / yellow / green LED: glows dimly and drops **`~1.7–2.2 V`** forward; **`OL`** reversed.
  - Blue / white LED (`~2.7–3.2 V` forward drop): many handheld meters (including DEADBOARD's `6000`-count DMM, which reads `OL` above `2.5 V`) do not have enough compliance voltage to turn on a blue or white LED and show **`OL`** both ways. A high-compliance bench meter (`> 3.2 V`) or a current-limited `5 V` supply + resistor is needed to test them.
  - Reads `~0.000 V` both ways: **shorted diode** or a parallel short across its pads.
  - Reads `OL` both ways (on a silicon diode or red/yellow/green LED): **open/blown junction** or broken trace.
- **Checking IC pins to Ground (red-on-ground convention):** Technicians often put **Red on `GND`** and probe signal or data pins with **Black** to forward-bias the chip's internal ESD protection diode to ground. A healthy pin typically shows `~0.4–0.7 V`; `0.000 V` indicates a dead short on that pin.

## 4. Capacitance (`CAP`) & Current (`10 A`)

- **Why capacitance reads high — or `OL` — in circuit:**
  1. Every decoupling capacitor wired between `+3V3` and `GND` sits in **parallel**. Probing across a single `100 nF` ceramic capacitor on a `3.3 V` rail measures the sum of *all* capacitors on that rail (`C_total = C1 + C2 + ...`), which can read tens or hundreds of microfarads.
  2. Any parallel load resistance across the rail steals part of the meter's charging ramp current, inflating the reading further — or, if parallel resistance is low enough (`< 10 kΩ`), preventing the ramp from reaching `1.0 V` at all so the meter reads **`OL`**.
  To measure a single capacitor's true value, **lift at least one end** off the board first.
- **Current (`10 A`) works only in series:** In current mode, the meter places a tiny `~0.01 Ω` shunt directly between the probes. Placing it across `+5V` and `GND` creates a dead short and blows the meter's internal fuse (`> 10 A` shows `OL` in DEADBOARD). Break the circuit (for example across an empty fuse footprint) so load current flows *through* the meter — and on a real meter, always move the red lead back to the `V/Ω` jack immediately afterwards!

## 5. Ohm’s Law, Voltage Dividers & Resistor Codes

Two equations solve most DC analog and indicator-circuit faults:

- **Current-limiting resistor (Ohm’s Law):**
  `I = (Vsupply − Vled) / R` → `R = (Vsupply − Vled) / I`
  *Example:* A blue LED drops `~3.0 V` on a `5.0 V` USB rail. With a wrong `100 kΩ` resistor fitted, current is `(5 − 3) / 100,000 = 0.02 mA` (LED stays dark). Swapping to `150 Ω` gives `~13 mA` and lights it cleanly.
- **Voltage divider:**
  `Vout = Vin × R2 / (R1 + R2)`
  *Example:* With `Vin = 5.0 V` and `R1 = 10 kΩ`, `R2 = 10 kΩ` produces `2.50 V` at the midpoint. If `R2` (the lower resistor to `GND`) is missing or cold-jointed, nothing pulls the midpoint down and `Vout` sits at `5.00 V`. If `R2` is mistakenly `1 kΩ` instead of `10 kΩ`, `Vout` sags to `5 × 1 / 11 ≈ 0.45 V`.

### Reading resistor values (4-band colour code & SMD markings)

For **4-band** through-hole resistors, read toward the tolerance band (Gold `±5%` or Silver `±10%`) on the right:

| Colour | Digit (Bands 1 & 2) | Multiplier (Band 3) | Tolerance (Band 4) |
|---|---|---|---|
| Black | `0` | `× 1 Ω` | — |
| Brown | `1` | `× 10 Ω` | `±1%` |
| Red | `2` | `× 100 Ω` | `±2%` |
| Orange | `3` | `× 1 kΩ` | — |
| Yellow | `4` | `× 10 kΩ` | — |
| Green | `5` | `× 100 kΩ` | `±0.5%` |
| Blue | `6` | `× 1 MΩ` | `±0.25%` |
| Violet | `7` | `× 10 MΩ` | `±0.1%` |
| Grey | `8` | — | — |
| White | `9` | — | — |
| Gold | — | `× 0.1 Ω` | `±5%` |
| Silver | — | `× 0.01 Ω` | `±10%` |

- **Common 4-band examples:** `Brown-Black-Brown-Gold` = `10 × 10 = 100 Ω` · `Brown-Green-Brown-Gold` = `15 × 10 = 150 Ω` · `Orange-Orange-Brown-Gold` = `33 × 10 = 330 Ω` · `Brown-Black-Red-Gold` = `10 × 100 = 1 kΩ` · `Brown-Black-Orange-Gold` = `10 × 1k = 10 kΩ` · `Brown-Black-Yellow-Gold` = `10 × 10k = 100 kΩ`.
- **5-band (`1%`) resistors:** Read three digits first, then the multiplier on band 4 (for example `150 Ω` is `Brown-Green-Black-Black-Brown`).
- **SMD resistors on modern boards:** Printed with 3 digits (`103` = `10 × 10³ = 10 kΩ`, `472` = `4.7 kΩ`), `R` as a decimal point (`4R7` = `4.7 Ω`), or left unmarked on tiny `0402`/`0201` packages (check the **BOM** or **Schematic**).

## Practice these skills on the bench

- [First Light — Voltage (`V⎓`) vs. Continuity (`Ω`) on a broken trace](./app.html?board=builtin-first-light&tutorial=1)
- [One-Way LED — Diode mode (`•◄|`) and LED polarity](./app.html?board=builtin-tut-polarity&tutorial=1)
- [Resistor & Ohm’s Law — Reading colour bands and swapping a wrong resistor](./app.html?board=builtin-tut-resistor&tutorial=1)
- [Voltage Divider 101 — Probing test points and populating `R2`](./app.html?board=builtin-tut-divider&tutorial=1)
- [The Sagging Rail — Multi-layer `Vout` diagnosis and resistor repair](./app.html?board=builtin-sagging-rail)
