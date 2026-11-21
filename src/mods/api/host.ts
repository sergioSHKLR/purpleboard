// The app's side of the plug-in protocol: starts each code mod through a Transport (the sandbox in
// the app, in-process in tests), keeps what it registered, calls its solvers with a time limit and
// sends it events. A mod that fails to start, answers garbage or runs over its time is stopped
// and marked crashed; the app then falls back to its own solvers.
import type { LoadedMod } from '../mods';
import { createRuntime, type FromRuntime, type ToRuntime } from './runtime';
import type { EventName, Events, ImportOutput, PanelNode, SolveInput, SolveResult } from './types';
import { sanitizePanel } from './panels';

import { API_VERSION, codeProblem } from './version';

export { API_VERSION };

export interface Transport {
  send(m: ToRuntime): void;
  onMessage(fn: (m: unknown) => void): void;
  close(): void;
}
export type TransportFactory = (mod: LoadedMod) => Promise<Transport>;

export interface ModSolverInfo { address: string; modId: string; id: string; name: string; description?: string }
export interface ModImporterInfo extends ModSolverInfo { extensions: string[] }
export interface ModPanelInfo { modId: string; id: string; title: string; content: PanelNode[] }
/** What a mod asks the app to do (ui, storage); the host checks the permission first. */
export type ModRequest = { op: 'ui.zoomTo'; ref: string } | { op: 'ui.highlight'; net: string | number } | { op: 'ui.say'; text: string } | { op: 'board.netsNear'; ref: string; mm: number } | { op: 'storage.get'; key: string } | { op: 'storage.set'; key: string; value: string | null };
export type CodeModState = 'starting' | 'running' | 'crashed' | 'stopped';

