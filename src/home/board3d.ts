// The homepage hero: the MNT Reform 2 mainboard live in 3D, drawn by the bench's own renderer,
// that visitors can turn and zoom (nothing else: no tools, no power). Loaded only once the
// picture is on screen; the screenshot stays in place until the board is ready, and for good
// when the browser cannot draw it.
//
// Input keeps the page scrollable: a mouse drags to turn and zooms with Ctrl / ⌘ + wheel (a
// trackpad pinch sends the same); on touch, a sideways swipe turns the board, a vertical one
// scrolls the page, and a pinch zooms. Double-click or double-tap puts the view back.
import { t } from '../i18n';
import { parseScenario } from '../io/format';
import { buildConnectivity } from '../connectivity';
import { Camera } from '../render/camera';
import { Renderer, type RenderSceneState } from '../render/renderer';

const BOARD_URL = './demos/demo-mnt-reform2-mb30.pcbfix.json';

/** Returns `relabel`, to call after the page language changes. */
export async function mountBoard3d(frame: HTMLElement, img: HTMLImageElement, hint: HTMLElement | null, caption: HTMLElement | null): Promise<() => void> {
  const res = await fetch(BOARD_URL);
  if (!res.ok) throw new Error(`board: HTTP ${res.status}`);
  const board = parseScenario(await res.text()).board;

  const canvas = document.createElement('canvas');
  canvas.className = 'hero-3d';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', img.alt);
  img.insertAdjacentElement('afterend', canvas);
  let renderer: Renderer;
  try {
    renderer = await Renderer.create(canvas);
  } catch (e) {
    canvas.remove();
    throw e;
  }

  // the canvas has a size only once it replaces the screenshot
  frame.classList.add('live');
  const camera = new Camera();
  const home = () => {
    camera.fitBoard(board.w, board.h);
    // fitBoard sizes for a flat 2D view; the tilted 3D view of a wide board needs more room
    camera.dist *= 1.25;
    camera.setMode('3d');
  };
  // first fit needs the canvas aspect: matrices() records it
  camera.matrices(canvas.clientWidth, canvas.clientHeight);
  home();

  const scene: RenderSceneState = {
    board, conn: buildConnectivity(board), sim: null, powerOn: false, vizMode: 'realistic',
    selectedNet: -1, selectedCompId: null, hovered: null, probeRed: null, probeBlack: null,
    jumperDraft: null, cursorWorld: null, activeTool: 'view',
  };

  // ---- drawing: only while visible and while something moves ----
  let visible = true, dirty = true, raf = 0, last = performance.now();
  const frameLoop = (now: number) => {
    raf = 0;
    const before = `${camera.pitch},${camera.yaw},${camera.flipT}`;
    camera.tick(Math.min(0.05, (now - last) / 1000));
    last = now;
    const moving = before !== `${camera.pitch},${camera.yaw},${camera.flipT}`;
    if (dirty || moving) {
      renderer.render(camera, scene);
      dirty = false;
    }
    if (visible && (moving || dragging)) raf = requestAnimationFrame(frameLoop);
  };
  const wake = () => {
    dirty = true;
    if (!raf && visible) { last = performance.now(); raf = requestAnimationFrame(frameLoop); }
  };
  new IntersectionObserver((e) => { visible = e.some((x) => x.isIntersecting); if (visible) wake(); }).observe(canvas);
  new ResizeObserver(wake).observe(canvas);

  // ---- input ----
  const pts = new Map<number, { x: number; y: number }>();
  let dragging = false, pinch = 0, lastTap = 0;
  const zoom = (factor: number, cx: number, cy: number) => {
    const r = canvas.getBoundingClientRect();
    camera.zoomAt(factor, cx - r.left, cy - r.top, r.width, r.height, board.thickness);
    camera.dist = Math.min(420, Math.max(18, camera.dist));
    wake();
  };
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    if (pts.size === 2) pinch = spread();
    if (e.pointerType !== 'mouse') {
      if (performance.now() - lastTap < 300 && pts.size === 1) { home(); wake(); }
      lastTap = performance.now();
    }
    wake();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) {
      const d = spread();
      if (pinch > 0 && d > 0) {
        const [a, b] = [...pts.values()];
        zoom(pinch / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      pinch = d;
    } else {
      camera.orbit(dx, dy);
      wake();
    }
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    pinch = 0;
    dragging = pts.size > 0;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('dblclick', () => { home(); wake(); });
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls the page
    e.preventDefault();
    // a mouse wheel click is ~100 px, a trackpad pinch a few px per event: limit each step
    zoom(Math.min(1.2, Math.max(1 / 1.2, Math.exp(e.deltaY * 0.0025))), e.clientX, e.clientY);
  }, { passive: false });

  // ---- labels: the caption now describes the live board, not the screenshot ----
  caption?.removeAttribute('data-t');
  const relabel = () => {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (hint) hint.textContent = touch ? t('Swipe to turn · pinch to zoom') : /Mac/.test(navigator.platform) ? t('Drag to turn · ⌘ + scroll or pinch to zoom') : t('Drag to turn · Ctrl + scroll to zoom');
    if (caption) caption.textContent = t('MNT Reform 2 laptop mainboard (open hardware, 530 parts), live in 3D on the bench\'s own renderer. Double-click or double-tap to reset the view.');
    canvas.setAttribute('aria-label', img.alt);
  };
  relabel();
  wake();
  return relabel;
}
