// @ts-check
// Local coach: an example DEADBOARD code mod. A panel where the player asks a question; the mod
// sends the board (parts, nets, failing tests, last readings) and the question to a language model
// on the player's own computer through an OpenAI-compatible endpoint, and shows the answer.
//
// Grounding is enforced, not requested: every designator-shaped word in the answer is checked
// against the board (api.queries.findRef); names the board doesn't have are removed and the panel
// says how many. Only part names that exist become links.
//
// Ollama: `ollama serve` with OLLAMA_ORIGINS=* (the mod's sandbox has no origin of its own), then
// endpoint http://127.0.0.1:11434/v1/chat/completions and a model you pulled (e.g. llama3.2).
/// <reference types="@deadboard/mod-api/global" />

const DEFAULTS = { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2' };
const SYSTEM = [
  'You coach a learner repairing a circuit board in DEADBOARD, a board-repair trainer.',
  'Answer in a few sentences. Suggest the next measurement and what it would tell them.',
  'Only name parts (designators such as R1, C5, U2) that appear in the parts list you are given.',
  'Do not reveal the fault outright unless the learner asks for the answer.',
].join(' ');
const DESIGNATOR = /\b[A-Z]{1,3}\d{1,4}[A-Z]?\b/g;

/** @param {DeadboardMod.ModApi} api */
export default function activate(api) {
  let settings = { ...DEFAULTS };
  let title = '';
  /** @type {string[]} */ let failing = [];
  /** @type {Record<string, number>} */ let volts = {};
  let lastReading = '';
  let state = { busy: false, answer: '', removed: 0, error: '' };

  api.register.panel('coach', { title: 'Coach · local model' });
  render();
  api.storage.get('settings').then((v) => { if (v) { try { settings = { ...DEFAULTS, ...JSON.parse(v) }; } catch { /* keep defaults */ } render(); } });

  api.on('board:loaded', (p) => { title = p.title; failing = []; volts = {}; state = { busy: false, answer: '', removed: 0, error: '' }; render(); });
  api.on('tests:run', (p) => { failing = p.results.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`); render(); });
  api.on('bench:solved', (p) => { volts = p.nets; });
  api.on('measure:taken', (p) => { lastReading = `${p.mode} between ${p.red ?? '—'} and ${p.black ?? 'ground'}: ${p.text}`; });
  api.on('panel:action', (p) => {
    if (p.id === 'ask' && p.value?.trim()) void ask(p.value.trim());
    if (p.id === 'endpoint' || p.id === 'model') {
      settings = { ...settings, [p.id]: (p.value ?? '').trim() || DEFAULTS[p.id] };
      void api.storage.set('settings', JSON.stringify(settings));
      render();
    }
  });

  function render() {
    /** @type {DeadboardMod.PanelNode[]} */
    const c = [
      { type: 'text', tone: 'muted', text: `Ask about ${title || 'the board on the bench'}. The parts, test results and readings go to ${settings.endpoint}, on this computer.` },
      { type: 'input', id: 'ask', multiline: true, placeholder: 'Where should I measure next?', submit: state.busy ? 'Thinking…' : 'Ask' },
    ];
    if (failing.length) c.push({ type: 'text', tone: 'warn', text: `Failing tests: ${failing.join('; ')}` });
    if (state.error) c.push({ type: 'text', tone: 'warn', text: state.error });
    if (state.answer) c.push({ type: 'text', text: state.answer, linkRefs: true });
    if (state.removed) c.push({ type: 'text', tone: 'muted', text: `Removed ${state.removed} part name(s) that aren't on this board.` });
    c.push({ type: 'divider' },
      { type: 'input', id: 'endpoint', label: 'Endpoint (OpenAI-compatible, on this computer)', value: settings.endpoint, submit: 'Save' },
      { type: 'input', id: 'model', label: 'Model', value: settings.model, submit: 'Save' });
    api.panels.set('coach', c);
  }

  /** The board as text for the model: parts with their nets, readings, failing tests. */
  function context() {
    const parts = api.queries.parts().slice(0, 150).map((p) => {
      const pins = p.pins.map((x) => `${x.role ?? x.pad}→${api.queries.netOfPin(p.ref, x.pad) ?? 'nc'}${x.open ? ' (open joint)' : ''}`).join(', ');
      return `${p.ref} ${p.kind}${p.value ? ` ${p.value}` : ''}${p.label ? ` "${p.label}"` : ''}: ${pins}`;
    });
    const nets = Object.entries(volts).slice(0, 60).map(([n, v]) => `${n} ${v.toFixed(3)} V`);
    return [
      `Board: ${title}`,
      `Parts (${parts.length}):`, ...parts,
      nets.length ? `Voltages now: ${nets.join(', ')}` : 'Power is off or not measured yet.',
      lastReading ? `Last meter reading: ${lastReading}` : '',
      failing.length ? `Failing tests: ${failing.join('; ')}` : 'No test results yet.',
    ].filter(Boolean).join('\n').slice(0, 12000);
  }

  /** @param {string} question */
  async function ask(question) {
    if (state.busy) return;
    state = { busy: true, answer: '', removed: 0, error: '' };
    render();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(settings.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: settings.model, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${context()}\n\nQuestion: ${question}` }] }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`the model server answered ${res.status}`);
      const data = await res.json();
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) throw new Error('the model returned no answer');
      let removed = 0;
      const grounded = text.replace(DESIGNATOR, (m) => (api.queries.findRef(m).found ? m : (removed++, '[?]')));
      state = { busy: false, answer: grounded, removed, error: '' };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      state = { busy: false, answer: '', removed: 0, error: `No answer: ${why}. Is the model server running on this computer (for Ollama: OLLAMA_ORIGINS=*)?` };
    }
    render();
  }
}
