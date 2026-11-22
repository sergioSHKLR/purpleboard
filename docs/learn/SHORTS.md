# How to find a short circuit on a PCB

A shorted power rail is one of the most common reasons a board refuses to power on — and one of the easiest to make worse if you guess. A tiny `0402` ceramic capacitor (MLCC) cracked by flex or voltage stress can pull an entire `3.3 V` or `19 V` rail straight to ground, leaving dozens of parts on the same net reading `< 1 Ω`.

Pulling capacitors at random destroys pads. Instead, combine **rail splitting**, **current-limited voltage injection**, and **thermal localization**.

## 1. Tell a short apart from a leak or an open circuit

Measure resistance to `GND` with power **OFF** (and capacitors discharged), and watch the **bench power supply** under a safe current limit:

| Symptom | Resistance to `GND` | Bench supply behaviour | Likely cause |
|---|---|---|---|
| **Open circuit** | `OL` or normal high impedance | `0.0 mA` draw | Cut trace, cold joint, blown fuse, open switch, dead input regulator |
| **Dead short** | `< 2 Ω` (often `0.2–0.8 Ω` including probe leads) | Immediately hits **Current Limit (CC)**; rail collapses near `0 V` | Shorted MLCC, solder bridge, copper sliver, shorted IC/MOSFET |
| **High-resistance leak** | Tens to hundreds of ohms (lower than known-good) | Elevated current draw; rail sags or regulator gets warm | Liquid-damage residue, leaky capacitor, partially damaged silicon |

## 2. Never replace a blown fuse before finding why it blew

Fuses do not fail from age — they melt open to stop a downstream short from burning traces or catching fire. When you find an open fuse (`F1`), **split the board**:

1. With power **OFF**, measure resistance from `GND` to **both pads** of the blown fuse (`F1.1` and `F1.2`).
2. The input side (`F1.1`) should read high impedance; the downstream rail side (`F1.2`) reads near `0 Ω` to `GND` while the short is still present.
3. **Clear the short first**, confirm resistance to ground returns to normal, and *only then* solder a fresh fuse.

