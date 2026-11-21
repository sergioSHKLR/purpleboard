// The Mods window's Community tab and Submit form (src/mods/community.ts). Loaded the first time
// either is opened, so the app's first download doesn't carry it. Everything it needs from the
// app goes through `CommunityHost`.
import { t } from '../i18n';
import { icon } from './icons';
import { feedbackConfigured, postToMaintainer, REPO_URL } from './feedback';
import { downloadCommunityMod, fetchIndex, MAX_SUBMIT_BYTES, submissionFields, validLink, type CommunityMod } from '../mods/community';
import { compareVersions, parseVersion } from '../mods/semver';
import { installedPackage } from '../mods/sources';
import type { LoadedMod } from '../mods/mods';
import type { BenchReport } from '../mods/benchcheck';

export interface CommunityHost {
  esc(s: string): string;
  readonly mobile: boolean;
  /** Where the site's files are: this page on the website, the website itself in the desktop app. */
  readonly siteBase: string;
  /** Every loaded mod (installed, mods folder). */
  mods(): LoadedMod[];
  benchReport(modId: string): BenchReport | undefined;
  benchRunning(): string | null;
  runBenchCheck(modId: string): Promise<void>;
  installModBytes(bytes: Uint8Array, file: string): Promise<LoadedMod | null>;
  modActive(id: string): boolean;
  toast(msg: string, kind?: 'info' | 'success' | 'warn' | 'danger'): void;
  /** The Mods window is open. */
  isOpen(): boolean;
  /** The Mods window's tab. */
  view(): string;
  /** Redraws the Mods window (when it is open). */
  rerender(): void;
  /** Closes the Mods window (after an install, to show what was installed). */
  closeMods(): void;
}

export class CommunityUi {
  private communityList: CommunityMod[] | null = null;
  private communityError: string | null = null;
  private communityLoading = false;
  private communityBusy = new Set<string>();
  /** The installed mod being submitted, and the form. */
  submitFor: string | null = null;
  private submitDraft = { note: '', contact: '', link: '', agree: false };
  private submitSending = false;

  constructor(private readonly h: CommunityHost) {}

  /** The catalogue hasn't been asked for yet. */
  get unloaded() { return !this.communityList && !this.communityLoading; }

  async loadCommunity() {
    this.communityLoading = true;
    this.communityError = null;
    this.h.rerender();
    try {
      this.communityList = (await fetchIndex(this.h.siteBase)).mods;
    } catch (e) {
      this.communityError = t('Could not load the community mods: {error}', { error: e instanceof Error ? e.message : String(e) });
    }
    this.communityLoading = false;
    if (this.h.view() === 'community') this.h.rerender();
  }

  /** A listed mod here: not installed, installed (this version or newer), or an update waiting. */
  private communityState(m: CommunityMod): 'new' | 'installed' | 'update' {
    const have = this.h.mods().find((x) => x.manifest.id === m.id)?.manifest.version;
    if (!have) return 'new';
    const a = parseVersion(m.version), b = parseVersion(have);
    return a && b && compareVersions(a, b) > 0 ? 'update' : 'installed';
  }

