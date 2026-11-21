// The code-mod runtime: runs next to one mod's code (inside the sandbox worker in the app, or
// in-process in tests) and speaks the plug-in protocol with the host. It builds the `api` object
// the mod's activate(api) receives, keeps the mod's registrations and event handlers, and answers
// solve calls. Everything it sends is plain data.
import type { Activate, EventName, Events, ImporterDef, ModApi, Netlist, PanelDef, PanelNode, SolverDef } from './types';
import { makeQueries, type QueryState } from './queries';
import { codeProblem } from './version';

/** Host → runtime. */
export type ToRuntime =
  | { t: 'init'; modId: string; version: string; apiVersion: string; permissions: string[]; code: string }
  | { t: 'solve'; id: number; solver: string; input: unknown }
  | { t: 'import'; id: number; importer: string; input: { name: string; bytes: Uint8Array } }
  | { t: 'event'; name: string; payload: unknown }
  | { t: 'reply'; id: number; value?: unknown; error?: string };
/** Runtime → host. */
export type FromRuntime =
  | { t: 'register'; kind: 'solver'; id: string; name: string; description?: string }
  | { t: 'register'; kind: 'importer'; id: string; name: string; description?: string; extensions: string[] }
  | { t: 'ready' }
  | { t: 'fail'; error: string }
  | { t: 'result'; id: number; value: unknown }
  | { t: 'error'; id: number; error: string }
  | { t: 'log'; text: string }
  | { t: 'panel'; id: string; title?: string; content: PanelNode[] }
  | { t: 'req'; id: number; op: RequestOp; args: unknown[] };

type RequestOp = 'ui.zoomTo' | 'ui.highlight' | 'ui.say' | 'storage.get' | 'storage.set' | 'board.netsNear';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const show = (x: unknown) => {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
};

/**
 * `send` posts to the host; `loadModule` turns the mod's source into its module namespace (in the
 * sandbox it also locks the worker down first, given the permissions). Sources containing the word
 * `import` are refused here too (see codeProblem).
 */