> On multi-rail boards without a fuse on the shorted rail, **series inductors** (such as a buck converter's output inductor) or **0 Ω jumpers** act as natural split points: lifting one pad tells you whether the short lives on the regulator side or the load side.

## 3. Current-limited bench supply vs. voltage injection

DEADBOARD's **Bench** menu gives you two distinct ways to use a bench power supply — mirroring real repair work:

### A. Current-limited bring-up (`Board PSU` + `Current limit`)

When powering a board through its normal input connector (`100 mA` or `500 mA` limit), capping current prevents an upstream short or reversed diode from popping a new fuse or burning copper while you measure voltages and check thermal rise.

### B. Direct Voltage Injection (`Inject 1 V · 3 A` or `Inject 3.3 V · 1 A`)

When dozens of capacitors and chips share a dead-shorted rail, every pad on that rail measures roughly the same `~0.3 Ω` to `GND`. You locate the fault with **heat** (`P = I²R`): the tiny shorted component concentrates power dissipation and warms up first.

Follow these strict rules before injecting voltage onto a shorted net (in DEADBOARD, place the **Red probe** on the shorted net, **Black** on `GND`, and pick an injection preset in **Bench → Supply**):

- **Always start low (`1.0 V`), never high (`12 V` / `20 V`).** Even on a `5 V` or `12 V` rail — and especially on `1.0 V`–`3.3 V` logic rails — inject `1.0 V` first. If a shorted MLCC suddenly burns open mid-test, or if the short sits behind trace resistance, a high injection voltage will snap the rail up and destroy every IC on that net.
- **Why `1 V · 3 A` heats a dead short when `100 mA` will not:** On a `0.2 Ω` dead short across a wide copper ground plane, `100 mA` dissipates only `0.1² × 0.2 = 2 mW` — invisible under copper heat sinking. At `2–3 A` (`1.0 V`), `P = I²R` puts `~0.8–1.8 W` directly into the `0402` capacitor or silicon fault, creating an unmistakable hot spot. (Only raise voltage to `3.3 V` if the rail is rated for `≥ 3.3 V` and `1.0 V` draws too little current on a high-resistance leak.)
- **Never inject blindly into a primary input bus (`VIN` / `19 V` / `PPBUS_G3H`):** First check `Ω` between the main input bus and every buck converter's output inductor (`SW` / `VOUT`). If a buck's **high-side MOSFET** is shorted internally, the input rail is wired straight to a `1 V` CPU/GPU core — injecting `3.3 V` or more into the input rail sends lethal voltage straight into the processor!

## 4. Thermal camera traps: why shiny solder looks cold

An infrared (IR) thermal camera measures emitted thermal radiation and converts it to temperature assuming a fixed surface **emissivity (`ε`)**.

| Surface on a PCB | Typical emissivity (`ε`) | What the IR camera shows |
|---|---|---|
| **Matte solder mask & black IC epoxy** | `~0.90` | Accurate surface temperature |
| **Exposed copper via** | `~0.60` | Reads noticeably cooler than reality |
| **Bare shiny solder / metal shield** | `~0.10–0.30` | Reflects the `~25 °C` room! A `90 °C` solder joint can read `< 35 °C` |

**Takeaway:** Watch the **matte solder mask** and **epoxy bodies** of parts rather than bright solder fillets or metal shields. (On a real metal shield can, technicians stick a piece of matte tape or coat it with rosin/IPA so it stops acting like a mirror. DEADBOARD models this exact grey-body emissivity physics.)

## 5. Three bench-top ways to pinpoint the hot part

Even without a thermal camera — or when shiny solder hides heat — three classic bench methods locate a hot short under current-limited power:

1. **Freeze spray (`9`):** Frosts an area down to `0 °C`. Once power is applied, the hottest component pays off the frost's latent heat first and defrosts clear while its neighbours stay white.
2. **Isopropyl alcohol / IPA (`0`):** Wets the board with a thin film of liquid. Under power, IPA evaporates rapidly off the hot component first. *(IPA is flammable: keep it to low-voltage DC bench work, well away from `400 °C` hot air or irons, and let it dry. Scrubbing with IPA also dissolves conductive **liquid-damage residue**!)*
3. **The Rosin method (`R`):** A light white haze of condensed gum rosin is applied over the suspect area (with fume extraction on a real bench). Around **`60–70 °C`**, the rosin melts clear and glossy on the hottest part first — pinpointing a single `0402` capacitor sitting next to twenty identical neighbours.

## 6. Hidden shorts: copper slivers & liquid residue

Not every short lives inside a component:

- **Solder bridges (`4` Wick):** Excess solder spanning two adjacent pads or IC pins. Always flip the board (`F`) to inspect the bottom side too.
- **Hairline copper slivers (`7` Trace cutter):** Manufacturing defects or scraped mask bridging a power trace to a neighbouring ground trace. Cut the sliver cleanly and re-check `Ω` to `GND`.
- **Liquid residue (`0` IPA):** Dried drink/flux/corrosion residue creates conductive leakage paths across fine-pitch pins (tens or hundreds of ohms rather than `0 Ω`). Scrub with IPA before replacing chips.

## Practice short hunting on the bench

- [Solder Bridge 101 — Spotting `~28 mA` current draw and wicking a bridge](./app.html?board=builtin-tut-solder-bridge&tutorial=1)
- [Ghost Short — Splitting a board at a blown fuse (`F1`) and cutting a copper sliver](./app.html?board=builtin-ghost-short)
- [Smoke Test — Using `100 mA` current limit + Thermal / Diode mode before replacing `F1`](./app.html?board=builtin-smoke-test)
- [Olimex ESP32-C3 — Hunting a warm rail problem on a real 49-part board](./app.html?board=demo-olimex-esp32-c3-devkit-lipo)
- [Rana Tadpole V2 — Finding why the middle of a 147-part controller gets hot](./app.html?board=demo-rana-tadpole-v2)
- [MNT Reform 2 — Diagnosing a dead `3.3 V` rail on a 522-part laptop mainboard](./app.html?board=demo-mnt-reform2-mb30)
