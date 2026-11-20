// Loadouts: named sets of mods that are on. Kept in this browser / app (localStorage).
//
//  - "Official": no community mods at all, read-only. "Reset to official" = switch to it.
//  - "My mods": the default; every installed mod is on unless the player turns it off.
//  - custom loadouts: made with "New loadout" (a copy of the current one), can be deleted.
//
// A loadout stores the mods turned OFF, so a newly installed mod is on everywhere except Official.
// Safe mode (app.html?safe) ignores all of this for one visit and runs with no mods.

export const OFFICIAL = 'official';
export const MY_MODS = 'my-mods';

export interface Loadout { id: string; name: string; off: string[] }
export interface LoadoutStore { active: string; custom: Loadout[] }

const KEY = 'deadboard_loadouts';
interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }
const store = (): KV | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

const fresh = (): LoadoutStore => ({ active: MY_MODS, custom: [{ id: MY_MODS, name: 'My mods', off: [] }] });

export function readLoadouts(kv: KV | null = store()): LoadoutStore {
  let s: LoadoutStore;
  try { s = JSON.parse(kv?.getItem(KEY) ?? 'null') as LoadoutStore; } catch { s = fresh(); }
  if (!s || typeof s !== 'object' || !Array.isArray(s.custom)) s = fresh();
  s.custom = s.custom.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string' && Array.isArray(l.off) && l.id !== OFFICIAL);
  if (!s.custom.some((l) => l.id === MY_MODS)) s.custom.unshift({ id: MY_MODS, name: 'My mods', off: [] });
  if (s.active !== OFFICIAL && !s.custom.some((l) => l.id === s.active)) s.active = MY_MODS;
  return s;
}

export function writeLoadouts(s: LoadoutStore, kv: KV | null = store()) {
  try { kv?.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: choices last until reload */ }
}

const current = (s: LoadoutStore) => s.custom.find((l) => l.id === s.active);

/** Is this community mod on in the active loadout? */
export const isModOn = (s: LoadoutStore, modId: string) => s.active !== OFFICIAL && !current(s)!.off.includes(modId);

/** Turns a mod on or off in the active loadout. In Official this switches to "My mods" first. */
export function setModOn(s: LoadoutStore, modId: string, on: boolean): LoadoutStore {
  const active = s.active === OFFICIAL ? MY_MODS : s.active;
  return {
    active,
    custom: s.custom.map((l) => l.id !== active ? l : { ...l, off: on ? l.off.filter((x) => x !== modId) : [...new Set([...l.off, modId])] }),
  };
}

export const switchLoadout = (s: LoadoutStore, id: string): LoadoutStore =>
  id === OFFICIAL || s.custom.some((l) => l.id === id) ? { ...s, active: id } : s;

/** A new loadout copying the active one (from Official: everything off), made active. */
export function newLoadout(s: LoadoutStore, name: string, allModIds: string[]): LoadoutStore {
  const n = name.trim().slice(0, 40) || 'Loadout';
  let id = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loadout';
  if (id === OFFICIAL || id === MY_MODS || s.custom.some((l) => l.id === id)) {
    let i = 2;
    while (s.custom.some((l) => l.id === `${id}-${i}`)) i++;
    id = `${id}-${i}`;
  }
  const off = s.active === OFFICIAL ? [...allModIds] : [...current(s)!.off];
  return { active: id, custom: [...s.custom, { id, name: n, off }] };
}

/** Deletes a custom loadout ("My mods" stays); the active one falls back to "My mods". */
export function deleteLoadout(s: LoadoutStore, id: string): LoadoutStore {
  if (id === MY_MODS || id === OFFICIAL) return s;
  return { active: s.active === id ? MY_MODS : s.active, custom: s.custom.filter((l) => l.id !== id) };
}

/** Safe mode for this visit: `?safe` in the address. */
export const safeMode = (search: string = typeof location === 'undefined' ? '' : location.search) => new URLSearchParams(search).has('safe');

// ---- safe mode after a failed start ----
// Each start records whether mods ran; a start that finishes clears the record. If the previous
// start ran mods and never finished (a crash or hang, or the tab was closed mid-start), the next
// start runs in safe mode and says why. Starts that never loaded a mod don't count: the mods
// weren't to blame.

const BOOT_KEY = 'deadboard_boot';

/** Call at the start of a visit, before loading mods. True when the last start with mods didn't finish. */
export function bootBegin(kv: KV | null = store()): boolean {
  let crashed = false;
  try {
    crashed = (JSON.parse(kv?.getItem(BOOT_KEY) ?? 'null') as { mods?: boolean } | null)?.mods === true;
    kv?.setItem(BOOT_KEY, JSON.stringify({ mods: false }));
  } catch { /* storage unavailable: no crash detection */ }
  return crashed;
}

/** Call once mods are loaded and running. */
export function bootModsRunning(kv: KV | null = store()) {
  try { kv?.setItem(BOOT_KEY, JSON.stringify({ mods: true })); } catch { /* storage unavailable */ }
}

/** Call when the start finished (or stopped for a reason that isn't a mod's fault). */
export function bootDone(kv: KV | null = store()) {
  try { kv?.removeItem?.(BOOT_KEY); } catch { /* storage unavailable */ }
}
