// Motion-graphics stage for the showcase video, injected into the real app page before it
// boots: the app runs inside a framed "window" (#pr-frame) that can tilt and fly; #app inside
// it can zoom onto a panel. Titles, feature captions, cursor and click rings live on the stage.
// All durations are in OUTPUT milliseconds and stretched by `slow` (the recording runs slower
// than real time, then frames are retimed, so motion stays smooth at 30 fps).

export const STAGE = { width: 1600, height: 900, scale: 1.2 } as const;
/** The app window on the stage (CSS px). 16:9, with a caption band underneath. */
export const FRAME = { x: 96, y: 18, w: 1408, h: 792 } as const;

/** Runs in the page (addInitScript): wraps #app before the app's module script executes. */
export const STAGE_INIT = (slow: number, frame: typeof FRAME) => {
  const W = 1600, H = 900;
  const MONO = "'JetBrains Mono Variable', 'JetBrains Mono', monospace";
  const SANS = "'Inter Variable', Inter, sans-serif";
  const d = (ms: number) => ms * slow;

  const install = () => {
    if (document.getElementById('pr-frame')) return;
    const app = document.getElementById('app');
    if (!app) return;
    const css = document.createElement('style');
    css.textContent = `
      html, body { background: radial-gradient(1200px 700px at 50% 40%, #0f1712 0%, #070a08 70%) !important; }
      body::before { content: ''; position: fixed; inset: 0; pointer-events: none;
        background-image: radial-gradient(rgba(75,227,138,.10) 1px, transparent 1.2px); background-size: 28px 28px;
        mask-image: radial-gradient(900px 600px at 50% 45%, #000 30%, transparent 85%); }
      #pr-frame { position: fixed; left: ${frame.x}px; top: ${frame.y}px; width: ${frame.w}px; height: ${frame.h}px;
        border-radius: 14px; overflow: hidden; z-index: 1; opacity: 0;
        box-shadow: 0 0 0 1px #2e3832, 0 30px 80px rgba(0,0,0,.65), 0 0 120px rgba(75,227,138,.06);
        transform: perspective(2400px) translate3d(0px,0px,0px) rotateX(0deg) rotateY(0deg) scale(1); }
      #pr-frame > #app { width: 100% !important; height: 100% !important; transform-origin: 0 0;
        transform: translate(0px, 0px) scale(1); }
      #pr-cap { position: fixed; left: ${frame.x}px; top: ${frame.y + frame.h + 14}px; width: ${frame.w}px; height: 64px;
        z-index: 5; display: flex; align-items: center; gap: 18px; pointer-events: none; }
      #pr-cap .n { font: 700 15px/1 ${MONO}; color: #04140a; background: #4be38a; padding: 7px 9px; border-radius: 6px; }
      #pr-cap .t { font: 650 27px/1.1 ${SANS}; color: #e3eae5; letter-spacing: -.01em; white-space: nowrap; }
      #pr-cap .s { font: 400 18px/1.3 ${SANS}; color: #8f9c94; }
      #pr-cap .s b { font: 600 18px/1 ${MONO}; color: #4be38a; }
      #pr-cap > * { opacity: 0; }
      #pr-title { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; pointer-events: none; text-align: center; }
      #pr-title .big { font: 700 64px/1.05 ${MONO}; color: #e3eae5; letter-spacing: .02em; }
      #pr-title .sub { margin-top: 18px; font: 450 26px/1.35 ${SANS}; color: #aeb9b1; }
      #pr-title .sub b { color: #4be38a; font-weight: 600; }
      #pr-title .w { display: inline-block; opacity: 0; }
      #pr-intro { position: fixed; inset: 0; z-index: 30; pointer-events: none; }
      #pr-hook { position: fixed; left: 0; right: 0; bottom: 0; height: 420px; z-index: 25; pointer-events: none; opacity: 0;
        background: linear-gradient(to top, rgba(4,7,5,.94) 0%, rgba(4,7,5,.82) 45%, rgba(4,7,5,0) 100%);
        display: flex; flex-direction: column; justify-content: flex-end; padding: 0 96px 70px; }
      #pr-hook .big { font: 700 66px/1.05 ${MONO}; color: #f4f8f5; letter-spacing: -.01em; }
      #pr-hook .sub { margin-top: 18px; font: 500 28px/1.3 ${SANS}; color: #c9d3cc; }
      #pr-hook .sub b { font-family: ${MONO}; color: #ffb347; font-weight: 700; }
      #pr-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 50; pointer-events: none; opacity: 0;
        transition: transform ${d(520)}ms cubic-bezier(.4,.1,.2,1), opacity ${d(200)}ms; filter: drop-shadow(0 2px 3px rgba(0,0,0,.8)); }
      .pr-ring { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px; border: 2.5px solid #4be38a; border-radius: 50%;
        z-index: 49; pointer-events: none; }
      .pr-hl { position: fixed; z-index: 40; pointer-events: none; border: 2.5px solid #f2b33d; border-radius: 10px;
        box-shadow: 0 0 0 5px rgba(242,179,61,.16), 0 0 30px rgba(242,179,61,.4); }
      .pr-hl span { position: absolute; left: -2px; bottom: calc(100% + 8px); white-space: nowrap; padding: 4px 10px; border-radius: 6px;
        background: #f2b33d; color: #1a1204; font: 700 15px/1.2 ${MONO}; }
      .pr-redact { filter: blur(8px) !important; }
    `;
    document.head.appendChild(css);
    const frameEl = document.createElement('div');
    frameEl.id = 'pr-frame';
    app.parentNode!.insertBefore(frameEl, app);
    frameEl.appendChild(app);
    frameEl.style.transform = 'perspective(2400px) translate3d(0px,0px,0px) rotateX(0deg) rotateY(0deg) scale(1)';
    app.style.transform = 'translate(0px, 0px) scale(1)';
    for (const [id, html] of [['pr-hook', ''], ['pr-cap', ''], ['pr-title', ''], ['pr-intro', ''],
      ['pr-cursor', '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>']]) {
      const el = document.createElement('div'); el.id = id; el.innerHTML = html; document.body.appendChild(el);
    }
    // flags never appear in the video
    const redact = () => document.querySelectorAll('.toast, .flag-box, .flag-box *').forEach((el) => {
      if (/[A-Z]{3,5}\{[^}]*\}/.test(el.textContent || '')) el.classList.add('pr-redact');
    });
    new MutationObserver(redact).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  document.addEventListener('readystatechange', install);
  if (document.readyState !== 'loading') install();

  const $ = (id: string) => document.getElementById(id)!;
  const ease = 'cubic-bezier(.22,.8,.2,1)';
  /** Animates a property set and keeps the end state. */
  const to = (el: HTMLElement, props: Record<string, string>, ms: number, easing = ease, delay = 0) => {
    const from: Record<string, string> = {};
    const cs = getComputedStyle(el);
    for (const k of Object.keys(props)) from[k] = el.style.getPropertyValue(k) || cs.getPropertyValue(k);
    const a = el.animate([from, props], { duration: d(ms), delay: d(delay), easing, fill: 'forwards' });
    a.finished.then(() => { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v); a.cancel(); }).catch(() => {});
    return a;
  };
  const words = (html: string, cls = 'w') => html.split(/(\s+)/).map((w) => (/^\s+$/.test(w) ? w : `<span class="${cls}">${w}</span>`)).join('');
  const reveal = (root: HTMLElement, ms = 420, stagger = 55, delay = 0) => {
    root.querySelectorAll<HTMLElement>('.w').forEach((w, i) => {
      w.animate([{ opacity: 0, transform: 'translateY(18px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        { duration: d(ms), delay: d(delay + i * stagger), easing: ease, fill: 'forwards' });
    });
  };

  const BOARD = 'M7 4h15l6 6v15a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z';
  const TRACE = 'M4 17h7l2.5-7 3 13 2.5-8h4';

  (window as any).__pr = {
    /** Frame (window) transform: tilt / fly. */
    frame: (t: { x?: number; y?: number; rx?: number; ry?: number; s?: number; o?: number }, ms: number, easing?: string) => {
      const tf = `perspective(2400px) translate3d(${t.x ?? 0}px,${t.y ?? 0}px,0px) rotateX(${t.rx ?? 0}deg) rotateY(${t.ry ?? 0}deg) scale(${t.s ?? 1})`;
      to($('pr-frame'), { transform: tf, opacity: String(t.o ?? 1) }, ms, easing);
    },
    /** Zoom the app inside the frame so viewport point (vx, vy) is centred, at scale s (1 = reset). */
    zoom: (vx: number, vy: number, s: number, ms: number) => {
      const px = vx - frame.x, py = vy - frame.y;
      let tx = frame.w / 2 - s * px, ty = frame.h / 2 - s * py;
      tx = Math.min(0, Math.max(frame.w - s * frame.w, tx));
      ty = Math.min(0, Math.max(frame.h - s * frame.h, ty));
      if (s === 1) { tx = 0; ty = 0; }
      to($('app'), { transform: `translate(${tx}px, ${ty}px) scale(${s})` }, ms);
    },
    /** Feature caption under the window. */
    cap: (n: string, title: string, sub: string) => {
      const c = $('pr-cap');
      const out = Array.from(c.children) as HTMLElement[];
      out.forEach((e) => e.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: d(220), fill: 'forwards' }));
      setTimeout(() => {
        c.innerHTML = title ? `<span class="n">${n}</span><span class="t">${title}</span><span class="s">${sub}</span>` : '';
        (Array.from(c.children) as HTMLElement[]).forEach((e, i) => e.animate(
          [{ opacity: 0, transform: 'translateX(-24px)' }, { opacity: 1, transform: 'none' }],
          { duration: d(480), delay: d(i * 90), easing: ease, fill: 'forwards' }));
      }, d(out.length ? 240 : 0));
    },
    /** Big centred title (kinetic words). */
    title: (big: string, sub = '', y = 0) => {
      const t = $('pr-title');
      t.innerHTML = big || sub ? `<div style="transform: translateY(${y}px)"><div class="big">${words(big)}</div>${sub ? `<div class="sub">${words(sub)}</div>` : ''}</div>` : '';
      reveal(t);
    },
    /** Cold open: headline over the live app, lower third with a scrim. */
    hook: (big: string, sub: string) => {
      const h = $('pr-hook');
      h.innerHTML = `<div class="big">${words(big)}</div><div class="sub">${words(sub)}</div>`;
      h.style.opacity = '1';
      reveal(h, 380, 45);
    },
    hookOut: (ms = 350) => { to($('pr-hook'), { opacity: '0' }, ms); },
    titleOut: (ms = 300) => { const t = $('pr-title').firstElementChild as HTMLElement | null; if (t) to(t, { opacity: '0', transform: 'translateY(-24px)' }, ms); },
    /** Intro: a flatlined trace across the screen, a heartbeat spike, then the mark + wordmark. */
    intro: () => {
      const el = $('pr-intro');
      const mid = H / 2;
      el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">
        <path id="pr-flat" d="M-20 ${mid} H ${W / 2 - 60} l 26 -70 l 30 150 l 26 -110 l 18 30 H ${W + 20}" stroke="#4be38a" stroke-width="4"
          stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 8px rgba(75,227,138,.6))"/>
        <text id="pr-v" x="${W / 2 - 300}" y="${mid - 30}" fill="#7d8a82" font-family=${JSON.stringify(MONO)} font-size="22" font-weight="600">PP3V3 · 0.000 V</text>
      </svg>`;
      const flat = el.querySelector('#pr-flat') as SVGPathElement;
      const len = flat.getTotalLength();
      // phase 1: dead flat line draws to the middle; phase 2: spike + rest of the line
      const flatLen = W / 2 - 60 + 20;
      flat.style.strokeDasharray = `${len}`;
      flat.style.strokeDashoffset = `${len}`;
      flat.animate([{ strokeDashoffset: len }, { strokeDashoffset: len - flatLen }], { duration: d(900), easing: 'linear', fill: 'forwards' });
      const v = el.querySelector('#pr-v') as SVGTextElement;
      v.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d(300), delay: d(250), fill: 'forwards' });
      setTimeout(() => {
        flat.animate([{ strokeDashoffset: len - flatLen }, { strokeDashoffset: 0 }], { duration: d(650), easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' });
        v.textContent = 'PP3V3 · 3.301 V';
        v.setAttribute('fill', '#4be38a');
      }, d(1300));
    },
    /** Intro → logo lockup. */
    logo: (big = true) => {
      const el = $('pr-intro');
      const old = el.firstElementChild as HTMLElement | null;
      if (old) old.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.04)' }], { duration: d(400), fill: 'forwards' });
      const size = big ? 150 : 96;
      const div = document.createElement('div');
      div.style.cssText = `position:absolute; inset:0; display:grid; place-items:center;`;
      div.innerHTML = `<div style="display:flex; align-items:center; gap:${big ? 34 : 24}px">
          <svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">
            <path class="b" d="${BOARD}" stroke="#e3eae5" stroke-width="2" stroke-linejoin="round" pathLength="1" style="stroke-dasharray:1; stroke-dashoffset:1"/>
            <path class="t" d="${TRACE}" stroke="#4be38a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" pathLength="1" style="stroke-dasharray:1; stroke-dashoffset:1"/>
            <circle class="v" cx="25" cy="15" r="2.2" fill="#090c0a" stroke="#4be38a" stroke-width="2" style="opacity:0; transform-origin:25px 15px"/>
          </svg>
          <div>
            <div style="display:flex; align-items:center; gap:10px"><span class="wm" style="font:700 ${big ? 92 : 60}px/1 ${MONO}; letter-spacing:.14em; color:#e3eae5"></span>
              <span class="cur" style="width:${big ? 30 : 20}px; height:${big ? 78 : 52}px; background:#4be38a; display:inline-block"></span></div>
            <div class="tag" style="margin-top:${big ? 18 : 12}px; font:500 ${big ? 30 : 22}px/1.2 ${SANS}; color:#aeb9b1; opacity:0">Bring dead boards back.</div>
          </div></div>`;
      el.appendChild(div);
      const q = (s: string) => div.querySelector(s) as HTMLElement;
      q('.b').animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: d(600), easing: ease, fill: 'forwards' });
      q('.t').animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: d(600), delay: d(250), easing: ease, fill: 'forwards' });
      q('.v').animate([{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1)' }], { duration: d(300), delay: d(780), easing: 'cubic-bezier(.3,1.6,.5,1)', fill: 'forwards' });
      const name = 'DEADBOARD';
      for (let i = 0; i <= name.length; i++) setTimeout(() => { q('.wm').textContent = name.slice(0, i); }, d(500 + i * 55));
      q('.tag').animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: d(500), delay: d(1150), easing: ease, fill: 'forwards' });
      q('.cur').animate([{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0, offset: .51 }, { opacity: 0 }], { duration: d(1000), iterations: Infinity });
    },
    /** Moves the logo lockup up and shrinks it (keeps it as a header). */
    logoUp: (y: number, s: number, ms: number) => { const l = $('pr-intro').lastElementChild as HTMLElement | null; if (l) to(l, { transform: `translateY(${y}px) scale(${s})` }, ms); },
    logoOut: (ms = 400) => { const l = $('pr-intro').lastElementChild as HTMLElement | null; if (l) to(l, { opacity: '0' }, ms); },
    /** Outro feature list under the logo. */
    bullets: (items: string[], y: number) => {
      const el = $('pr-title');
      el.innerHTML = `<div style="transform: translateY(${y}px); display:flex; gap:48px; font:500 25px/1.3 ${SANS}; color:#c9d3cc">${items.map((x) => `<span class="w"><span style="color:#4be38a; font-family:${MONO}">▸</span> ${x}</span>`).join('')}</div>`;
      reveal(el, 500, 140);
    },
    /** Outro link line (repo URL), typed out terminal-style under the bullets. */
    link: (text: string, y: number, prefix = '$ ') => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed; left:0; right:0; top:calc(50% + ${y}px); z-index:21; text-align:center; pointer-events:none;
        font:600 34px/1 ${MONO}; color:#4be38a; letter-spacing:.02em`;
      el.innerHTML = '<span style="color:#7d8a82">' + prefix + '</span><span class="u"></span><span class="c" style="display:inline-block; width:.6em; height:1em; margin-left:4px; vertical-align:-0.12em; background:#4be38a"></span>';
      document.body.appendChild(el);
      const u = el.querySelector('.u') as HTMLElement;
      for (let i = 0; i <= text.length; i++) setTimeout(() => { u.textContent = text.slice(0, i); }, d(i * 38));
      (el.querySelector('.c') as HTMLElement).animate([{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0, offset: .51 }, { opacity: 0 }], { duration: d(1000), iterations: Infinity });
    },
    cursor: (x: number, y: number, show = true) => { const c = $('pr-cursor'); c.style.opacity = show ? '1' : '0'; c.style.transform = `translate(${x}px, ${y}px)`; },
    ring: (x: number, y: number) => {
      const r = document.createElement('div'); r.className = 'pr-ring'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r);
      r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: d(650), easing: 'ease-out', fill: 'forwards' });
      setTimeout(() => r.remove(), d(700));
    },
    hl: (x: number, y: number, w: number, h: number, label: string) => {
      const e = document.createElement('div'); e.className = 'pr-hl';
      Object.assign(e.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      if (label) { const s = document.createElement('span'); s.textContent = label; e.appendChild(s); }
      document.body.appendChild(e);
      e.animate([{ opacity: 0, transform: 'scale(1.4)' }, { opacity: 1, transform: 'none' }], { duration: d(380), easing: ease, fill: 'forwards' });
    },
    clearHl: () => document.querySelectorAll('.pr-hl').forEach((e) => e.remove()),
  };
};
