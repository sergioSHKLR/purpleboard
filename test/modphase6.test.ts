// Mod platform, phase 6 (docs/MOD_PLATFORM.md): panels (declarative, sanitised), UI requests and
// storage behind permissions, panel events to the owning mod only, bench events, and the local
// coach example end to end against a fake OpenAI-compatible server: context sent, answer shown,
// part names the board doesn't have removed (grounding). In-process here; the sandbox, the
// network permission and the Mods tab are checked in Chrome.
import { loadMod, parseManifest, type LoadedMod, type ModSource } from '../src/mods/mods';
import { CodeModHost, inProcessTransport, type ModRequest } from '../src/mods/api/host';
import { sanitizePanel } from '../src/mods/api/panels';
import { buildNetlist } from '../src/mods/api/netlist';
import { buildConnectivity } from '../src/connectivity';
import { builtinScenarios } from '../src/scenarios/builtin';
import type { PanelNode } from '../src/mods/api/types';
import { readZip } from '../src/mods/zip';

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
interface Fs { readFileSync(p: string, enc?: string): Uint8Array & string; readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] }
interface Http { createServer(fn: (req: { method: string; url: string; on(e: string, f: (c?: Uint8Array) => void): void }, res: { writeHead(s: number, h: Record<string, string>): void; end(b?: string): void }) => void): { listen(p: number, h: string, cb: () => void): void; address(): { port: number }; close(): void } }
let fs: Fs;
const te = new TextEncoder();
const load = (code: string) => import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`) as Promise<{ default?: unknown }>;
const mem = (id: string, js: string, permissions: string[]): Promise<LoadedMod> => {
  const files: Record<string, string> = { 'mod.json': JSON.stringify({ format: 'deadboard-mod/2', id, name: id, version: '1.0.0', license: 'MIT', code: { entry: 'main.js', api: '^1', permissions } }), 'main.js': js };
  const src: ModSource = { origin: 'test', name: id, files: Object.keys(files), read: async (p) => te.encode(files[p]) };
  return loadMod(src);
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await tick(10); } return true; };

async function run() {
  const fsName = 'node:fs', httpName = 'node:http'; // through variables, as in the other suites (no Node types here)
  fs = (await import(/* @vite-ignore */ fsName)) as Fs;
  const http = (await import(/* @vite-ignore */ httpName)) as unknown as Http;

  // ---- manifest + sanitising ----
  {
    const mf = parseManifest(JSON.stringify({ format: 'deadboard-mod/2', id: 'p1', name: 'P', version: '1.0.0', license: 'MIT', code: { entry: 'main.js', api: '^1', permissions: ['panel', 'storage', 'network:localhost'] } }));
    assert(mf.code?.permissions.join() === 'panel,storage,network:localhost', 'panel and storage are real permissions now');
    const long = 'x'.repeat(20000);
    const s = sanitizePanel([
      { type: 'text', text: long, tone: 'evil' }, { type: 'script', text: 'x' }, { type: 'button', id: 'Bad Id', label: 'x' },
      { type: 'input', id: 'q', submit: 'Go', value: 5 }, { type: 'row', children: [{ type: 'row', children: [{ type: 'row', children: [{ type: 'row', children: [{ type: 'text', text: 'deep' }] }] }] }] },
      ...Array.from({ length: 400 }, () => ({ type: 'divider' })),
    ]);
    const text = s[0] as Extract<PanelNode, { type: 'text' }>;
    assert(text.text.length === 8000 && text.tone === undefined, 'text clipped, unknown tone dropped');
    assert(!s.some((n) => (n as { type: string }).type === 'script') && !s.some((n) => n.type === 'button'), 'unknown nodes and bad ids dropped');
    assert(s.some((n) => n.type === 'input' && n.id === 'q' && n.value === undefined), 'input kept, bad value dropped');
    assert(s.length <= 300 && JSON.stringify(s).includes('"row"') && !JSON.stringify(s).includes('deep'), 'node budget and depth capped');
  }

  // ---- permissions, requests, panel events ----
  {
    const asked: string[] = [];
    const store = new Map<string, string>();
    const panelsChanged: string[] = [];
    const host = new CodeModHost(inProcessTransport(load), {
      onLog: () => {},
      onPanels: (id) => panelsChanged.push(id),
      onRequest: async (id, req: ModRequest) => {
        asked.push(`${id}:${req.op}`);
        if (req.op === 'storage.get') return store.get(`${id}/${req.key}`) ?? null;
        if (req.op === 'storage.set') { store.set(`${id}/${req.key}`, req.value ?? ''); return null; }
        if (req.op === 'ui.zoomTo') return req.ref === 'R1';
        return null;
      },
    });
    let refused = '';
    try { await host.start(await mem('no-perm', "export default function activate(api) { api.register.panel('p', { title: 'P' }); }", [])); } catch (e) { refused = String(e); }
    assert(/needs the "panel" permission/.test(refused), 'register.panel needs the permission');

    const sneaky = await mem('sneaky', `export default async function activate(api) {
      let r1 = 'ok', r2 = 'ok';
      try { await api.ui.say('hi'); } catch (e) { r1 = e.message; }
      try { await api.storage.get('k'); } catch (e) { r2 = e.message; }
      api.log(r1 + ' | ' + r2);
    }`, []);
    const logs: string[] = [];
    const h2 = new CodeModHost(inProcessTransport(load), { onLog: (_, t) => logs.push(t), onRequest: async () => 'leak' });
    await h2.start(sneaky);
    assert(/ui\.say needs the "panel" permission \| storage\.get needs the "storage" permission/.test(logs.join()), `requests without permission refused by the host (${logs.join()})`);
    h2.stopAll();

    const good = await mem('good', `export default async function activate(api) {
      api.register.panel('main', { title: 'Main', content: [{ type: 'text', text: 'hello' }] });
      await api.storage.set('k', 'v1');
      const back = await api.storage.get('k');
      const zoom = await api.ui.zoomTo('R1');
      const none = await api.ui.zoomTo('Q9');
      api.on('panel:action', (p) => api.panels.set('main', [{ type: 'text', text: 'got ' + p.id + '=' + p.value + ' ' + back + ' ' + zoom + ' ' + none }]));
      api.on('bench:solved', (p) => api.panels.set('main', [{ type: 'text', text: 'solved ' + Object.keys(p.nets).length }]));
    }`, ['panel', 'storage']);
    const other = await mem('other', `export default function activate(api) {
      api.register.panel('o', { title: 'Other' });
      api.on('panel:action', () => api.panels.set('o', [{ type: 'text', text: 'WRONG MOD' }]));
    }`, ['panel']);
    await host.start(good);
    await host.start(other);
    assert(host.panels().map((p) => `${p.modId}/${p.id}:${p.title}`).join() === 'good/main:Main,other/o:Other', 'panels listed');
    assert(asked.join() === 'good:storage.set,good:storage.get,good:ui.zoomTo,good:ui.zoomTo', `requests answered (${asked.join()})`);
    host.emitTo('good', 'panel:action', { panel: 'main', id: 'ask', value: 'why?' });
    assert(await until(() => (host.panels()[0].content[0] as { text?: string }).text === 'got ask=why? v1 true false'), 'panel action reached its mod, panel updated');
    assert((host.panels()[1].content[0] as { text?: string } | undefined)?.text !== 'WRONG MOD', 'other mods don\'t get it');
    host.emit('bench:solved', { nets: { VCC: 5, GND: 0 }, parts: {} });
    assert(await until(() => (host.panels()[0].content[0] as { text?: string }).text === 'solved 2'), 'bench events delivered');
    assert(panelsChanged.length >= 3, 'the app hears about panel changes');
    host.stopAll();
  }

  // ---- the local coach, end to end, against a fake OpenAI-compatible server ----
  {
    const seen: { body: { model: string; messages: { role: string; content: string }[] } }[] = [];
    const server = http.createServer((req, res) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      const chunks: Uint8Array[] = [];
      req.on('data', (c) => chunks.push(c!));
      req.on('end', () => {
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
        seen.push({ body: JSON.parse(new TextDecoder().decode(all)) });
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Measure across F1 first, then check U99 and R1.' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const store = new Map<string, string>([['local-coach/settings', JSON.stringify({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'test-model' })]]);
    const dir = 'examples/mods/local-coach';
    const coach = await loadMod({ origin: 'test', name: dir, files: ['mod.json', 'main.js'], read: async (p) => new Uint8Array(fs.readFileSync(`${dir}/${p}`)) });
    assert(coach.manifest.code?.permissions.join() === 'network:localhost,panel,storage', 'coach asks for local network, panel, storage');
    const host = new CodeModHost(inProcessTransport(load), {
      onLog: () => {},
      onRequest: async (id, req) => (req.op === 'storage.get' ? store.get(`${id}/${req.key}`) ?? null : req.op === 'storage.set' ? (store.set(`${id}/${req.key}`, req.value ?? ''), null) : true),
    });
    await host.start(coach);
    const panel = () => host.panels().find((p) => p.modId === 'local-coach')!;
    const texts = () => panel().content.filter((n) => n.type === 'text').map((n) => (n as { text: string }).text).join(' ¦ ');
    assert(await until(() => panel()?.content.some((n) => n.type === 'input' && n.id === 'endpoint' && n.value?.includes(String(port))) ?? false), 'settings loaded from storage');

    const sc = (await builtinScenarios()).find((s) => s.id === 'builtin-ghost-short')!;
    host.emit('board:loaded', { title: sc.meta.title, netlist: buildNetlist(sc.board, buildConnectivity(sc.board), sc.meta.title) });
    host.emit('tests:run', { passed: false, results: [{ label: 'D1 must be ON', passed: false, detail: 'D1 is OFF (0.0 mA)' }] });
    host.emit('bench:solved', { nets: { '+5V': 0.02, VOUT: 0 }, parts: {} });
    await tick();
    host.emitTo('local-coach', 'panel:action', { panel: 'coach', id: 'ask', value: 'Where should I measure next?' });
    assert(await until(() => /Measure across F1/.test(texts()), 5000), `answer shown (${texts()})`);
    assert(/F1 first, then check \[\?\] and R1/.test(texts()) && /Removed 1 part name/.test(texts()), 'U99 (not on the board) removed and counted');
    const body = seen[0].body;
    const user = body.messages.find((m) => m.role === 'user')!.content;
    assert(body.model === 'test-model' && /Board: Ghost Short/.test(user) && /F1 fuse/.test(user) && /D1 must be ON: D1 is OFF/.test(user) && /\+5V 0\.020 V/.test(user) && /Question: Where should I measure next\?/.test(user), 'the board, tests, readings and question were sent');
    assert(/Only name parts/.test(body.messages[0].content), 'system prompt asks for grounding (and the mod enforces it)');

    // model server down: a clear message, no crash
    server.close();
    host.emitTo('local-coach', 'panel:action', { panel: 'coach', id: 'endpoint', value: 'http://127.0.0.1:9/v1/chat/completions' });
    await tick();
    host.emitTo('local-coach', 'panel:action', { panel: 'coach', id: 'ask', value: 'again?' });
    assert(await until(() => /No answer: .*Is the model server running/.test(texts()), 5000), `server down explained (${texts()})`);
    assert(host.status('local-coach')?.state === 'running', 'still running');
    host.stopAll();

    const zipped = await readZip(new Uint8Array(fs.readFileSync('public/examples/local-coach.zip')));
    assert(new TextDecoder().decode(zipped.get('local-coach/main.js')!) === fs.readFileSync('examples/mods/local-coach/main.js', 'utf8'), 'local-coach.zip is stale: run npm run example-mod');
  }

  console.log('MOD PHASE 6 TESTS PASSED (panel + storage permissions, panel sanitising, requests refused without permission, storage + zoomTo answered, panel events to their own mod only, bench events; local coach end to end: settings from storage, board + tests + readings + question sent, answer shown, invented part removed, server down explained)');
}

run().catch((e) => { console.error(e); (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1; });
