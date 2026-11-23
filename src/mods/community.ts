// Community mods on deadboard.org: a catalogue the website publishes itself, no account or outside
// service needed to browse or install.
//
//   public/community/index.json   the catalogue (written by `npm run community`, never by hand)
//   public/examples/*.zip         the example mods, listed too
//   public/community/*.zip        mods players submitted, after the maintainer reviewed them
//
// Submitting: the Mods window sends a mod to the maintainer through the feedback route (FormSubmit,
// no account). A small mod travels inside the message (base64, with its SHA-256); a bigger one as a
// link to where its author hosts it. `npm run feedback` saves submitted mods to .feedback/, and
// `npm run community -- --add <zip>` checks one and adds it to the catalogue. Nothing a player
// sends is published until the maintainer adds it and the site is deployed.
import type { ModManifest } from './mods';

export const COMMUNITY_FORMAT = 'deadboard-community/1';
/** The catalogue, relative to the app page (app.html sits at the site root). */
export const COMMUNITY_INDEX = 'community/index.json';
/**
 * Largest mod a submission carries inside the message; bigger ones are sent as a link. Measured on
 * the live site 2026-11-21: FormSubmit accepted a 40 KB mod (≈54 KB once base64-encoded) and
 * refused 52 KB and 256 KB ones with HTTP 500, consistent with a 64 KB limit on what it stores.
 */
export const MAX_SUBMIT_BYTES = 40 * 1024;
/** Largest catalogue download the app accepts. */
export const MAX_COMMUNITY_BYTES = 100 * 1024 * 1024;

/** What a mod brings, counted per item type (for the listing). */
export type Contents = Partial<Record<'boards' | 'puzzles' | 'knowledge' | 'patches' | 'devices' | 'faultTypes' | 'meters' | 'rules', number>>;

export interface CommunityMod {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  license: string;
  /** Path on the site, e.g. "examples/board-notes.zip" or "community/my-mod.zip". */
  file: string;
  size: number;
  sha256: string;
  /** Mod ids (and ranges) it needs; installed first when they're in the catalogue. */
  requires: Record<string, string>;
  contents: Contents;
  /** Has code (runs only with code mods turned on). */
  code: boolean;
  /** One of the example mods that come with the docs. */
  example: boolean;
  /** The bench check when it was added: counts of passed / warned / failed checks. */
  bench: { pass: number; warn: number; fail: number };
}

export interface CommunityIndex { format: typeof COMMUNITY_FORMAT; mods: CommunityMod[] }

const FILE_RE = /^(examples|community)\/[a-z0-9][a-z0-9._-]{0,80}\.zip$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

// the catalogue is our own file, but read it field by field anyway (a bad entry is left out)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

function toEntry(x: unknown): CommunityMod | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Record<string, unknown>;
  const id = str(m.id, 64), file = str(m.file, 120), sha256 = str(m.sha256, 64);
  if (!ID_RE.test(id) || !FILE_RE.test(file) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const requires: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(m.requires))) if (ID_RE.test(k) || k.startsWith('official-')) requires[k] = str(v, 40);
  const contents: Contents = {};
  for (const [k, v] of Object.entries(rec(m.contents))) if (['boards', 'puzzles', 'knowledge', 'patches', 'devices', 'faultTypes', 'meters', 'rules'].includes(k) && int(v)) contents[k as keyof Contents] = int(v);
  const b = rec(m.bench);
  return {
    id, file, sha256, requires, contents,
    name: str(m.name, 120) || id,
    version: str(m.version, 40),
    author: str(m.author, 80),
    description: str(m.description, 2000),
    license: str(m.license, 40),
    size: int(m.size),
    code: m.code === true,
    example: m.example === true,
    bench: { pass: int(b.pass), warn: int(b.warn), fail: int(b.fail) },
  };
}

/** Reads a catalogue; entries that don't parse are left out. */
export function parseIndex(json: unknown): CommunityIndex {
  const j = json as { format?: unknown; mods?: unknown } | null;
  if (!j || j.format !== COMMUNITY_FORMAT || !Array.isArray(j.mods)) throw new Error('not a PurpleBoard community catalogue');
  return { format: COMMUNITY_FORMAT, mods: j.mods.map(toEntry).filter((m): m is CommunityMod => !!m) };
}

