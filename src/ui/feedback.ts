// Player feedback (bug reports and suggestions) without any account: the form posts to
// FormSubmit (formsubmit.co), which forwards it as an email to the maintainer. A prefilled GitHub
// issue is offered as a secondary route for people who have an account.
//
// The destination is set at build time, never in the source: VITE_FEEDBACK_TO is the address
// (or, after FormSubmit's one-time activation, the random alias it emails you). Locally put it in
// .env.local; on GitHub Pages set the repository variable FEEDBACK_TO (Settings → Secrets and
// variables → Actions → Variables). Unset, the form only offers the GitHub route.
import { icon } from './icons';

export const REPO_URL = 'https://github.com/tholtman1-del/deadboard';
const TO = ((import.meta.env?.VITE_FEEDBACK_TO as string | undefined) ?? '').trim();
export const feedbackConfigured = TO.length > 0;

declare const __APP_BUILD__: string | undefined;
export const APP_BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';

export type FeedbackKind = 'bug' | 'idea';

/** What the app knows about the moment of the report; every field optional. */
export interface FeedbackContext {
  board?: string;
  view?: string;
  solver?: string;
  gpu?: string;
  error?: string;
}

/** Technical details attached to a report: no personal data, shown to the sender before sending. */
export function diagnostics(ctx: FeedbackContext): string {
  const lines = [
    `Build: ${APP_BUILD}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}×${screen.height} @${window.devicePixelRatio}x, window ${innerWidth}×${innerHeight}`,
    ctx.gpu && `GPU: ${ctx.gpu}`,
    ctx.board && `Board: ${ctx.board}`,
    ctx.view && `View: ${ctx.view}`,
    ctx.solver && `Solver: ${ctx.solver}`,
    ctx.error && `Error: ${ctx.error}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export interface FeedbackMessage { kind: FeedbackKind; message: string; contact: string; details: string }

export async function sendFeedback(m: FeedbackMessage): Promise<void> {
  if (!feedbackConfigured) throw new Error('feedback is not set up on this build');
  const label = m.kind === 'bug' ? 'Bug report' : 'Suggestion';
  const firstLine = m.message.trim().split('\n')[0].slice(0, 60);
  const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(TO)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      _subject: `[DEADBOARD] ${label}: ${firstLine}`,
      _template: 'box',
      _captcha: 'false',
      ...(m.contact.includes('@') && { _replyto: m.contact.trim() }),
      type: label,
      message: m.message.trim(),
      contact: m.contact.trim() || '(none)',
      details: m.details || '(not included)',
    }),
  });
  const body = await res.json().catch(() => null) as { success?: string | boolean; message?: string } | null;
  if (!res.ok || !body || String(body.success) !== 'true') throw new Error(body?.message || `HTTP ${res.status}`);
}

/** A prefilled issue on GitHub (needs an account; the form does not). */
export function githubIssueUrl(kind: FeedbackKind, message: string, details: string): string {
  const q = new URLSearchParams({ template: kind === 'bug' ? 'bug_report.yml' : 'suggestion.yml' });
  const field = kind === 'bug' ? 'what' : 'idea';
  if (message.trim()) q.set(field, message.trim().slice(0, 2000));
  if (details) q.set('environment', details.slice(0, 2500));
  return `${REPO_URL}/issues/new?${q}`;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Unsent text survives closing the form (per tab). */
const draft = { kind: 'bug' as FeedbackKind, message: '', contact: '', include: true };

/**
 * Renders the feedback form into `host` and wires it up. `context` is read whenever the details
 * are shown or sent, so they reflect the moment of sending.
 */
export function mountFeedbackForm(host: HTMLElement, context: () => FeedbackContext, opts: { kind?: FeedbackKind; onSent?: () => void } = {}) {
  if (opts.kind) draft.kind = opts.kind;
  host.innerHTML = `
    <div class="fb">
      <div class="seg fb-kind">
        <button type="button" data-kind="bug">Report a bug</button>
        <button type="button" data-kind="idea">Suggest an idea</button>
      </div>
      <div class="field">
        <label for="fb-msg" class="fb-msg-label"></label>
        <textarea id="fb-msg" rows="6" maxlength="5000"></textarea>
      </div>
      ${feedbackConfigured ? `
      <div class="field">
        <label for="fb-contact">Your email or name <span class="fb-opt">(optional, only if you'd like a reply)</span></label>
        <input id="fb-contact" type="text" maxlength="200" autocomplete="email">
      </div>` : ''}
      <label class="fb-check"><input type="checkbox" id="fb-include"> Include technical details (browser, GPU, board, view)</label>
      <details class="fb-details"><summary>What gets sent</summary><pre id="fb-diag"></pre></details>
      <div class="fb-actions">
        ${feedbackConfigured
          ? `<button type="button" class="btn primary" id="fb-send">${icon('check', 14)}<span>Send</span></button>`
          : `<a class="btn primary" id="fb-gh-main" href="#" target="_blank" rel="noopener">${icon('link', 14)}<span>Continue on GitHub</span></a>`}
        <span class="fb-status muted" id="fb-status" role="status"></span>
      </div>
      ${feedbackConfigured ? `<p class="muted fb-foot">No account needed: your message is emailed to the developer.
        Have a GitHub account? <a id="fb-gh" href="#" target="_blank" rel="noopener">Open an issue instead</a>.</p>` : ''}
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const msg = $<HTMLTextAreaElement>('#fb-msg')!;
  const contact = $<HTMLInputElement>('#fb-contact');
  const include = $<HTMLInputElement>('#fb-include')!;
  const status = $<HTMLElement>('#fb-status')!;
  const send = $<HTMLButtonElement>('#fb-send');
  const ghLinks = [$<HTMLAnchorElement>('#fb-gh'), $<HTMLAnchorElement>('#fb-gh-main')].filter((a): a is HTMLAnchorElement => !!a);
  msg.value = draft.message; include.checked = draft.include;
  if (contact) contact.value = draft.contact;

  const details = () => (include.checked ? diagnostics(context()) : '');
  const updateGh = () => { for (const a of ghLinks) a.href = githubIssueUrl(draft.kind, msg.value, details()); };
  const refresh = () => {
    host.querySelectorAll<HTMLButtonElement>('.fb-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === draft.kind));
    $('.fb-msg-label')!.textContent = draft.kind === 'bug' ? 'What went wrong? What did you do just before?' : 'What would make DEADBOARD better?';
    msg.placeholder = draft.kind === 'bug'
      ? 'e.g. On Bridge Troll, flipped to the bottom in 3D: the solder blob between D2\'s legs is not visible.'
      : 'e.g. Split the board into squares for IPA, so each square dries at its own temperature.';
    $('#fb-diag')!.innerHTML = escHtml(details() || '(nothing: technical details are switched off)');
    updateGh();
  };
  host.querySelectorAll<HTMLButtonElement>('.fb-kind button').forEach((b) => b.addEventListener('click', () => { draft.kind = b.dataset.kind as FeedbackKind; refresh(); }));
  msg.addEventListener('input', () => { draft.message = msg.value; updateGh(); });
  contact?.addEventListener('input', () => { draft.contact = contact.value; });
  include.addEventListener('change', () => { draft.include = include.checked; refresh(); });
  // typing in the form must not trigger the bench's keyboard shortcuts
  host.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

  send?.addEventListener('click', async () => {
    if (msg.value.trim().length < 5) { status.textContent = 'Please write a few words first.'; msg.focus(); return; }
    send.disabled = true;
    status.textContent = 'Sending…';
    try {
      await sendFeedback({ kind: draft.kind, message: msg.value, contact: contact?.value ?? '', details: details() });
      draft.message = ''; msg.value = '';
      status.textContent = 'Thank you! Your message was sent.';
      updateGh();
      opts.onSent?.();
    } catch (err) {
      status.textContent = `Could not send (${err instanceof Error ? err.message : String(err)}). Please try again in a moment.`;
    } finally {
      send.disabled = false;
    }
  });
  refresh();
  msg.focus();
}
