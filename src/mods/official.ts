// Official mods: what ships with the app, listed under the same ids, versions and item addresses
// as community mods, so a community mod can `require` and patch them (docs/MOD_PLATFORM.md).
// They are always on. Ids starting with "official-" are reserved for them.
//
// Versions: raise MAJOR when a change could break community mods that patch or build on the items
// (an item removed or renamed, a field's meaning changed). Adding items is a MINOR change.
import { tk } from '../i18n';

export interface OfficialMod { id: string; name: string; version: string; description: string }

export const OFFICIAL_BOARDS = 'official-boards';

export const OFFICIAL_MODS: readonly OfficialMod[] = [
  {
    id: OFFICIAL_BOARDS,
    name: tk('Official boards'),
    version: '1.0.0',
    description: tk('The tutorials, repair challenges and open-hardware demo boards that ship with PurpleBoard.'),
  },
  {
    id: 'official-solvers',
    name: tk('Official solvers'),
    version: '1.0.0',
    description: tk('The circuit solvers (Fast DC, SPICE, SPICE + PWR) and the device library of datasheet-fitted semiconductor models.'),
  },
  {
    id: 'official-faults',
    name: tk('Official faults'),
    version: '1.0.0',
    description: tk('The fault catalogue: shorts, leaks, drift, cold joints, broken copper and intermittents, with severity ranges from repair practice.'),
  },
  {
    id: 'official-importers',
    name: tk('Official importers'),
    version: '1.0.0',
    description: tk('Board files the app reads: KiCad layouts (.kicad_pcb), boardviews (.brd, .tvw) and PurpleBoard challenges (.pcbfix.json).'),
  },
  {
    id: 'official-rules',
    name: tk('Official rules'),
    version: '1.0.1',
    description: tk('Diagnostic rules for «Where to look?»: from what the bench shows (a dead rail, a short, a hot part, a dark LED) to the parts worth measuring first.'),
  },
  {
    id: 'official-instruments',
    name: tk('Official instruments'),
    version: '1.0.0',
    description: tk('The bench instruments and their profiles: the multimeter (ranges, test currents, input impedance), scope, thermal camera and bench supply.'),
  },
];

export const RESERVED_PREFIX = 'official-';
export const isOfficialId = (id: string) => id.startsWith(RESERVED_PREFIX);

/** Mod id → version of every official mod, for dependency checks. */
export const officialVersions = (): Record<string, string> => Object.fromEntries(OFFICIAL_MODS.map((m) => [m.id, m.version]));

/** Address of a shipped board: its scenario id is its item id. */
export const officialBoardAddress = (scenarioId: string) => `${OFFICIAL_BOARDS}/boards/${scenarioId}`;
