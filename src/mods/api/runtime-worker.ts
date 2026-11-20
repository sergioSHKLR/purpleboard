// Entry of the sandbox worker (bundled into one script by the mod-runtime plugin in vite.config.ts
// and started from a blob inside the sandboxed iframe, see sandbox.ts). It takes the message port
// to the app, then loads the mod: as a **classic script** through importScripts (which the frame's
// Content-Security-Policy governs), never as an ES module. Module loading is how code escaped the
// sandbox in Chrome: a classic worker's import() — and the static `export … from` dependencies of
// an imported module — fetch URLs the CSP forbids. A classic script can't contain module syntax at
// all; the mod's one `export default` is rewritten to an assignment before it loads, and sources
// with the word `import` or any other export are refused (version.ts codeProblem).
//
// Order: the blob URL is made and importScripts captured, then everything a mod must not use is
// removed (also from the prototypes), then the script runs. So the mod can't make blob: URLs or
// load scripts of its own.
import { createRuntime } from './runtime';
import { EXPORT_DEFAULT, codeProblem } from './version';

const g = self as unknown as Record<string, unknown>;

function remove(obj: unknown, keys: string[]) {
  if (!obj) return;
  for (const k of keys) {
    try { delete (obj as Record<string, unknown>)[k]; } catch { /* not configurable */ }
    try { if (k in (obj as object)) Object.defineProperty(obj, k, { value: undefined, writable: false, configurable: false }); } catch { /* CSP still applies */ }
  }
}

function lockdown(permissions: string[]) {
  const network = permissions.some((p) => p.startsWith('network:'));
  const always = ['importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'RTCPeerConnection', 'Notification', 'requestFileSystem', 'webkitRequestFileSystem', 'webkitRequestFileSystemSync'];
  const net = network ? [] : ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport'];
  // own properties of the global, and the prototypes they are inherited from
  for (let o: unknown = g; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) remove(o, [...always, ...net]);
  remove((g.URL as { prototype?: unknown } | undefined), ['createObjectURL']);
  remove(g.URL, ['createObjectURL']);
  remove((g.navigator as object | undefined), ['serviceWorker', 'storage', 'locks']);
}

const revoke = URL.revokeObjectURL.bind(URL);
const ACTIVATE = '__deadboardActivate';

async function loadModule(code: string, permissions: string[]): Promise<{ default?: unknown }> {
  const problem = codeProblem(code); // also checked by the runtime and the host; this is the loader's own guard
  if (problem) throw new Error(problem);
  // `export default function activate(…)` → a plain declaration (a classic script makes it a global);
  // anything else after `export default` → an assignment to a known global
  const named = /\bexport\s+default\s+((?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*))/.exec(code);
  const script = named ? code.replace(named[0], named[1]) : code.replace(EXPORT_DEFAULT, `self.${ACTIVATE} =`);
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  const load = (self as unknown as { importScripts: (u: string) => void }).importScripts.bind(self);
  lockdown(permissions); // from here on the mod can't make blob: URLs, load scripts or reach removed APIs
  try {
    load(url);
  } catch (e) {
    throw new Error(`the code doesn't run as one script: ${e instanceof Error ? e.message : e}`);
  } finally {
    revoke(url);
  }
  const activate = g[ACTIVATE] ?? (named ? g[named[2]] : undefined);
  delete g[ACTIVATE];
  return { default: activate };
}

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!port || (e.data as { t?: string })?.t !== 'port') return;
  self.onmessage = null; // the port is the only channel from now on
  const receive = createRuntime((m) => port.postMessage(m), loadModule);
  port.onmessage = (ev) => { void receive(ev.data); };
};
