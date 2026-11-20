// Which installed mods actually run: the player's loadout says which are on, then dependencies
// (`requires`) and `conflicts` decide which of those can run. A mod whose dependency is missing,
// the wrong version or itself blocked is "blocked" and says what to install; nothing half-loads.
// Active mods come out in dependency order (a mod after the mods it requires), so later layers
// (patches, docs/MOD_PLATFORM.md) can apply in that order.
import type { LoadedMod } from './mods';
import { coerceVersion, parseVersion, satisfies, type Version } from './semver';

export interface ModNeed {
  /** The mod id that is needed. */
  id: string;
  range: string;
  /** Installed version, when a mod with that id is installed (wrong version, or turned off / blocked). */
  have?: string;
  why: 'missing' | 'version' | 'off' | 'blocked';
}

export type ModStatus =
  | { state: 'active' }
  | { state: 'off' }
  | { state: 'blocked'; needs: ModNeed[]; conflicts: string[] };

export interface Resolved {
  /** Mods that run, dependencies first. */
  active: LoadedMod[];
  status: Map<string, ModStatus>;
}

/** /2 mods have strict versions; a /1 version is read leniently ("2" = 2.0.0). */
export const modVersion = (m: LoadedMod): Version | null => parseVersion(m.manifest.version) ?? coerceVersion(m.manifest.version);

/** `provided`: mods that are always there (the official ones), id → version. */
export function resolveMods(mods: LoadedMod[], isOn: (id: string) => boolean, provided: Record<string, string> = {}): Resolved {
  const byId = new Map(mods.map((m) => [m.manifest.id, m]));
  const status = new Map<string, ModStatus>();
  const live = new Set<string>();
  for (const m of mods) {
    if (isOn(m.manifest.id)) live.add(m.manifest.id);
    else status.set(m.manifest.id, { state: 'off' });
  }

  // drop mods whose needs aren't met until nothing changes (a blocked dependency blocks its users)
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...live]) {
      const m = byId.get(id)!;
      const needs: ModNeed[] = [];
      for (const [dep, range] of Object.entries(m.manifest.requires)) {
        if (provided[dep] !== undefined) {
          const pv = parseVersion(provided[dep]);
          if (!pv || !satisfies(pv, range)) needs.push({ id: dep, range, have: provided[dep], why: 'version' });
          continue;
        }
        const d = byId.get(dep);
        if (!d) { needs.push({ id: dep, range, why: 'missing' }); continue; }
        const v = modVersion(d);
        const have = d.manifest.version;
        if (!v || !satisfies(v, range)) needs.push({ id: dep, range, have, why: 'version' });
        else if (!live.has(dep)) needs.push({ id: dep, range, have, why: status.get(dep)?.state === 'off' ? 'off' : 'blocked' });
      }
      // a conflict counts only while the other mod runs, in a matching version
      const conflicts = Object.entries(m.manifest.conflicts)
        .filter(([dep, range]) => { const d = byId.get(dep); const v = d && modVersion(d); return live.has(dep) && !!v && satisfies(v, range); })
        .map(([dep]) => dep);
      if (needs.length || conflicts.length) {
        live.delete(id);
        status.set(id, { state: 'blocked', needs, conflicts });
        changed = true;
      }
    }
  }

  // dependency order; ties (and dependency cycles) keep the install order
  const active: LoadedMod[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (id: string) => {
    if (placed.has(id) || visiting.has(id) || !live.has(id)) return;
    visiting.add(id);
    for (const dep of Object.keys(byId.get(id)!.manifest.requires)) place(dep);
    visiting.delete(id);
    placed.add(id);
    active.push(byId.get(id)!);
    status.set(id, { state: 'active' });
  };
  for (const m of mods) place(m.manifest.id);
  return { active, status };
}
