import type { Side, V2 } from '../types';
import { DEG, invert, lookAt, m4mul, ortho, perspective, transform4, type M4, type V3 } from '../geom';

export type ViewMode = '2d' | '3d';
export const BOTH_GAP = 16;

export class Camera {
  mode: ViewMode = '2d';
  side: Side = 'F';
  bothSides = false;
  /** Orbit drag moves the camera (board turns against the drag) instead of turning the board. */
  invertOrbit = false;

  // Target point on board in mm
  tx = 32;
  ty = 18;
  // Distance (for 3D perspective) and ortho half-height (mm)
  dist = 78;
  orthoHalfH = 26;

  // Animated angles (degrees). The pose is an orbit around the target in the frame of the
  // active side: pitch = tilt away from that side's normal (0 = straight on, 90 = edge-on,
  // negative = tilted the other way), yaw = turn around the normal. flipT turns that frame
  // about the board's Y axis (0 = Front +Z, 1 = Back -Z). Orbiting past edge-on hands over to
  // the other side, so the camera can go all the way around the board.
  yaw = 0;
  pitch = 0;
  flipT = 0;

  private targetPitch = 0;
  private targetYaw = 0;
  private targetFlipT = 0;

  private lastAspect = 1.6;
  private boardW = 64;
  private boardH = 36;

  fitBoard(w: number, h: number) {
    this.boardW = w;
    this.boardH = h;
    const totalW = this.bothSides ? w * 2 + BOTH_GAP : w;
    this.tx = totalW / 2;
    this.ty = h / 2;
    const span = Math.max(totalW / Math.max(0.4, this.lastAspect), h);
    this.orthoHalfH = Math.max(12, span * 0.56);
    this.dist = Math.max(30, span * 1.35);
  }

  focusAt(x: number, y: number, halfH = 12, side?: Side) {
    this.tx = x;
    this.ty = y;
    this.orthoHalfH = Math.max(6, halfH);
    this.dist = Math.max(20, halfH * 2.2);
    if (side) this.setSide(side);
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    if (mode === '2d') {
      // settle straight onto the active side by the shortest turn
      const wrap = (a: number) => a - 360 * Math.round(a / 360);
      this.yaw = wrap(this.yaw);
      this.targetYaw = 0;
      this.targetPitch = 0;
    } else {
      // 3D is one physical board you can turn over; the side-by-side layout is a 2D boardview
      if (this.bothSides) {
        this.bothSides = false;
        this.fitBoard(this.boardW, this.boardH);
      }
      if (Math.abs(this.targetPitch) < 15) this.targetPitch = 40;
      if (Math.abs(this.targetYaw) < 1) this.targetYaw = -16;
    }
  }

  flip() {
    this.side = this.side === 'F' ? 'B' : 'F';
    this.targetFlipT = this.side === 'B' ? 1 : 0;
  }

  setSide(side: Side) {
    this.side = side;
    this.targetFlipT = side === 'B' ? 1 : 0;
  }

  /**
   * Free orbit: any yaw, any tilt — past edge-on the camera continues under the board.
   * The board follows the drag (grab-and-turn, as in most 3D viewers): dragging right turns
   * it right, dragging down tips its far edge toward the viewer. `invertOrbit` swaps to
   * moving the camera instead (the board turns against the drag).
   */
  orbit(dx: number, dy: number) {
    if (this.mode === '2d') this.setMode('3d');
    const s = this.invertOrbit ? 1 : -1;
    // A negative pitch is the positive-pitch view turned 180° on screen (the near edge is at the
    // top), which is where the camera lands after orbiting over the edge to look up at the
    // underside. Yaw would then read mirrored, so it turns the other way there; the dead zone
    // around face-on keeps the direction from flickering. (Pitch needs no such care: it always
    // moves the eye along the camera's own up axis.)
    if (this.targetPitch > 5) this.yawSign = 1;
    else if (this.targetPitch < -5) this.yawSign = -1;
    this.targetYaw += s * this.yawSign * dx * 0.45;
    this.targetPitch += s * dy * 0.4;
    this.rebaseSide();
  }
  private yawSign = 1;

  /**
   * Once the orbit passes edge-on, re-express the same pose in the other side's frame
   * (turning the frame by 180° about Y maps pitch θ → θ ∓ 180, yaw φ → 180 − φ), so the
   * active side — used for picking and probing — is always the face the camera sees.
   */
  private rebaseSide() {
    if (this.bothSides || this.flipT !== this.targetFlipT) return;
    if (this.targetPitch <= 90 && this.targetPitch > -90) return;
    const d = this.targetPitch > 90 ? -180 : 180;
    this.targetPitch += d;
    this.pitch += d;
    this.targetYaw = 180 - this.targetYaw;
    this.yaw = 180 - this.yaw;
    this.side = this.side === 'F' ? 'B' : 'F';
    this.flipT = this.targetFlipT = this.side === 'B' ? 1 : 0;
  }

  /** Orthographic straight-on view (settled 2D). */
  private get isOrtho(): boolean {
    const f = this.bothSides ? 0 : this.flipT;
    return this.mode === '2d' && Math.abs(this.pitch) < 0.8 && Math.abs(f - Math.round(f)) < 0.01;
  }