type Fetch = typeof fetch;

/** The catalogue the site publishes. `base`: where the app page is (default: this page). */
export async function fetchIndex(base = './', f: Fetch = fetch): Promise<CommunityIndex> {
  const res = await f(`${base}${COMMUNITY_INDEX}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseIndex(await res.json());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A listed mod's .zip, checked against the catalogue (size and SHA-256). */
export async function downloadCommunityMod(m: CommunityMod, base = './', f: Fetch = fetch): Promise<Uint8Array> {
  if (m.size > MAX_COMMUNITY_BYTES) throw new Error(`the file is ${(m.size / 1048576).toFixed(0)} MB; the limit is ${MAX_COMMUNITY_BYTES / 1048576} MB`);
  const res = await f(`${base}${m.file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== m.size || (await sha256Hex(bytes)) !== m.sha256) throw new Error('the file doesn\'t match the catalogue (changed or incomplete download)');
  return bytes;
}

/** What a manifest brings, for the listing. */
export function contentsOf(mf: ModManifest, boards: number): Contents {
  const out: Contents = {};
  const set = (k: keyof Contents, n: number) => { if (n) out[k] = n; };
  set('boards', boards);
  set('puzzles', mf.puzzles.length);
  set('knowledge', mf.knowledge.length);
  set('patches', mf.patches.length);
  set('devices', mf.devices.length);
  set('faultTypes', mf.faultTypes.length);
  set('meters', mf.meters.length);
  set('rules', mf.rules.length);
  return out;
}

// ---------------- submissions ----------------

export const SUBMISSION_TYPE = 'Mod submission';

export interface Submission {
  manifest: Pick<ModManifest, 'id' | 'name' | 'version' | 'license'>;
  /** The mod's .zip; sent inside the message when it is at most MAX_SUBMIT_BYTES. */
  bytes: Uint8Array;
  /** Where the author hosts the .zip (needed when it's too big to send). */
  link: string;
  note: string;
  contact: string;
  /** The bench check's summary line, e.g. "5 passed · 0 warnings · 0 failed". */
  bench: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const validLink = (s: string) => /^https:\/\/[^\s<>"]{3,500}$/.test(s.trim());

/** The message fields for FormSubmit. Throws when there is neither a small enough file nor a link. */
export async function submissionFields(s: Submission): Promise<Record<string, string>> {
  const fits = s.bytes.length > 0 && s.bytes.length <= MAX_SUBMIT_BYTES;
  const link = s.link.trim();
  if (link && !validLink(link)) throw new Error('the link must start with https://');
  if (!fits && !link) throw new Error(`the mod is ${Math.ceil(s.bytes.length / 1024)} kB; the limit for sending it here is ${MAX_SUBMIT_BYTES / 1024} kB. Host the .zip somewhere (a GitHub release, a cloud drive) and send the link.`);
  const { id, name, version, license } = s.manifest;
  return {
    _subject: `[PurpleBoard] Mod submission: ${name} v${version}`.slice(0, 150),
    ...(s.contact.includes('@') && { _replyto: s.contact.trim() }),
    type: SUBMISSION_TYPE,
    mod: `${id} v${version}`,
    name,
    license,
    message: s.note.trim() || '(no note)',
    contact: s.contact.trim() || '(none)',
    bench: s.bench || '(not run)',
    link: link || '(none)',
    size: String(s.bytes.length),
    // last: the file itself, read back by `npm run feedback`
    ...(fits && { sha256: await sha256Hex(s.bytes), modzip: toBase64(s.bytes) }),
  };
}

/** The .zip a submission carries, checked against its SHA-256; null when it only has a link. */
export async function submissionZip(fields: Record<string, string>): Promise<Uint8Array | null> {
  if (fields.type !== SUBMISSION_TYPE || !fields.modzip) return null;
  const bytes = fromBase64(fields.modzip);
  if ((await sha256Hex(bytes)) !== fields.sha256) throw new Error('the mod file arrived damaged (SHA-256 differs)');
  return bytes;
}