  communityHtml(): string {
    const intro = `
      <div class="card">
        <p class="text-2" style="margin:0">${t('Mods on deadboard.org: the examples from the guide and mods players sent in. Each one is reviewed before it is listed.')}</p>
        <p class="muted" style="margin:0">${t('To share yours: install it, then press «Submit» on its card under Installed.')}</p>
      </div>`;
    if (this.communityError) return `${intro}<div class="card modio-msg"><span>${this.h.esc(this.communityError)}</span><button class="btn sm" id="community-retry">${t('Try again')}</button></div>`;
    if (!this.communityList) return `${intro}<div class="muted modio-msg">${t('Loading mods…')}</div>`;
    const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
    const counts = (c: CommunityMod['contents']) => [
      c.boards && t('{n} board|{n} boards', { n: c.boards }),
      c.puzzles && t('{n} puzzle|{n} puzzles', { n: c.puzzles }),
      c.knowledge && t('{n} knowledge pack|{n} knowledge packs', { n: c.knowledge }),
      c.patches && t('{n} patch|{n} patches', { n: c.patches }),
      c.faultTypes && t('{n} fault type|{n} fault types', { n: c.faultTypes }),
      c.rules && t('{n} rule|{n} rules', { n: c.rules }),
      c.meters && t('{n} meter|{n} meters', { n: c.meters }),
      c.devices && t('{n} device model|{n} device models', { n: c.devices }),
    ].filter(Boolean).join(', ');
    const cards = this.communityList.map((m) => {
      const st = this.communityState(m);
      const action = this.communityBusy.has(m.id)
        ? `<button class="btn sm" disabled>${t('Installing…')}</button>`
        : st === 'installed'
          ? `<span class="badge pass">${icon('check', 11)} ${t('Installed')}</span>`
          : `<button class="btn sm primary" data-community-install="${this.h.esc(m.id)}">${icon('download', 12)}<span>${st === 'update' ? t('Update') : t('Install')}</span></button>`;
      const needs = Object.keys(m.requires).filter((id) => !id.startsWith('official-'));
      const facts = [m.author && t('by {author}', { author: this.h.esc(m.author) }), this.h.esc(m.license), kb(m.size)].filter(Boolean).join(' · ');
      // a code mod's code isn't run when it is listed, so only data mods carry the badge
      const bench = m.bench.fail
        ? `<span class="badge fail" title="${t('Bench check when it was listed')}">✗ ${m.bench.fail}</span>`
        : m.code ? '' : `<span class="badge pass" title="${t('Bench check when it was listed')}">${icon('check', 11)} ${t('Bench-checked')}</span>`;
      const what = counts(m.contents);
      return `
        <div class="card modio-card community-card">
          <div class="modio-logo none">${icon(m.example ? 'book' : 'box', 22)}</div>
          <div class="modio-info">
            <div class="mod-name">${this.h.esc(m.name)} <span class="muted mono">v${this.h.esc(m.version)}</span></div>
            <div class="muted">${facts}</div>
            <div class="row wrap">
              ${m.example ? `<span class="badge info">${t('Example')}</span>` : ''}
              ${m.code ? `<span class="badge warn" title="${t('Runs only while code mods are on (Installed tab)')}">${icon('box', 11)} ${t('Runs code')}</span>` : ''}
              ${bench}
            </div>
            ${what ? `<div class="muted mod-reqs">${t('Adds: {what}', { what })}</div>` : ''}
            ${needs.length ? `<div class="muted mod-reqs">${t('Needs: {mods} (installed with it)', { mods: this.h.esc(needs.join(', ')) })}</div>` : ''}
            ${m.description ? `<details class="mod-changes"><summary>${t('About')}</summary><p class="text-2">${this.h.esc(m.description)}</p></details>` : ''}
            <div class="row wrap">${action}</div>
          </div>
        </div>`;
    }).join('');
    return intro + (cards || `<div class="muted modio-msg">${t('No mods listed yet.')}</div>`);
  }

  bindCommunity(root: HTMLElement) {
    root.querySelector('#community-retry')?.addEventListener('click', () => void this.loadCommunity());
    root.querySelectorAll<HTMLButtonElement>('[data-community-install]').forEach((b) => b.addEventListener('click', () => {
      const m = this.communityList?.find((x) => x.id === b.dataset.communityInstall);
      if (m) void this.installFromCommunity(m);
    }));
  }

  /** Installs a listed mod, after the listed mods it needs that aren't installed yet. */
  private async installFromCommunity(m: CommunityMod) {
    if (this.communityBusy.has(m.id)) return;
    this.communityBusy.add(m.id);
    this.h.rerender();
    let mod: LoadedMod | null = null;
    try {
      const order: CommunityMod[] = [];
      const visit = (x: CommunityMod, depth = 0) => {
        if (depth > 10) return;
        for (const id of Object.keys(x.requires)) {
          const dep = this.communityList?.find((y) => y.id === id);
          if (dep && !order.includes(dep) && !this.h.mods().some((y) => y.manifest.id === id)) { visit(dep, depth + 1); order.push(dep); }
        }
      };
      visit(m);
      for (const dep of order) {
        if (!(await this.h.installModBytes(await downloadCommunityMod(dep, this.h.siteBase), dep.file.split('/').pop()!))) throw new Error(t('«{name}», which it needs, was not installed', { name: dep.name }));
      }
      mod = await this.h.installModBytes(await downloadCommunityMod(m, this.h.siteBase), m.file.split('/').pop()!);
    } catch (e) {
      this.h.toast(t('Could not install «{name}»: {error}', { name: m.name, error: e instanceof Error ? e.message : String(e) }), 'danger');
    }
    this.communityBusy.delete(m.id);
    if (!this.h.isOpen()) return;
    if (mod && !mod.warnings.length && this.h.modActive(mod.manifest.id)) { this.h.closeMods(); return; }
    this.h.rerender();
  }

