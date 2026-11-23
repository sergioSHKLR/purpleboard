// @ts-check
// Local coach: an example DEADBOARD code mod. A panel where the player asks a question; the mod
// keeps an index of the open board (parts by ref, pins by net, the named nets) and sends a
// language model on the player's own computer only what the question needs: the parts and nets it
// names, one ring of neighbours, and a summary of the bench (power, voltages, failing tests, the
// last reading, the probes). Follow-up questions keep the last few turns.
//
// Grounding is enforced, not requested: every designator-shaped word in the answer goes through
// api.queries.findRef and every net-shaped word (VCC, +5V, GND…) through the board's net names;
// names the board doesn't have are removed and the panel says how many. Only real parts become
// links.
//
// Ollama: `ollama serve` with OLLAMA_ORIGINS=* (the mod's sandbox has no origin of its own), then
// endpoint http://127.0.0.1:11434/v1/chat/completions and a model you pulled (e.g. llama3.2).
//
// Cloud is opt-in: set the endpoint to https://openrouter.ai/api/v1/chat/completions and paste a
// key. The key is kept in memory only (never in storage, never shown back), the panel says when
// board data leaves the computer, and the cloud selection is larger but still only what the
// question needs. The manifest allows exactly one HTTPS site.
/// <reference types="@deadboard/mod-api/global" />

