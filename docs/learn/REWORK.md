# PCB soldering & rework: cold joints, bridges, hot air & pads

Once you locate the bad joint, cut trace, or shorted capacitor, the repair still has to survive the iron. Poor rework turns a single-component fault into a torn pad and three broken nets.

*(Bench safety first: turn power **OFF** and discharge large capacitors before touching a soldering iron or hot air to a board, and use fume extraction whenever melting solder or flux.)*

DEADBOARD models physical rework thermally (enabled under **Bench → Rework**): solder alloy liquidus, flux wetting and burn-off, copper ground-plane heat sinking, bottom preheaters, pad delamination, and MLCC thermal shock.

## 1. Cold solder joints

A **cold solder joint** happens when solder solidifies without properly wetting the metal component lead and copper pad (insufficient heat, oxidation, missing flux, or movement during cooling).

- **How to spot it:** Good joints are smooth, shiny, concave fillets. A cold joint looks **dull, grey, and grainy** — and on through-hole boards it sits on the **Bottom side** (`F` to flip) even while the Top looks fine.
- **How it fails electrically:** It may read `OL` completely, act as a high-resistance joint (`tens of Ω`) that makes a rail sag under load, or cut out intermittently when pressed or warmed.
- **How to fix it:** Apply fresh flux and touch the **Soldering iron (`3`)** to both the pad and lead so the solder stays molten cleanly (`> 0.6 s` above liquidus) and wets both surfaces into a shiny fillet.

## 2. Solder bridges & desolder wick (`4`)

A **solder bridge** is an unintended blob of solder linking two nearby pads or IC pins.

- **Don't drag a dry iron blindly:** Poking bridged pins without flux usually smears the blob onto the next pair.
- **Use Desolder wick (`4`):** Fluxed braided copper draws molten solder up into the braid by capillary action. Lay wick over the bridge, heat cleanly with the iron, and lift both together once the solder wicks into the copper — leaving separated, concave joints.

## 3. Broken traces, copper slivers & lifted pads

- **Tiny trace gaps (`< 1 mm`):** Expose clean copper on both ends and bridge across with a small bead of solder using the **Soldering iron (`3`)**.
- **Longer gaps & lifted pads:** Never stretch a bare solder bridge over a long span or near neighbouring nets. Route an insulated **Jumper wire (`6`)** between pads or vias — even across the Top and Bottom sides of the board.
- **Lifted pads:** Holding a pad above **`~300 °C`** for several seconds — or pulling a part before every pin is molten — delaminates the copper foil from the FR-4 fibreglass substrate. Check the schematic/boardview first: if it is a no-connect (`NC`) pad, leave it; if it carries a signal or power, scrape a tiny spot of solder mask off the surviving trace (or jump to the nearest via/pad on that net) with thin insulated jumper wire (`0.1 mm` / `38 AWG` enamelled wire on real boards, anchored with UV solder mask).
- **Unwanted copper (`7` Trace cutter):** Cleanly sever a hairline copper sliver or isolate a rail branch while hunting a short.

## 4. The physics of rework: alloys, flux & ground planes

Understanding where heat goes prevents burnt boards:

| Factor | Typical value | Why it matters on the bench |
|---|---|---|
| **Leaded `Sn63Pb37` liquidus** | `183 °C` | Melts easily with lower thermal stress on pads and components. |
| **Lead-free `SAC305` liquidus** | `217 °C` | Requires higher heat and dwell; most modern production boards ship lead-free. |
| **Flux wetting** | `~0.22 W/K` wet vs. `~0.07 W/K` dry | Flux strips oxides and roughly triples tip-to-joint heat transfer. Fighting a joint with a dry tip overheats the pad before solder melts. |
| **Flux burn-off window** | `~8 s` above liquidus | Dwell too long and flux chars away, leaving a dull oxidised joint and risking pad lift. |
| **Ground (`GND`) planes** | Large copper mass | A pad tied directly to an internal `GND` plane drains heat fast — one end of a resistor melts in 1 second while the `GND` pad stays stubbornly solid. |
| **Pad delamination limit** | `~300 °C` sustained | Cranking a tiny conical tip to `450 °C` on a `GND` pad tears the copper off the FR-4. Use a **wider chisel/bevel tip**, **fresh flux**, and a **bottom preheater** instead. |

*(Practical shop trick on stubborn lead-free ground joints: adding a touch of `Sn63Pb37` leaded solder lowers the local melting temperature so the part lifts safely; wick the mixed alloy clean afterwards and clean residual flux with **IPA (`0`)** so sticky residue doesn't trap moisture.)*

## 5. Hot air (`H`), bottom preheaters & MLCC thermal shock

Multi-pad surface-mount (SMD) parts cannot be lifted safely with a single iron tip without stressing pads:

1. **Use a bottom preheater (`120–150 °C`) on dense boards:** Warming the PCB from below shrinks the temperature jump needed to reach `217 °C`. Ground pads flow smoothly, and larger ceramic capacitors (**`0805` and up**) avoid **MLCC thermal shock cracking** — rapid heating (`> 150 K/s` from room temperature) cracks ceramic layers internally and creates sneaky **leaky shorts**.
2. **Melt every pin before lifting:** With **Hot air (`H`)**, circle evenly until *all* joints are visibly molten before lifting with tweezers or **Desolder wick (`4`)**. Pulling while one corner is still solid rips pads off the board.
3. **Watch airflow near tiny passives:** Strong hot-air flow easily blows away molten `0402` or `0201` resistors and capacitors (`< 0.6 mm²`) beside the target chip — or flips them upright (**tombstoning**).

## Practice rework on the bench

- [Cold Joint 101 — Flipping the board and reflowing a dull joint](./app.html?board=builtin-tut-cold-joint&tutorial=1)
- [Solder Bridge 101 — Clearing bridged LED pads with Desolder wick](./app.html?board=builtin-tut-solder-bridge&tutorial=1)
- [Bridge Troll — Fixing both a cold joint and a solder bridge on one board](./app.html?board=builtin-bridge-troll)
- [Backwards Day — Rotating a reversed part, swapping a resistor, and fixing a bottom trace](./app.html?board=builtin-backwards-day)
- [Smoke Test — Wicking a back-side short, flipping a diode, and replacing a blown fuse](./app.html?board=builtin-smoke-test)