  /** Screen pixels per board millimetre at the target point. */
  pxPerMm(heightPx: number): number {
    const mmTall = this.isOrtho ? this.orthoHalfH * 2 : this.dist * Math.tan(22 * DEG) * 2;
    return Math.max(1, heightPx) / mmTall;
  }

  /** Unit offset from target to eye, and the camera up vector (world space). */
  private pose(): { o: V3; up: V3 } {
    const th = this.pitch * DEG, ph = this.yaw * DEG;
    const fa = (this.bothSides ? 0 : this.flipT) * Math.PI;
    const o: V3 = [Math.sin(th) * Math.sin(ph), -Math.sin(th) * Math.cos(ph), Math.cos(th)];
    const up: V3 = [-Math.cos(th) * Math.sin(ph), Math.cos(th) * Math.cos(ph), Math.sin(th)];
    const c = Math.cos(fa), s = Math.sin(fa);
    const rotY = (v: V3): V3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
    return { o: rotY(o), up: rotY(up) };
  }

  panScreen(dx: number, dy: number, heightPx: number) {
    const mmPerPx = 1 / this.pxPerMm(heightPx);
    const { o, up } = this.pose();
    // screen right = up × (eye − target); move the target in the board plane
    const right: V3 = [up[1] * o[2] - up[2] * o[1], up[2] * o[0] - up[0] * o[2], up[0] * o[1] - up[1] * o[0]];
    const rl = Math.hypot(right[0], right[1]) || 1, ul = Math.hypot(up[0], up[1]);
    const us = ul > 0.2 ? 1 / ul : 1;
    this.tx += (-dx * right[0] / rl + dy * up[0] * us) * mmPerPx;
    this.ty += (-dx * right[1] / rl + dy * up[1] * us) * mmPerPx;
  }

  zoomAt(factor: number, sx: number, sy: number, widthPx: number, heightPx: number, thickness: number) {
    const before = this.screenToBoard(sx, sy, widthPx, heightPx, thickness);
    this.orthoHalfH = Math.max(0.8, Math.min(450, this.orthoHalfH * factor));
    this.dist = Math.max(4, Math.min(900, this.dist * factor));
    if (before && this.mode === '2d') {
      const after = this.screenToBoard(sx, sy, widthPx, heightPx, thickness);
      if (after) {
        this.tx += before[0] - after[0];
        this.ty += before[1] - after[1];
      }
    }
  }

  tick(dt: number) {
    const k = 1 - Math.exp(-14 * dt);
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.flipT += (this.targetFlipT - this.flipT) * k;
    if (Math.abs(this.targetPitch - this.pitch) < 0.05) this.pitch = this.targetPitch;
    if (Math.abs(this.targetYaw - this.yaw) < 0.05) this.yaw = this.targetYaw;
    if (Math.abs(this.targetFlipT - this.flipT) < 0.002) this.flipT = this.targetFlipT;
  }

  matrices(widthPx: number, heightPx: number): { viewProj: M4; eye: V3; isBack: boolean } {
    const aspect = Math.max(0.1, widthPx / Math.max(1, heightPx));
    this.lastAspect = aspect;

    const { o, up } = this.pose();
    const r = this.isOrtho ? 180 : this.dist;
    const eye: V3 = [this.tx + o[0] * r, this.ty + o[1] * r, o[2] * r];
    const view = lookAt(eye, [this.tx, this.ty, 0], up);

    const proj = this.isOrtho
      ? ortho(-this.orthoHalfH * aspect, this.orthoHalfH * aspect, -this.orthoHalfH, this.orthoHalfH, 0.5, 600)
      : perspective(44 * DEG, aspect, 0.5, 1500);

    return { viewProj: m4mul(proj, view), eye, isBack: o[2] < 0 };
  }

  /** Intersects screen pixel ray with the active copper plane (z = ±thickness/2). */
  screenToBoard(sx: number, sy: number, widthPx: number, heightPx: number, thickness: number): V2 | null {
    const { viewProj } = this.matrices(widthPx, heightPx);
    const inv = invert(viewProj);
    const ndcX = (sx / Math.max(1, widthPx)) * 2 - 1;
    const ndcY = 1 - (sy / Math.max(1, heightPx)) * 2;
    const p0 = transform4(inv, ndcX, ndcY, 0, 1);
    const p1 = transform4(inv, ndcX, ndcY, 1, 1);
    if (Math.abs(p0[3]) < 1e-7 || Math.abs(p1[3]) < 1e-7) return null;

    const a: V3 = [p0[0] / p0[3], p0[1] / p0[3], p0[2] / p0[3]];
    const b: V3 = [p1[0] / p1[3], p1[1] / p1[3], p1[2] / p1[3]];
    const zPlane = this.bothSides || this.side === 'F' ? thickness / 2 : -thickness / 2;
    const dz = b[2] - a[2];
    if (Math.abs(dz) < 1e-6) return null;
    const t = (zPlane - a[2]) / dz;
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
}
