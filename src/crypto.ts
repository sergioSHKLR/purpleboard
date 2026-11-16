// CTF flag locking. The flag is AES-GCM encrypted with a key derived from the
// canonical topology of the *repaired* board, so it can only be decrypted once the
// player's board is electrically identical to the author's reference design.
import type { Board, FlagLock } from './types';
import { pinNet, padNet, type Conn } from './connectivity';
import { MODELED, SYMMETRIC } from './model';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

/**
 * Canonical description of how part pins are wired together. Independent of
 * trace geometry, so any electrically-equivalent repair (blob, jumper, rework)
 * produces the same string. Part values are deliberately excluded; objectives check those.
 * Fault state that is not wiring (damage, leaks, drift, intermittents) adds a token per part,
 * so a fault the objectives happen not to expose still has to be repaired.
 */
export function topology(board: Board, conn: Conn, id: string): string {
  const groups = new Map<number, string[]>();
  const tokens: string[] = [];
  const put = (net: number, label: string) => {
    if (net < 0) return;
    let g = groups.get(net);
    if (!g) groups.set(net, (g = []));
    g.push(label);
  };
  for (const c of board.components) {
    if (!c.state.populated) continue;
    if (MODELED.has(c.kind) || c.kind === 'testpoint') {
      for (const role of Object.keys(c.pins)) put(pinNet(conn, c, role), SYMMETRIC.has(c.kind) ? `${c.ref}.~` : `${c.ref}.${role}`);
    } else {
      for (const name of new Set(c.pads.map((p) => p.name))) {
        const pi = c.pads.findIndex((p) => p.name === name);
        if (c.state.cold.includes(pi)) continue;
        put(padNet(conn, c, name), `${c.ref}.${name}`);
      }
    }
    if (c.state.burnt) tokens.push(`${c.ref}!X`);
    // Faults that leave the wiring intact but must still be repaired. Intermittents count
    // even while dormant: verification runs at ambient with no flex, where they may conduct.
    if (c.state.leak || c.state.intermittent?.some((f) => f.kind === 'thermal-leak')) tokens.push(`${c.ref}!L`);
    if (c.state.drift !== undefined && c.state.drift !== 1) tokens.push(`${c.ref}!D`);
    if (c.state.intermittent?.some((f) => f.kind !== 'thermal-leak')) tokens.push(`${c.ref}!I`);
  }
  const lines = [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort().join(',')).sort();
  return `${id}\n${lines.join('\n')}\n#${tokens.sort().join(',')}`;
}

async function keyFor(topo: string, salt: Uint8Array): Promise<CryptoKey> {
  const t = enc.encode(topo);
  const buf = new Uint8Array(salt.length + t.length);
  buf.set(salt); buf.set(t, salt.length);
  const raw = await crypto.subtle.digest('SHA-256', buf);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function lockFlag(flag: string, topo: string): Promise<FlagLock> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(topo, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(flag)));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function unlockFlag(lock: FlagLock, topo: string): Promise<string | null> {
  try {
    const key = await keyFor(topo, unb64(lock.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(lock.iv) }, key, unb64(lock.ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export async function shortHash(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function pipe(data: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function packText(s: string): Promise<string> {
  return b64url(await pipe(enc.encode(s) as Uint8Array<ArrayBuffer>, new CompressionStream('deflate-raw')));
}

export async function unpackText(s: string): Promise<string> {
  return dec.decode(await pipe(unb64url(s), new DecompressionStream('deflate-raw')));
}