  // ---- submitting a mod ----

  openSubmit(modId: string) {
    this.submitFor = modId;
    this.submitDraft = { note: '', contact: this.submitDraft.contact, link: '', agree: false };
    this.h.rerender();
    // the check runs first: what it finds goes with the submission
    if (!this.h.benchReport(modId) && !this.h.benchRunning()) void this.h.runBenchCheck(modId);
  }

  submitHtml(modId: string): string {
    const mod = this.h.mods().find((m) => m.manifest.id === modId);
    if (!mod) return `<div class="card">${t('This mod is no longer installed.')}<button class="btn sm" id="submit-cancel">${t('Back')}</button></div>`;
    const mf = mod.manifest;
    const d = this.submitDraft;
    const r = this.h.benchReport(modId);
    const n = (l: string) => r?.findings.filter((f) => f.level === l).length ?? 0;
    const running = this.h.benchRunning() === modId;
    const fails = n('fail') > 0;
    const size = this.submitSize.get(modId) ?? 0;
    const big = size > MAX_SUBMIT_BYTES;
    const ready = this.submitReady(modId);
    if (!feedbackConfigured) {
      return `
        <div class="card">
          <div class="mod-name">${t('Submit «{name}»', { name: this.h.esc(mf.name) })}</div>
          <p class="text-2">${t('Sending from the app isn\'t set up on this build. Open an issue on GitHub and attach the mod\'s .zip.')}</p>
          <div class="row wrap">
            <a class="btn sm primary" href="${REPO_URL}/issues/new?${new URLSearchParams({ title: `Mod submission: ${mf.name} v${mf.version}`, labels: 'mod submission' })}" target="_blank" rel="noopener">${icon('link', 12)}<span>${t('Open an issue on GitHub')}</span></a>
            <button class="btn sm ghost" id="submit-cancel">${t('Back')}</button>
          </div>
        </div>`;
    }
    return `
      <div class="card submit-card">
        <div class="mod-name">${t('Submit «{name}»', { name: this.h.esc(mf.name) })} <span class="muted mono">v${this.h.esc(mf.version)}</span></div>
        <p class="text-2" style="margin:0">${t('It goes to the DEADBOARD maintainer for review. Once accepted, it is listed under Community for everyone, under its licence ({license}).', { license: this.h.esc(mf.license) })}</p>
        <div class="row wrap">
          ${running ? `<span class="muted">${t('Bench check…')} <span id="bench-step"></span></span>`
            : r ? `<span class="bench-sum"><span class="pass">✓ ${n('pass')}</span> <span class="warn">! ${n('warn')}</span> <span class="fail">✗ ${n('fail')}</span></span>` : ''}
          ${fails ? `<span class="fail">${t('Fix the failed checks first (see the report on its card).')}</span>` : ''}
        </div>
        ${mf.code ? `<p class="muted" style="margin:0">${t('It contains code: the review takes longer, and players can run it only with code mods turned on.')}</p>` : ''}
        <label class="fb-field"><span>${big ? t('Link to the .zip (required: it is {kb} kB, more than can be sent here)', { kb: Math.ceil(size / 1024) }) : t('Link to the mod\'s page or source (optional)')}</span>
          <input type="url" id="submit-link" placeholder="https://…" value="${this.h.esc(d.link)}" autocomplete="off" /></label>
        <label class="fb-field"><span>${t('Note for the reviewer (optional)')}</span>
          <textarea id="submit-note" rows="3" maxlength="2000" placeholder="${t('What it adds, what to look at')}">${this.h.esc(d.note)}</textarea></label>
        <label class="fb-field"><span>${t('Contact (optional)')}</span>
          <input type="text" id="submit-contact" maxlength="200" placeholder="${this.h.mobile ? t('Email or GitHub name') : t('Email or GitHub name, if you want an answer')}" value="${this.h.esc(d.contact)}" autocomplete="email" /></label>
        <label class="mod-toggle"><input type="checkbox" id="submit-agree" ${d.agree ? 'checked' : ''} /><span>${t('I made this mod or may share it, and agree to it being published on deadboard.org under its licence.')}</span></label>
        <div class="row wrap">
          <button class="btn sm primary" id="submit-send" ${ready ? '' : 'disabled'}>${icon('upload', 12)}<span>${this.submitSending ? t('Sending…') : t('Send for review')}</span></button>
          <button class="btn sm ghost" id="submit-cancel">${t('Cancel')}</button>
        </div>
      </div>`;
  }

