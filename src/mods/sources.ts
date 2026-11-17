// Where mods come from:
//  - "Installed": .zip files the player added in the app, kept in IndexedDB (web and desktop).
//  - "Mods folder": the desktop app's <userData>/mods folder, listed by the shell at ./mods/index.json
//    (folders and .zip files). The website has no such folder.
import { loadMod, zipSource, type LoadedMod, type ModSource } from './mods';

/** Bridge exposed by desktop/preload.cjs (absent on the website). */
export interface DesktopBridge {
  openModsFolder(): Promise<string>;
}
export const desktop = (globalThis as { deadboardDesktop?: DesktopBridge }).deadboardDesktop;

// ---------------- installed (IndexedDB) ----------------

const DB = 'deadboard-mods';
const STORE = 'packages';
interface StoredMod { id: string; file: string; bytes: Uint8Array; installed: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

/** Checks a mod .zip and stores it (same id = update). Returns the loaded mod. */
export async function installMod(bytes: Uint8Array, file: string, takenIds?: (id: string) => boolean): Promise<LoadedMod> {
  const mod = await loadMod(await zipSource(bytes, file, 'Installed'), takenIds);
  await tx('readwrite', (s) => s.put({ id: mod.manifest.id, file, bytes, installed: Date.now() } satisfies StoredMod));
  return mod;
}

export async function removeInstalled(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

async function installedSources(): Promise<ModSource[]> {
  if (typeof indexedDB === 'undefined') return [];
  const all = await tx<StoredMod[]>('readonly', (s) => s.getAll() as IDBRequest<StoredMod[]>);
  const out: ModSource[] = [];
  for (const m of all.sort((a, b) => a.installed - b.installed)) {
    try { out.push(await zipSource(m.bytes, m.file, 'Installed')); } catch { /* damaged entry: skipped, shown by the manager as failed */ }
  }
  return out;
}

// ---------------- desktop mods folder ----------------

interface FolderIndex { folder: string; mods: ({ name: string; kind: 'dir'; files: string[] } | { name: string; kind: 'zip' })[] }

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The desktop mods folder's path (for the manager), or null on the website. */
export let modsFolderPath: string | null = null;

async function folderSources(): Promise<ModSource[]> {
  if (!desktop) return [];
  const res = await fetch('./mods/index.json');
  if (!res.ok) return [];
  const idx = (await res.json()) as FolderIndex;
  modsFolderPath = idx.folder;
  const out: ModSource[] = [];
  for (const m of idx.mods) {
    const base = `./mods/${encodeURIComponent(m.name)}`;
    if (m.kind === 'zip') {
      try { out.push(await zipSource(await fetchBytes(base), m.name, 'Mods folder')); } catch { /* reported by loadAllMods */ }
    } else {
      out.push({ origin: 'Mods folder', name: m.name, files: m.files, read: (p) => fetchBytes(`${base}/${enc(p)}`) });
    }
  }
  return out;
}

export interface ModLoadResult {
  mods: LoadedMod[];
  /** Mods that could not be loaded at all: where + why. */
  failed: { name: string; origin: string; error: string }[];
}

/** Loads every mod (mods folder first, then installed). Board ids already in use are skipped. */
export async function loadAllMods(takenIds: (id: string) => boolean): Promise<ModLoadResult> {
  const result: ModLoadResult = { mods: [], failed: [] };
  const sources = [
    ...(await folderSources().catch(() => [])),
    ...(await installedSources().catch(() => [])),
  ];
  const modIds = new Set<string>();
  const taken = new Set<string>();
  const isTaken = (id: string) => taken.has(id) || takenIds(id);
  for (const src of sources) {
    try {
      const mod = await loadMod(src, isTaken);
      if (modIds.has(mod.manifest.id)) {
        result.failed.push({ name: src.name, origin: src.origin, error: `another mod with id "${mod.manifest.id}" is already loaded` });
        continue;
      }
      modIds.add(mod.manifest.id);
      for (const b of mod.boards) taken.add(b.stub.id);
      result.mods.push(mod);
    } catch (e) {
      result.failed.push({ name: src.name, origin: src.origin, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