export function createRuntime(send: (m: FromRuntime) => void, loadModule: (code: string, permissions: string[]) => Promise<{ default?: unknown }>) {
  const solvers = new Map<string, SolverDef>();
  const importers = new Map<string, ImporterDef>();
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const state: QueryState = { netlist: null, volts: null };
  let started = false, ready = false;
  const panelIds = new Set<string>();
  // requests to the app (ui, storage): answered by a 'reply'
  let reqSeq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const request = (op: RequestOp, args: unknown[]) => new Promise<unknown>((resolve, reject) => {
    const id = ++reqSeq;
    waiting.set(id, { resolve, reject });
    send({ t: 'req', id, op, args });
  });

  const remember = (input: unknown) => {
    const nl = (input as { netlist?: Netlist })?.netlist;
    if (nl && Array.isArray(nl.parts) && Array.isArray(nl.nets)) state.netlist = nl;
  };

  return async function receive(m: ToRuntime) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'init') {
      if (started) return;
      started = true;
      const api: ModApi = {
        apiVersion: m.apiVersion,
        mod: { id: m.modId, version: m.version, permissions: [...m.permissions] },
        register: {
          solver(id: string, def: SolverDef) {
            if (ready) { send({ t: 'log', text: `register.solver("${id}") after activate() finished: ignored` }); return; }
            if (!ID_RE.test(id) || !def || typeof def.solve !== 'function' || typeof def.name !== 'string') throw new Error('register.solver(id, { name, solve }): id in lowercase letters, digits, ".", "-", "_"');
            solvers.set(id, def);
            send({ t: 'register', kind: 'solver', id, name: def.name.slice(0, 60), ...(typeof def.description === 'string' && { description: def.description.slice(0, 300) }) });
          },
          importer(id: string, def: ImporterDef) {
            if (ready) { send({ t: 'log', text: `register.importer("${id}") after activate() finished: ignored` }); return; }
            const exts = Array.isArray(def?.extensions) ? def.extensions.filter((e) => typeof e === 'string' && /^\.[a-z0-9_.-]{1,20}$/.test(e)) : [];
            if (!ID_RE.test(id) || !def || typeof def.read !== 'function' || typeof def.name !== 'string' || !exts.length) throw new Error('register.importer(id, { name, extensions: [".ext"], read }): extensions in lowercase with the dot');
            importers.set(id, def);
            send({ t: 'register', kind: 'importer', id, name: def.name.slice(0, 60), extensions: exts.slice(0, 10), ...(typeof def.description === 'string' && { description: def.description.slice(0, 300) }) });
          },
          panel(id: string, def: PanelDef) {
            if (!m.permissions.includes('panel')) throw new Error('register.panel needs the "panel" permission in mod.json');
            if (!ID_RE.test(id) || !def || typeof def.title !== 'string') throw new Error('register.panel(id, { title, content })');
            panelIds.add(id);
            send({ t: 'panel', id, title: def.title.slice(0, 80), content: Array.isArray(def.content) ? def.content : [] });
          },
        },
        panels: {
          set(id: string, content: PanelNode[]) {
            if (!panelIds.has(id)) throw new Error(`panels.set("${id}"): register the panel first`);
            send({ t: 'panel', id, content: Array.isArray(content) ? content : [] });
          },
        },
        ui: {
          zoomTo: (ref: string) => request('ui.zoomTo', [String(ref)]) as Promise<boolean>,
          highlight: (net: string | number) => request('ui.highlight', [typeof net === 'number' ? net : String(net)]) as Promise<boolean>,
          say: async (text: string) => { await request('ui.say', [String(text)]); },
        },
        storage: {
          get: (key: string) => request('storage.get', [String(key)]) as Promise<string | null>,
          set: async (key: string, value: string | null) => { await request('storage.set', [String(key), value === null ? null : String(value)]); },
        },
        on<E extends EventName>(event: E, handler: (payload: Events[E]) => void) {
          if (typeof handler !== 'function') return;
          handlers.set(event, [...(handlers.get(event) ?? []), handler as (p: unknown) => void]);
        },
        queries: makeQueries(state),
        board: {
          netsNear: (ref: string, mm: number) => request('board.netsNear', [String(ref), Number(mm)]) as Promise<{ net: string | number; mm: number; pad: string }[]>,
        },
        log: (...args: unknown[]) => send({ t: 'log', text: args.map(show).join(' ').slice(0, 2000) }),
      };
      try {
        const problem = codeProblem(m.code);
        if (problem) throw new Error(problem);
        const mod = await loadModule(m.code, m.permissions);
        const activate = mod?.default;
        if (typeof activate !== 'function') throw new Error('the module must have a default export: export default function activate(api) { … }');
        await (activate as Activate)(api);
        ready = true;
        send({ t: 'ready' });
      } catch (e) {
        send({ t: 'fail', error: e instanceof Error ? e.message : show(e) });
      }
      return;
    }
    if (m.t === 'solve') {
      const def = solvers.get(m.solver);
      if (!def) { send({ t: 'error', id: m.id, error: `no solver "${m.solver}"` }); return; }
      remember(m.input);
      try {
        const value = await def.solve(m.input as never);
        send({ t: 'result', id: m.id, value });
      } catch (e) {
        send({ t: 'error', id: m.id, error: e instanceof Error ? e.message : show(e) });
      }
      return;
    }
    if (m.t === 'reply') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(m.error)); else w.resolve(m.value);
      return;
    }
    if (m.t === 'import') {
      const def = importers.get(m.importer);
      if (!def) { send({ t: 'error', id: m.id, error: `no importer "${m.importer}"` }); return; }
      try {
        const value = await def.read(m.input);
        send({ t: 'result', id: m.id, value });
      } catch (e) {
        send({ t: 'error', id: m.id, error: e instanceof Error ? e.message : show(e) });
      }
      return;
    }
    if (m.t === 'event') {
      if (m.name === 'board:loaded') { remember(m.payload); state.volts = null; }
      if (m.name === 'power:changed') {
        const p = m.payload as Events['power:changed'];
        state.volts = p?.on && p.nets ? new Map(Object.entries(p.nets)) : null;
      }
      for (const h of handlers.get(m.name) ?? []) {
        try { h(m.payload); } catch (e) { send({ t: 'log', text: `${m.name} handler failed: ${e instanceof Error ? e.message : show(e)}` }); }
      }
    }
  };
}