  /** Size of each installed mod's .zip (filled when the submit form opens). */
  private submitSize = new Map<string, number>();

  bindSubmit(root: HTMLElement, modId: string) {
    const back = () => { this.submitFor = null; this.h.rerender(); };
    root.querySelector('#submit-cancel')?.addEventListener('click', back);
    if (!this.submitSize.has(modId)) {
      void installedPackage(modId).then((p) => { this.submitSize.set(modId, p?.bytes.length ?? 0); if (this.submitFor === modId) this.h.rerender(); });
    }
    const field = (id: string, key: 'note' | 'contact' | 'link') => {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
      el?.addEventListener('keydown', (e) => e.stopPropagation()); // typing is not tool shortcuts
      el?.addEventListener('input', () => {
        this.submitDraft[key] = el.value;
        if (key === 'link') { const b = root.querySelector<HTMLButtonElement>('#submit-send'); if (b) b.disabled = !this.submitReady(modId); }
      });
    };
    field('submit-link', 'link');
    field('submit-note', 'note');
    field('submit-contact', 'contact');
    root.querySelector<HTMLInputElement>('#submit-agree')?.addEventListener('change', (e) => {
      this.submitDraft.agree = (e.target as HTMLInputElement).checked;
      const b = root.querySelector<HTMLButtonElement>('#submit-send');
      if (b) b.disabled = !this.submitReady(modId);
    });
    root.querySelector('#submit-send')?.addEventListener('click', () => void this.sendSubmission(modId));
  }

  private submitReady(modId: string): boolean {
    const r = this.h.benchReport(modId);
    const d = this.submitDraft;
    const big = (this.submitSize.get(modId) ?? 0) > MAX_SUBMIT_BYTES;
    return !!r && this.h.benchRunning() !== modId && !r.findings.some((f) => f.level === 'fail') && d.agree
      && (!big || validLink(d.link)) && (!d.link.trim() || validLink(d.link)) && !this.submitSending;
  }

  private async sendSubmission(modId: string) {
    const mod = this.h.mods().find((m) => m.manifest.id === modId);
    const r = this.h.benchReport(modId);
    if (!mod || !r || !this.submitReady(modId)) return;
    this.submitSending = true;
    this.h.rerender();
    try {
      const pkg = await installedPackage(modId);
      if (!pkg) throw new Error(t('this mod is no longer installed'));
      const n = (l: string) => r.findings.filter((f) => f.level === l).length;
      const d = this.submitDraft;
      await postToMaintainer(await submissionFields({
        manifest: mod.manifest, bytes: pkg.bytes, link: d.link, note: d.note, contact: d.contact,
        bench: `${n('pass')} passed · ${n('warn')} warning(s) · ${n('fail')} failed`,
      }));
      this.h.toast(t('Sent «{name}» for review. Once accepted, it appears under Community.', { name: mod.manifest.name }), 'success');
      this.submitFor = null;
      this.submitDraft = { note: '', contact: d.contact, link: '', agree: false };
    } catch (e) {
      this.h.toast(t('Could not send: {error}', { error: e instanceof Error ? e.message : String(e) }), 'danger');
    }
    this.submitSending = false;
    this.h.rerender();
  }
}