const DEFAULTS = { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2' };
const SYSTEM = [
  'You coach a learner repairing a circuit board in DEADBOARD, a board-repair trainer.',
  'The learner sees the same parts, voltages and test results you are given.',
  'Answer in a few sentences, in this shape and in the learner\'s language: "Facts:" only what the data shows; "Next step:" one measurement with its two points (part pads or nets), power on or off, and the meter mode; "If:" what the plausible readings would rule in or out.',
  'Give exactly one next step, not a list of alternative measurements; a follow-up continues from it.',
  'Answer in the language of the learner\'s question.',
  'With the power off the meter is in resistance, diode or continuity mode: never tell the learner to measure voltage with the power off.',
  'When the learner asks a follow-up (what next, why), stay with the parts under discussion and continue from your last answer; do not restart with general advice.',
  'Only name parts (designators such as R1, C5, U2) and nets that appear in the data you are given. The parts list is a selection for this question, so a part the learner asks about may be missing: say you do not see it rather than guess.',
  'A net name (such as LED_A or +3V) is a piece of copper, not a part: name the part by its designator (D1, not "the LED_A").',
  'In the data a net may be written as NAME (#id) when separate pieces of copper share that name, for example after a cut trace: the number only tells the pieces apart.',
  'If the data cannot answer it (what is inside a chip, firmware, a datasheet value, the power-up order or a boot sequence), say so and what would answer it.',
  'Do not reveal the fault outright unless the learner asks for the answer.',
].join(' ');
const DESIGNATOR = /\b[A-Z]{1,3}\d{1,4}[A-Z]?\b/g;
/** Words that look like net names: +5V, -12V, 3V3, VCC, VBAT, VOUT, GND. Bare readings (0.02V, 0V, 5V) are not net-like. */
const NETLIKE = /(?<![A-Za-z0-9_])(?:[+-]\d+V(?:\d+)?|\d+V\d+|V(?:CC|DD|SS|EE|BAT|BUS|IN|OUT|REF|RAW|PWR)\w*|GND\w*)(?![A-Za-z0-9_])/g;
/** Questions that ask about copper next to a part, not about its own pins. */
const PROXIMITY = /рядом|возле|около|близко|near|next to|around|close to|adjacent/i;
/** Net names that read like a supply rail (+5V, 3V3, 5V0, VCC, VBAT, VOUT, +5V_RAW). */
const RAIL_NAME = /^(?:[+-]?\d+(?:\.\d+)?V\w*|V(?:CC|DD|SS|EE|BAT|BUS|IN|OUT|REF|RAW|PWR)\w*)$/i;
/** Net names that read like ground. */
const GROUND_NAME = /^(?:(?:GND|VSS)\w*|0V\d*)$/i;
const LOCAL_ENDPOINT = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i;
/** The one cloud site the manifest allows, and only over HTTPS. */
const CLOUD_ENDPOINT = /^https:\/\/openrouter\.ai(?:\/|$)/i;
const BUDGET = 6000;
const MAX_PARTS = 40;
/** A cloud model takes more text; still only the selection, never the whole board. */
const CLOUD_BUDGET = 20000;
const CLOUD_MAX_PARTS = 120;
const TURNS = 3;
const TIMEOUT = 120000;

/** @param {DeadboardMod.ModApi} api */
export default function activate(api) {
  let settings = { ...DEFAULTS };
  /** The OpenRouter key: memory only, never written to storage or rendered back. */
  let key = '';
  let title = '';
  /** @type {{ nets: DeadboardMod.Net[]; byRef: Map<string, DeadboardMod.NetPart>; byNet: Map<number, { ref: string; pad: string }[]>; names: Map<number, string | null>; byName: Map<string, number[]> }} */
  let index = { nets: [], byRef: new Map(), byNet: new Map(), names: new Map(), byName: new Map() };
  /** @type {string[]} */ let failing = [];
  let results = 0;
  /** @type {Record<string, number>} */ let volts = {};
  /** @type {Record<string, { i: number; v: number; p: number; on: boolean }>} */ let bench = {};
  let lastReading = '';
  /** @type {{ red: string | null; black: string | null } | null} */ let probes = null;
  /** @type {{ on: boolean; nets: Record<string, number> } | null} */ let power = null;
  /** @type {{ q: string; a: string }[]} */ let turns = [];
  /** The parts and nets the last question that named any was about, kept for follow-ups. @type {{ refs: string[]; nets: number[] } | null} */
  let focus = null;
  let state = { busy: false, answer: '', removed: 0, nets: 0, error: '' };

  const isCloud = () => CLOUD_ENDPOINT.test(settings.endpoint);
  const allowedEndpoint = (url) => LOCAL_ENDPOINT.test(url) || CLOUD_ENDPOINT.test(url);

  api.register.panel('coach', { title: 'Coach · local or cloud model' });
  render();
  api.storage.get('settings').then((v) => { if (v) { try { settings = { ...DEFAULTS, ...JSON.parse(v) }; } catch { /* keep defaults */ } render(); } });

  api.on('board:loaded', (p) => {
    title = p.title;
    buildIndex(p.netlist);
    failing = [];
    results = 0;
    volts = {};
    bench = {};
    lastReading = '';
    probes = null;
    power = null;
    turns = [];
    focus = null;
    state = { busy: false, answer: '', removed: 0, nets: 0, error: '' };
    render();
  });
  api.on('tests:run', (p) => { failing = p.results.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`); results = p.results.length; render(); });
  api.on('bench:solved', (p) => { volts = p.nets; bench = p.parts; });
  api.on('power:changed', (p) => { power = { on: p.on, nets: p.on ? p.nets : {} }; if (!p.on) { volts = {}; bench = {}; } });
  api.on('measure:taken', (p) => { lastReading = `${p.mode} between ${p.red ?? '—'} and ${p.black ?? 'ground'}: ${p.text}`; });
  api.on('probe:placed', (p) => { probes = { red: p.red, black: p.black }; });
  api.on('panel:action', (p) => {
    if (p.id === 'ask' && p.value?.trim()) void ask(p.value.trim());
    if (p.id === 'clear') { turns = []; focus = null; state = { busy: false, answer: '', removed: 0, nets: 0, error: '' }; render(); }
    if (p.id === 'endpoint' || p.id === 'model') {
      settings = { ...settings, [p.id]: (p.value ?? '').trim() || DEFAULTS[p.id] };
      void api.storage.set('settings', JSON.stringify(settings));
      render();
    }
    if (p.id === 'key') { key = (p.value ?? '').trim(); render(); }
    if (p.id === 'forget-key') { key = ''; render(); }
  });

  function render() {
    /** @type {DeadboardMod.PanelNode[]} */
    const c = [
      { type: 'text', tone: 'muted', text: isCloud()
        ? `Ask about ${title || 'the board on the bench'}. The parts and nets around your question, their joints, test results and readings go to ${settings.endpoint} — this leaves this computer.`
        : `Ask about ${title || 'the board on the bench'}. The parts and nets around your question, their joints, test results and readings go to ${settings.endpoint}, on this computer.` },
      { type: 'input', id: 'ask', multiline: true, placeholder: 'Where should I measure next?', submit: state.busy ? 'Thinking…' : 'Ask' },
    ];
    if (failing.length) c.push({ type: 'text', tone: 'warn', text: `Failing tests: ${failing.join('; ')}` });
    if (state.error) c.push({ type: 'text', tone: 'warn', text: state.error });
    if (state.answer) c.push({ type: 'text', text: state.answer, linkRefs: true });
    if (state.removed || state.nets) c.push({ type: 'text', tone: 'muted', text: `Removed ${state.removed} part name(s) and ${state.nets} net name(s) that aren't on this board.` });
    if (state.answer || turns.length) c.push({ type: 'button', id: 'clear', label: 'Clear conversation' });
    c.push({ type: 'divider' },
      { type: 'input', id: 'endpoint', label: 'Endpoint (localhost, or https://openrouter.ai)', value: settings.endpoint, submit: 'Save' },
      { type: 'input', id: 'model', label: 'Model', value: settings.model, submit: 'Save' });
    if (isCloud()) {
      c.push({ type: 'text', tone: 'muted', text: key
        ? 'The OpenRouter key is held in memory for this session only; it is not saved.'
        : 'Cloud mode needs an OpenRouter key. Paste it below; it is kept in memory only and is not saved.' },
      { type: 'input', id: 'key', label: 'OpenRouter key (memory only)', placeholder: key ? 'Key set — paste another to replace it' : 'sk-or-…', submit: 'Use key' });
      if (key) c.push({ type: 'button', id: 'forget-key', label: 'Forget key' });
    }
    if (lastReading) c.push({ type: 'text', tone: 'mono', text: lastReading });
    if (probes) c.push({ type: 'text', tone: 'muted', text: `Probes: red on ${probes.red ?? 'nothing'}, black on ${probes.black ?? 'nothing'}.` });
    api.panels.set('coach', c);
  }

  const round = (v, d) => String(+v.toFixed(d));
  /** @param {number} a amps */
  const amps = (a) => Math.abs(a) >= 1 ? `${round(a, 2)} A` : Math.abs(a) >= 1e-3 ? `${round(a * 1e3, 1)} mA` : `${round(a * 1e6, 0)} µA`;
  /** @param {number} r ohms */
  const ohms = (r) => Math.abs(r) >= 1e6 ? `${round(r / 1e6, 1)} MΩ` : Math.abs(r) >= 1e3 ? `${round(r / 1e3, 1)} kΩ` : `${round(r, 1)} Ω`;
  /** @param {number} w watts */
  const watts = (w) => Math.abs(w) >= 1 ? `${round(w, 2)} W` : Math.abs(w) >= 1e-3 ? `${round(w * 1e3, 1)} mW` : `${round(w * 1e6, 0)} µW`;
  /** @param {DeadboardMod.NetPart} p */
  function value(p) {
    const v = p.value;
    if (p.kind === 'resistor' || p.kind === 'fuse') return `${round(v, 2)} ${p.kind === 'fuse' ? 'A' : 'Ω'}`;
    if (p.kind === 'capacitor') return v >= 1e-6 ? `${round(v * 1e6, 1)} µF` : v >= 1e-9 ? `${round(v * 1e9, 0)} nF` : `${round(v * 1e12, 0)} pF`;
    if (p.kind === 'battery') return `${round(v, 2)} V`;
    if (p.kind === 'led' || p.kind === 'diode') return p.vf ? `${round(p.vf, 2)} V` : '';
    return v ? `${round(v, 2)}` : '';
  }

  /** One part as a line: value, flags, joints and the latest bench reading. */
  function partLine(p) {
    const flags = [];
    if (!p.populated) flags.push('NOT POPULATED');
    if (p.burnt) flags.push('BURNT');
    if (p.valueGuessed) flags.push('value guessed');
    if (p.kind === 'switch' && p.closed === true) flags.push('closed');
    if (p.kind === 'switch' && p.closed === false) flags.push('open');
    if (p.leak) flags.push(`leak ${ohms(p.leak.ohms)} ${p.leak.a}-${p.leak.b}`);
    if (p.color) flags.push(p.color);
    const pins = [...new Set(p.pins.map((x) => {
      const joint = x.open ? ' OPEN JOINT' : x.ohms ? ` cold joint ${ohms(x.ohms)}` : '';
      const role = x.role && x.role !== x.pad ? ` (${x.role})` : '';
      return `${x.pad}${role}→${x.net < 0 ? 'nc' : nameOf(x.net)}${joint}`;
    }))].join(', ');
    const v = value(p);
    const m = bench[p.ref];
    const seen = m ? ` | draws ${amps(m.i)}, ${m.v.toFixed(3)} V, ${watts(m.i * m.v)}${m.on ? ', lit' : ''}` : '';
    return `${p.ref} ${p.kind}${v ? ` ${v}` : ''}${p.label ? ` "${p.label}"` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}: ${pins}${seen}`;
  }

  /** Facts a fault-finding coach uses: things that are visibly wrong on the board itself. */
  function signs() {
    const out = [];
    for (const p of api.queries.parts()) {
      if (!p.populated) out.push(`${p.ref} is not populated`);
      if (p.burnt) out.push(`${p.ref} is burnt`);
      if (p.leak) out.push(`${p.ref} has a leak of ${ohms(p.leak.ohms)} between ${p.leak.a} and ${p.leak.b}`);
      const joints = p.pins.filter((x) => x.open || x.ohms);
      for (const j of joints) out.push(`${p.ref} ${j.pad} has an ${j.open ? 'open' : 'resistive'} joint${j.ohms ? ` (${ohms(j.ohms)})` : ''}`);
      if (out.length >= 12) break;
    }
    return out;
  }

  /** Ref → part, net id → pins on it, and every net's name: the board once, reused per question. @param {DeadboardMod.Netlist} nl */
  function buildIndex(nl) {
    /** @type {Map<string, DeadboardMod.NetPart>} */
    const byRef = new Map();
    /** @type {Map<number, { ref: string; pad: string }[]>} */
    const byNet = new Map();
    /** @type {Map<number, string | null>} */
    const names = new Map();
    /** @type {Map<string, number[]>} */
    const byName = new Map();
    for (const n of nl.nets) {
      names.set(n.id, n.name);
      if (n.name) byName.set(n.name, [...(byName.get(n.name) ?? []), n.id]);
    }
    for (const part of nl.parts) {
      byRef.set(part.ref.toUpperCase(), part);
      for (const pin of part.pins) {
        if (pin.net < 0) continue;
        const pins = byNet.get(pin.net) ?? [];
        pins.push({ ref: part.ref, pad: pin.pad });
        byNet.set(pin.net, pins);
      }
    }
    index = { nets: nl.nets, byRef, byNet, names, byName };
  }

  /** A net's name; when a cut trace leaves two pieces sharing one name, both get their id. @param {number} id */
  const nameOf = (id) => {
    const name = index.names.get(id) ?? null;
    if (!name) return `#${id}`;
    return (index.byName.get(name)?.length ?? 0) > 1 ? `${name} (#${id})` : name;
  };

  /** "VOUT: R1.2, R2.1, TP1.1": the other end of every joint on a net. @param {number} id */
  function netLine(id) {
    const pins = index.byNet.get(id) ?? [];
    const shown = pins.slice(0, 10).map((p) => `${p.ref}.${p.pad}`);
    if (pins.length > shown.length) shown.push(`+${pins.length - shown.length}`);
    return `${nameOf(id)}: ${shown.join(', ') || '(no pins)'}`;
  }

  /** Whether the text has `word` as a whole token. @param {string} text @param {string} word @param {boolean} [fold] case-insensitive */
  function mentions(text, word, fold) {
    const hay = fold ? text.toUpperCase() : text, needle = fold ? word.toUpperCase() : word;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const before = at > 0 ? hay[at - 1] : ' ';
      const after = hay[at + needle.length] ?? ' ';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    }
    return false;
  }

  /** A net name the board has: "+5V" matches "5V" and the other way round. @param {string} name */
  function hasNet(name) {
    const up = String(name).toUpperCase();
    for (const n of index.nets) {
      const known = String(n.name ?? '').toUpperCase();
      if (known && (known === up || `+${known}` === up || `+${up}` === known)) return true;
    }
    return false;
  }

  /**
   * Electrical roles of the selected parts, derived from net names, the reported supply and the
   * copper only. A guess is left out; the block is labelled "derived" so it never reads as a
   * documented fact. @param {DeadboardMod.NetPart[]} picked
   */
  function roles(picked) {
    /** @type {string[]} */
    const out = [];
    const isGround = (id) => {
      const n = String(index.names.get(id) ?? '').toUpperCase();
      if (!n) return false;
      return GROUND_NAME.test(n) || (probes?.black ? probes.black.toUpperCase() === n : false);
    };
    const isRail = (id) => {
      const n = index.names.get(id) ?? '';
      if (!n || isGround(id)) return false;
      if (power?.nets && Object.prototype.hasOwnProperty.call(power.nets, n)) return true;
      return RAIL_NAME.test(n);
    };
    /** @param {DeadboardMod.NetPart} p */
    const netsOf = (p) => p.pins.filter((x) => x.net >= 0).map((x) => x.net);
    /** @param {string} s */
    const add = (s) => { if (out.length < 8 && !out.includes(s)) out.push(s); };
    const hasRole = (ref) => out.some((s) => s.startsWith(`${ref} `) || s.startsWith(`${ref}+`));

    for (const p of picked) {
      const nets = netsOf(p);
      if (p.kind === 'capacitor') {
        const rail = nets.find(isRail), gnd = nets.find(isGround);
        if (rail != null && gnd != null) add(`${p.ref} decoupling ${nameOf(rail)} to ${nameOf(gnd)}`);
      }
      if (p.kind === 'resistor' && nets.length === 2) {
        for (const [a, b] of [[nets[0], nets[1]], [nets[1], nets[0]]]) {
          if (!isRail(a) || isRail(b) || isGround(b)) continue;
          const active = (index.byNet.get(b) ?? []).some((pin) => index.byRef.get(pin.ref.toUpperCase())?.kind === 'ic');
          if (active) add(`${p.ref} pull-up from ${nameOf(a)} to ${nameOf(b)} (reaches an IC)`);
        }
      }
    }

    for (const p of picked) {
      if (p.kind !== 'resistor') continue;
      const nets = netsOf(p);
      if (nets.length !== 2) continue;
      for (const mid of nets) {
        const midName = index.names.get(mid) ?? '';
        // A rail-like midpoint (VOUT, +5V_RAW) can be a divider output; a rail
        // reported by power:changed is a supply, not a midpoint.
        if (isGround(mid) || (midName && power?.nets && Object.prototype.hasOwnProperty.call(power.nets, midName))) continue;
        const pEnd = nets.find((id) => id !== mid);
        if (pEnd == null) continue;
        for (const pin of index.byNet.get(mid) ?? []) {
          const q = index.byRef.get(pin.ref.toUpperCase());
          if (!q || q.ref === p.ref || q.kind !== 'resistor' || p.ref > q.ref) continue;
          const qNets = netsOf(q);
          if (qNets.length !== 2) continue;
          const qEnd = qNets.find((id) => id !== mid);
          if (qEnd == null) continue;
          const pair = (isRail(pEnd) && isGround(qEnd)) || (isGround(pEnd) && isRail(qEnd));
          const touches = (index.byNet.get(mid) ?? []).some((x) => x.ref !== p.ref && x.ref !== q.ref);
          if (pair && touches) add(`${p.ref}+${q.ref} divider ${nameOf(pEnd)}→${nameOf(mid)}→${nameOf(qEnd)}`);
        }
      }
    }

    for (const p of picked) {
      if (hasRole(p.ref)) continue;
      const nets = netsOf(p);
      const rails = [...new Set(nets.filter(isRail))];
      const gnds = [...new Set(nets.filter(isGround))];
      if (!rails.length && !gnds.length) continue;
      const bits = [];
      if (rails.length) bits.push(`on ${rails.map(nameOf).join('/')} rail`);
      if (gnds.length) bits.push(`on ${gnds.map(nameOf).join('/')} ground`);
      add(`${p.ref} ${bits.join(' and ')}`);
    }
    return out;
  }

  /** The parts the question names, in order, without duplicates. @param {string} question */
  function namedParts(question) {
    /** @type {string[]} */
    const out = [];
    for (const m of question.match(DESIGNATOR) ?? []) {
      const r = api.queries.findRef(m);
      if (r.found && !out.includes(r.part.ref)) out.push(r.part.ref);
    }
    return out;
  }

  /**
   * What the question is about: the parts it names, the nets it names and one ring around them
   * (parts on those nets, then parts on those parts' other nets). Null when it names nothing.
   * @param {string} question
   */
  function select(question) {
    /** @type {Set<string>} */
    const named = new Set(namedParts(question));
    const nets = new Set();
    for (const n of index.nets) {
      const name = String(n.name ?? '');
      // "IN"/"EN" stay case-sensitive: the words "in"/"en" are too common to mean a net.
      if (name.length >= 2 && mentions(question, name, name.length >= 3 || /[^A-Za-z]/.test(name))) nets.add(n.id);
    }
    for (const ref of named) {
      for (const pin of index.byRef.get(ref.toUpperCase())?.pins ?? []) if (pin.net >= 0) nets.add(pin.net);
    }
    // a name shared by two pieces means the copper is cut: send both pieces, that is the finding
    for (const id of [...nets]) {
      const name = index.names.get(id);
      if (name) for (const other of index.byName.get(name) ?? []) nets.add(other);
    }
    if (!named.size && !nets.size) return null;
    const maxParts = isCloud() ? CLOUD_MAX_PARTS : MAX_PARTS;
    const refs = new Set(named);
    const seen = new Set(nets);
    /** @param {number} id @param {number} cap */
    const addOnNet = (id, cap) => {
      for (const pin of (index.byNet.get(id) ?? []).slice(0, cap)) {
        if (refs.size >= maxParts) return;
        refs.add(pin.ref);
      }
    };
    for (const id of nets) addOnNet(id, 8);
    for (const ref of [...refs].slice(0, 20)) {
      for (const pin of index.byRef.get(ref.toUpperCase())?.pins ?? []) {
        if (pin.net < 0 || seen.has(pin.net) || refs.size >= maxParts) continue;
        seen.add(pin.net);
        addOnNet(pin.net, 3);
      }
    }
    return { refs: [...refs].slice(0, maxParts), nets: [...seen] };
  }

  /** The board as text for the model: the bench summary, then what the question needs. @param {string} question */
  async function context(question) {
    const all = api.queries.parts();
    const maxParts = isCloud() ? CLOUD_MAX_PARTS : MAX_PARTS;
    const budget = isCloud() ? CLOUD_BUDGET : BUDGET;
    // "what next?" names nothing: keep the parts the last question that named any was about
    const own = select(question);
    if (own) focus = { refs: own.refs, nets: own.nets };
    const pick = own ?? focus;
    const carried = !own && !!pick;
    const picked = pick
      ? pick.refs.slice(0, maxParts).flatMap((r) => { const p = index.byRef.get(r.toUpperCase()); return p ? [p] : []; })
      : all.slice(0, maxParts);
    const netAll = (pick ? pick.nets : index.nets.map((n) => n.id))
      .filter((id) => (index.byNet.get(id)?.length ?? 0) > 0);
    const netIds = netAll.slice(0, 12);
    const nets = Object.entries(volts).slice(0, 12).map(([n, v]) => `${n} ${v.toFixed(3)} V`);
    const powerText = power ? (power.on ? `on (${Object.entries(power.nets).slice(0, 12).map(([n, v]) => `${n} ${v.toFixed(2)} V`).join(', ')})` : 'off') : nets.length ? 'on (the bench solved it)' : 'not reported yet';
    const bad = signs();
    const roleLines = roles(picked);
    // copper next to the named part, only when the question asks about proximity
    const nearRef = PROXIMITY.test(question) ? namedParts(question)[0] : '';
    let near = '';
    if (nearRef) {
      try {
        const list = await api.board.netsNear(nearRef, 0.5);
        if (list.length) near = `Copper near ${nearRef}: ${list.slice(0, 8).map((x) => `${x.net} (${x.mm.toFixed(1)} mm, pad ${x.pad})`).join(', ')}`;
      } catch { /* proximity is extra context: answer without it */ }
    }
    return [
      `Board: ${title || 'unknown'} (${all.length} parts, ${index.nets.length} nets)`,
      `Power: ${powerText}.`,
      nets.length ? `Voltages now: ${nets.join(', ')}` : 'No voltages: power is off or the bench has not solved yet.',
      failing.length ? `Failing tests (${failing.length} of ${results}): ${failing.join('; ')}` : results ? `All ${results} tests pass.` : 'No test results yet.',
      lastReading ? `Last meter reading: ${lastReading}` : '',
      probes ? `Probes: red on ${probes.red ?? 'nothing'}, black on ${probes.black ?? 'nothing'}.` : '',
      bad.length ? `Signs on the board: ${bad.join('; ')}.` : '',
      roleLines.length ? `Roles (derived from copper and readings, not documented): ${roleLines.join('; ')}.` : '',
      near,
      pick ? `Selected for ${carried ? 'the conversation so far' : 'this question'} (${picked.length} of ${all.length} parts):` : `Parts shown (${picked.length} of ${all.length}):`,
      ...picked.map(partLine),
      netIds.length ? `Nets shown (${netIds.length} of ${netAll.length}, copper connections, not parts):` : '',
      ...netIds.map(netLine),
    ].filter(Boolean).join('\n').slice(0, budget);
  }

  /** Why a request failed, in terms the player can act on. */
  function requestError(e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return 'No answer: the model did not reply within 2 minutes. It may still be loading; try again.';
    }
    if (e instanceof TypeError) {
      if (!allowedEndpoint(settings.endpoint)) {
        return `No answer: this endpoint is outside what the mod may reach. Use http://127.0.0.1, http://localhost or https://openrouter.ai, not ${settings.endpoint}.`;
      }
      if (isCloud()) {
        return 'No answer: the browser could not reach openrouter.ai. Check the internet connection; the site may also have refused the mod\'s origin (CORS), in which case the request never left the browser.';
      }
      return `No answer: Is the model server running on this computer? The browser stopped the request before it reached the server: nothing is listening at ${settings.endpoint}, the browser is blocking local-network access, or the server refused the mod's origin (CORS). Ollama: start it with OLLAMA_ORIGINS=* (Windows: setx OLLAMA_ORIGINS "*" in a terminal, then quit it from the tray and start it again). LM Studio: Developer → Server Settings → Enable CORS.`;
    }
    const why = e instanceof Error ? e.message : String(e);
    return `No answer: ${why}.`;
  }

  /** @param {string} question */
  async function ask(question) {
    if (state.busy) return;
    if (isCloud() && !key) {
      state = { busy: false, answer: '', removed: 0, nets: 0, error: 'No answer: paste an OpenRouter key in the settings below first. The key is kept in memory only and is never saved.' };
      render();
      return;
    }
    state = { busy: true, answer: '', removed: 0, nets: 0, error: '' };
    render();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT);
      /** @type {{ role: string; content: string }[]} */
      const messages = [{ role: 'system', content: SYSTEM }];
      for (const t of turns.slice(-TURNS)) messages.push({ role: 'user', content: `Question: ${t.q}` }, { role: 'assistant', content: t.a });
      messages.push({ role: 'user', content: `${await context(question)}\n\nQuestion: ${question}` });
      const base = { model: settings.model, temperature: 0.2, messages };
      const send = (body) => fetch(settings.endpoint, {
        method: 'POST',
        headers: isCloud()
          ? { 'content-type': 'application/json', authorization: `Bearer ${key}` }
          : { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let res = await send(isCloud() ? { ...base, reasoning: { enabled: false } } : { ...base, reasoning_effort: 'none' });
      // Some endpoints refuse to run without thinking; retry once the way they demand.
      if (isCloud() && res.status === 400) {
        let why = '';
        try {
          const j = await res.clone().json();
          why = String(j?.error?.message ?? '');
        } catch { /* not JSON: nothing to match */ }
        if (/reasoning is mandatory/i.test(why)) res = await send(base);
      }
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 401 && isCloud()) throw new Error('OpenRouter refused the key (401): check it and paste it again; it is not saved');
        if (res.status === 403 && !isCloud()) throw new Error('the server refused the request (403): the mod\'s origin is not allowed. Ollama: restart with OLLAMA_ORIGINS=*; LM Studio: Developer → Server Settings → Enable CORS');
        if (res.status === 429) throw new Error(isCloud() ? 'OpenRouter is busy with this free model (429): wait a minute, or set another free model in the settings' : 'the model server is busy (429): more requests arrived than it accepts at once; wait a moment and try again');
        let why = '';
        try {
          const j = await res.json();
          why = String(typeof j?.error === 'string' ? j.error : j?.error?.message ?? j?.message ?? '').trim().slice(0, 300);
        } catch { /* not JSON: the status is all we have */ }
        throw new Error(`the model server answered ${res.status}${why ? `: ${why}` : ''}`);
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      let text = String(message?.content ?? '').trim();
      if (!text) {
        throw new Error(message?.reasoning ? 'the model spent its whole reply on reasoning and returned no answer: turn thinking off in the server, or use a model that answers directly' : 'the model returned no answer');
      }
      if (text.length > 4000) text = `${text.slice(0, 4000)}…`;
      let removed = 0, nets = 0;
      const grounded = text
        .replace(DESIGNATOR, (m) => (api.queries.findRef(m).found || hasNet(m) ? m : (removed++, '[?]')))
        .replace(NETLIKE, (m) => (hasNet(m) ? m : (nets++, '[?]')));
      turns.push({ q: question, a: grounded });
      state = { busy: false, answer: grounded, removed, nets, error: '' };
    } catch (e) {
      state = { busy: false, answer: '', removed: 0, nets: 0, error: requestError(e) };
    }
    render();
  }
}
