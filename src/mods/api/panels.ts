// A panel's content as a mod sends it is untrusted data: this keeps known node types only, clips
// text, caps sizes and checks ids, so what the app draws is always small and well-formed. The app
// escapes every string when it draws it.
import type { PanelNode } from './types';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_NODES = 300;
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
const TONES = ['muted', 'warn', 'good', 'mono'];

export function sanitizePanel(content: unknown): PanelNode[] {
  let budget = MAX_NODES;
  const walk = (nodes: unknown, depth: number): PanelNode[] => {
    if (!Array.isArray(nodes) || depth > 3) return [];
    const out: PanelNode[] = [];
    for (const raw of nodes) {
      if (budget <= 0) break;
      if (!raw || typeof raw !== 'object') continue;
      const n = raw as Record<string, unknown>;
      budget--;
      switch (n.type) {
        case 'heading': out.push({ type: 'heading', text: str(n.text, 200) }); break;
        case 'text': out.push({ type: 'text', text: str(n.text, 8000), ...(TONES.includes(n.tone as string) && { tone: n.tone as 'muted' }), ...(n.linkRefs === true && { linkRefs: true }) }); break;
        case 'ref': if (typeof n.ref === 'string' && n.ref) out.push({ type: 'ref', ref: str(n.ref, 40), ...(typeof n.label === 'string' && { label: str(n.label, 80) }) }); break;
        case 'list': out.push({ type: 'list', items: (Array.isArray(n.items) ? n.items : []).filter((x): x is string => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 1000)), ...(n.linkRefs === true && { linkRefs: true }) }); break;
        case 'row': out.push({ type: 'row', children: walk(n.children, depth + 1) }); break;
        case 'button': if (typeof n.id === 'string' && ID_RE.test(n.id)) out.push({ type: 'button', id: n.id, label: str(n.label, 60) || n.id }); break;
        case 'input':
          if (typeof n.id === 'string' && ID_RE.test(n.id)) out.push({
            type: 'input', id: n.id, submit: str(n.submit, 40) || 'OK',
            ...(typeof n.label === 'string' && { label: str(n.label, 120) }),
            ...(typeof n.placeholder === 'string' && { placeholder: str(n.placeholder, 200) }),
            ...(typeof n.value === 'string' && { value: str(n.value, 4000) }),
            ...(n.multiline === true && { multiline: true }),
          });
          break;
        case 'divider': out.push({ type: 'divider' }); break;
      }
    }
    return out;
  };
  return walk(content, 0);
}
