# Open-hardware demo boards

DEADBOARD ships two real, open-source boards as repair challenges. They live in
`public/demos/` (served as `demos/`), are listed in `demos/index.json`, and are fetched only
when a player opens them. Attribution and licence are shown in the Overview tab and in
`public/demos/NOTICE.txt`; full licence texts are in `public/demos/licenses/`.

| Demo | Board | Licence | Faults | Solver |
|---|---|---|---|---|
| `demo-mnt-reform2-mb30` | MNT Reform 2 motherboard rev 3.0 (laptop mainboard, 529 parts) | CERN-OHL-S-2.0 | dead-short MLCC on +3V3 (C173), liquid residue at C97 | SPICE + PWR |
| `demo-antmicro-jetson-nano-bb` | Antmicro Jetson Nano / Xavier NX baseboard (392 parts) | Apache-2.0 | damaged 3.3 V regulator (U2), press-sensitive cracked joint at FB1 | SPICE + PWR |

## Rebuilding

```bash
npm run demos -- --fetch          # sparse-clones the pinned upstream commits into a temp dir
npm run demos -- --src <dir>      # or: <dir>/<demo id>/ holds a checkout of each repository
```

`scripts/build-demos.ts` holds the definitions (pinned repo + commit, faults, objectives, flag).
For every demo it checks that the healthy board passes its objectives, that the faulted board
fails, and that the intended repair passes and unlocks the flag — a demo cannot ship unsolvable.
`test/demos.test.ts` checks the shipped files (attribution, licence, solver, broken on arrival).

## Licensing notes (not legal advice)

- **Apache-2.0** (Antmicro): keep the licence and copyright notice; state the changes (NOTICE.txt does).
- **CERN-OHL-S-2.0** (MNT): the modified design (the demo JSON) stays under CERN-OHL-S-2.0 and its
  source must be available — the JSON itself, the build script and the pinned upstream design.
  This covers the board data, not DEADBOARD's own code.
- Use board and project names descriptively, without implying endorsement ("Jetson" is NVIDIA's mark).

## Adding a board

Good candidates are KiCad designs (any version) under an open licence, with named power rails.
The importer finds the power tree and a bench-supply point automatically; inner-layer planes,
thermal reliefs, `dnp` parts and ESD/TVS parts are handled. Add an entry to `DEMOS` in
`scripts/build-demos.ts` and run it: the script refuses boards whose healthy state fails.