interface Running {
  mod: LoadedMod;
  transport: Transport | null;
  state: CodeModState;
  error?: string;
  solvers: Map<string, { name: string; description?: string }>;
  importers: Map<string, { name: string; description?: string; extensions: string[] }>;
  panels: Map<string, { title: string; content: PanelNode[] }>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class CodeModHost {
  private running = new Map<string, Running>();
  private seq = 0;

  constructor(
    private factory: TransportFactory,
    private opts: {
      startMs?: number; solveMs?: number; importMs?: number;
      /** Answers a mod's request (permission already checked). */
      onRequest?: (modId: string, req: ModRequest) => Promise<unknown>;
      /** A mod's panels changed. */
      onPanels?: (modId: string) => void; onLog?: (modId: string, text: string) => void; onCrash?: (modId: string, error: string) => void } = {},
  ) {}

  /** Starts a code mod; resolves when its activate() finished (or rejects with why it couldn't). */
  async start(mod: LoadedMod): Promise<void> {
    const code = mod.manifest.code;
    if (!code) throw new Error('not a code mod');
    this.stop(mod.manifest.id);
    const r: Running = { mod, transport: null, state: 'starting', solvers: new Map(), importers: new Map(), panels: new Map(), pending: new Map() };
    this.running.set(mod.manifest.id, r);
    const src = new TextDecoder().decode(await mod.source.read(code.entry));
    const problem = codeProblem(src);
    if (problem) { r.state = 'crashed'; r.error = problem; throw new Error(problem); }
    const transport = await this.factory(mod);
    if (r.state !== 'starting') { transport.close(); return; } // stopped meanwhile
    r.transport = transport;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.crash(r, `didn't finish starting within ${(this.opts.startMs ?? 5000) / 1000} s`); reject(new Error(r.error)); }, this.opts.startMs ?? 5000);
      transport.onMessage((raw) => {
        const m = raw as FromRuntime;
        if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
        switch (m.t) {
          case 'register':
            if (r.state !== 'starting' || !ID_RE.test(String(m.id)) || typeof m.name !== 'string') break;
            if (m.kind === 'solver') r.solvers.set(m.id, { name: m.name.slice(0, 60), ...(typeof m.description === 'string' && { description: m.description.slice(0, 300) }) });
            if (m.kind === 'importer' && Array.isArray(m.extensions)) {
              const extensions = m.extensions.filter((e) => typeof e === 'string' && /^\.[a-z0-9_.-]{1,20}$/.test(e)).slice(0, 10);
              if (extensions.length) r.importers.set(m.id, { name: m.name.slice(0, 60), extensions, ...(typeof m.description === 'string' && { description: m.description.slice(0, 300) }) });
            }
            break;
          case 'ready':
            if (r.state !== 'starting') break;
            clearTimeout(timer);
            r.state = 'running';
            resolve();
            break;
          case 'fail':
            clearTimeout(timer);
            this.crash(r, String(m.error).slice(0, 500));
            reject(new Error(r.error));
            break;
          case 'result': case 'error': {
            const p = r.pending.get(m.id);
            if (!p) break;
            r.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.t === 'result') p.resolve(m.value); else p.reject(new Error(String(m.error).slice(0, 500)));
            break;
          }
          case 'log':
            this.opts.onLog?.(mod.manifest.id, String(m.text).slice(0, 2000));
            break;
          case 'panel': {
            if (!code.permissions.includes('panel') || !ID_RE.test(String(m.id))) break;
            const prev = r.panels.get(m.id);
            if (!prev && (typeof m.title !== 'string' || r.panels.size >= 4)) break; // a new panel needs a title; four at most
            r.panels.set(m.id, { title: typeof m.title === 'string' ? m.title.slice(0, 80) : prev!.title, content: sanitizePanel(m.content) });
            this.opts.onPanels?.(mod.manifest.id);
            break;
          }
          case 'req': void this.answer(r, m); break;
        }
      });
      transport.send({ t: 'init', modId: mod.manifest.id, version: mod.manifest.version, apiVersion: API_VERSION, permissions: [...code.permissions], code: src });
    });
  }

  /** A mod's request to the app: permission first, then the app answers; the mod gets a 'reply'. */
  private async answer(r: Running, m: { id: number; op: string; args: unknown[] }) {
    const perms = r.mod.manifest.code?.permissions ?? [];
    const reply = (x: { value?: unknown; error?: string }) => { if (r.state === 'running' || r.state === 'starting') r.transport?.send({ t: 'reply', id: m.id, ...x }); };
    const args = Array.isArray(m.args) ? m.args : [];
    let req: ModRequest | null = null;
    if (m.op === 'ui.zoomTo' || m.op === 'ui.highlight' || m.op === 'ui.say') {
      if (!perms.includes('panel')) { reply({ error: `${m.op} needs the "panel" permission` }); return; }
      req = m.op === 'ui.zoomTo' ? { op: m.op, ref: String(args[0]).slice(0, 40) }
        : m.op === 'ui.highlight' ? { op: m.op, net: typeof args[0] === 'number' && Number.isInteger(args[0]) ? args[0] : String(args[0]).slice(0, 200) }
        : { op: m.op, text: String(args[0]).slice(0, 300) };
    } else if (m.op === 'board.netsNear') {
      // read-only, names and gaps only: no permission; the distance is capped so a query stays local
      const mm = Number(args[1]);
      if (!Number.isFinite(mm) || mm < 0) { reply({ error: 'board.netsNear(ref, mm): mm must be a number ≥ 0' }); return; }
      req = { op: m.op, ref: String(args[0]).slice(0, 40), mm: Math.min(mm, 5) };
    } else if (m.op === 'storage.get' || m.op === 'storage.set') {
      if (!perms.includes('storage')) { reply({ error: `${m.op} needs the "storage" permission` }); return; }
      const key = String(args[0]).slice(0, 100);
      req = m.op === 'storage.get' ? { op: m.op, key } : { op: m.op, key, value: args[1] === null ? null : String(args[1]) };
    }
    if (!req || !this.opts.onRequest) { reply({ error: `unknown request ${m.op}` }); return; }
    try { reply({ value: await this.opts.onRequest(r.mod.manifest.id, req) }); } catch (e) { reply({ error: e instanceof Error ? e.message : String(e) }); }
  }

  private crash(r: Running, error: string) {
    if (r.state === 'crashed' || r.state === 'stopped') return;
    r.state = 'crashed';
    r.error = error;
    r.transport?.close();
    r.transport = null;
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error(error)); }
    r.pending.clear();
    r.panels.clear();
    this.opts.onCrash?.(r.mod.manifest.id, error);
  }

  stop(modId: string) {
    const r = this.running.get(modId);
    if (!r) return;
    r.state = 'stopped';
    r.transport?.close();
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error('mod stopped')); }
    this.running.delete(modId);
  }

  stopAll() { for (const id of [...this.running.keys()]) this.stop(id); }

  status(modId: string): { state: CodeModState; error?: string } | null {
    const r = this.running.get(modId);
    return r ? { state: r.state, ...(r.error && { error: r.error }) } : null;
  }

  /** Solvers registered by running code mods. */
  solvers(): ModSolverInfo[] {
    return [...this.running.values()].filter((r) => r.state === 'running').flatMap((r) => [...r.solvers].map(([id, s]) => ({
      address: `${r.mod.manifest.id}/solvers/${id}`, modId: r.mod.manifest.id, id, ...s,
    })));
  }

  /** Importers registered by running code mods. */
  importers(): ModImporterInfo[] {
    return [...this.running.values()].filter((r) => r.state === 'running').flatMap((r) => [...r.importers].map(([id, s]) => ({
      address: `${r.mod.manifest.id}/importers/${id}`, modId: r.mod.manifest.id, id, ...s,
    })));
  }

  /** Runs a mod importer on a file (time limit importMs, default 30 s). */
  importFile(address: string, input: { name: string; bytes: Uint8Array }): Promise<ImportOutput> {
    const [modId, , id] = address.split('/');
    const r = this.running.get(modId);
    if (!r || r.state !== 'running' || !r.transport || !r.importers.has(id)) return Promise.reject(new Error(`importer ${address} isn't running`));
    const callId = ++this.seq;
    return new Promise<ImportOutput>((resolve, reject) => {
      const timer = setTimeout(() => this.crash(r, `the importer took longer than ${(this.opts.importMs ?? 30000) / 1000} s`), this.opts.importMs ?? 30000);
      r.pending.set(callId, { resolve: (v) => resolve(v as ImportOutput), reject, timer });
      r.transport!.send({ t: 'import', id: callId, importer: id, input });
    });
  }

  /** Runs a mod solver; rejects (and stops the mod) when it errs or runs over its time. */
  solve(address: string, input: SolveInput): Promise<SolveResult> {
    const [modId, , id] = address.split('/');
    const r = this.running.get(modId);
    if (!r || r.state !== 'running' || !r.transport || !r.solvers.has(id)) return Promise.reject(new Error(`solver ${address} isn't running`));
    const callId = ++this.seq;
    return new Promise<SolveResult>((resolve, reject) => {
      const timer = setTimeout(() => this.crash(r, `the solver took longer than ${(this.opts.solveMs ?? 10000) / 1000} s`), this.opts.solveMs ?? 10000);
      r.pending.set(callId, { resolve: (v) => resolve(v as SolveResult), reject, timer });
      r.transport!.send({ t: 'solve', id: callId, solver: id, input });
    });
  }

  /** Panels of running code mods. */
  panels(): ModPanelInfo[] {
    return [...this.running.values()].filter((r) => r.state === 'running').flatMap((r) => [...r.panels].map(([id, p]) => ({ modId: r.mod.manifest.id, id, ...p })));
  }

  /** Sends an event to one running code mod (a panel's own buttons and inputs). */
  emitTo<E extends EventName>(modId: string, name: E, payload: Events[E]) {
    const r = this.running.get(modId);
    if (r?.state === 'running') r.transport?.send({ t: 'event', name, payload });
  }

  /** Sends an event to every running code mod. */
  emit<E extends Exclude<EventName, 'panel:action'>>(name: E, payload: Events[E]) {
    for (const r of this.running.values()) if (r.state === 'running') r.transport?.send({ t: 'event', name, payload });
  }
}

/**
 * Runs mods in this thread, without a sandbox: for tests, and for an author checking their own mod
 * on their own machine. Never for mods from other people.
 */
export function inProcessTransport(loadModule: (code: string) => Promise<{ default?: unknown }>): TransportFactory {
  return async () => {
    let toHost: ((m: unknown) => void) | null = null;
    let closed = false;
    const rt = createRuntime((m) => queueMicrotask(() => { if (!closed) toHost?.(structuredClone(m)); }), loadModule);
    return {
      send: (m) => queueMicrotask(() => { if (!closed) void rt(structuredClone(m)); }),
      onMessage: (fn) => { toHost = fn; },
      close: () => { closed = true; },
    };
  };
}
