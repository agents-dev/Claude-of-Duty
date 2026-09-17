import { el, setStyle, setClass } from './util.js';

/**
 * Touch controls: left virtual joystick, right-side look drag, and a button
 * cluster (fire / ADS / jump / reload / crouch / use / weapon / grenade /
 * pause).
 *
 * Everything feeds the shared Input snapshot (see src/core/input.js): the
 * joystick overwrites the stick vector, look drags join the look delta, and
 * buttons inject the keyboard/mouse codes they mirror — so movement, sprint,
 * fire, ADS and edge queries work with no gameplay changes. Pointer Events
 * with per-pointer tracking carry simultaneous joystick + look + fire.
 *
 * Visibility: shown when touch input is live (`input.touchMode`, which latches
 * on the first touch) unless `config.touch === 'off'`; `?touch=on` forces it
 * for desktop testing. The layer sits under the pause menu in DOM order, and
 * every control opts back into pointer events (the HUD root disables them).
 */

// Buttons: hold (down/up while pressed), tap (down+up immediately), or toggle.
const BUTTONS = [
  { id: 'fire', label: 'FIRE', mode: 'hold', code: 'Mouse0', cls: 't-fire' },
  { id: 'ads', label: 'ADS', mode: 'toggle', code: 'Mouse2', cls: 't-ads' },
  { id: 'jump', label: 'JUMP', mode: 'hold', code: 'Space', cls: 't-jump' },
  { id: 'reload', label: 'RLD', mode: 'tap', code: 'KeyR', cls: 't-small' },
  { id: 'crouch', label: 'CRCH', mode: 'hold', code: 'ControlLeft', cls: 't-small' },
  { id: 'use', label: 'USE', mode: 'tap', code: 'KeyF', cls: 't-small' },
  { id: 'weapon', label: 'WPN', mode: 'tap', code: 'Tab', cls: 't-small' },
  { id: 'grenade', label: 'GRN', mode: 'tap', code: 'KeyG', cls: 't-small' },
  { id: 'pause', label: '❚❚', mode: 'tap', code: 'Escape', cls: 't-small t-pause' },
];

/** Stick radius in CSS px; deflection is normalised to the unit disc. */
const STICK_R = 56;
/** Inside this deflection the stick reads as centred. */
const STICK_DEAD = 0.16;

export class TouchControls {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.input = ctx.input;
    this.root = el('div', 'ow-touch', parent);
    setStyle(this.root, 'display', 'none');

    // Look layer: full-screen, under the buttons — any touch that does not
    // start on a control becomes a look drag.
    this.lookLayer = el('div', 't-look', this.root);
    this.lookId = null;
    this.lookX = 0;
    this.lookY = 0;
    this.lookLayer.addEventListener('pointerdown', (e) => this._lookDown(e));
    this.lookLayer.addEventListener('pointermove', (e) => this._lookMove(e));
    for (const ev of ['pointerup', 'pointercancel']) {
      this.lookLayer.addEventListener(ev, (e) => this._lookUp(e));
    }

    // Joystick: fixed base, bottom-left, clear of the HUD chrome.
    this.stickZone = el('div', 't-stick', this.root);
    this.stickBase = el('div', 't-base', this.stickZone);
    this.knob = el('div', 't-knob', this.stickBase);
    this.stickId = null;
    this.stickZone.addEventListener('pointerdown', (e) => this._stickDown(e));
    this.stickZone.addEventListener('pointermove', (e) => this._stickMove(e));
    for (const ev of ['pointerup', 'pointercancel']) {
      this.stickZone.addEventListener(ev, (e) => this._stickUp(e));
    }

    // Buttons, bottom-right cluster + top-right pause.
    this.btns = new Map();
    this._toggles = new Map(); // id -> held (toggle mode)
    for (const def of BUTTONS) {
      const b = el('button', `t-btn ${def.cls}`, this.root, def.label);
      b.type = 'button';
      b.dataset.id = def.id;
      b.addEventListener('pointerdown', (e) => this._btnDown(e, def));
      b.addEventListener('pointerup', (e) => this._btnUp(e, def));
      b.addEventListener('pointercancel', (e) => this._btnUp(e, def));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      this.btns.set(def.id, b);
      this._toggles.set(def.id, false);
    }

    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this._shown = false;
  }

  get visible() {
    if (this.ctx.config.touch === 'off') return false;
    if (this.ctx.config.touch === 'on') return true;
    return this.input.touchMode;
  }

  /** Called every frame from ui.lateUpdate; only touches the DOM on change. */
  sync() {
    const v = this.visible;
    if (v === this._shown) return;
    this._shown = v;
    setStyle(this.root, 'display', v ? '' : 'none');
    if (!v) this._releaseAll();
  }

  // ---- look ------------------------------------------------------------
  _lookDown(e) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (this.lookId !== null) return;
    this.lookId = e.pointerId;
    this.lookX = e.clientX;
    this.lookY = e.clientY;
  }

  _lookMove(e) {
    if (e.pointerId !== this.lookId) return;
    // Raw CSS px; Input scales by touchLookGain x sensitivity, so a full-width
    // swipe is roughly a quarter turn on any screen size.
    this.input.addTouchLook(e.clientX - this.lookX, e.clientY - this.lookY);
    this.lookX = e.clientX;
    this.lookY = e.clientY;
    e.preventDefault();
  }

  _lookUp(e) {
    if (e.pointerId === this.lookId) this.lookId = null;
  }

  // ---- joystick ----------------------------------------------------------
  _stickDown(e) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (this.stickId !== null) return;
    this.stickId = e.pointerId;
    try {
      this.stickZone.setPointerCapture(e.pointerId);
    } catch {
      /* older WebKit: moves still fire while the finger is down */
    }
    this._stickTo(e);
    e.preventDefault();
  }

  _stickMove(e) {
    if (e.pointerId !== this.stickId) return;
    this._stickTo(e);
    e.preventDefault();
  }

  _stickUp(e) {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.input.setTouchStick(0, 0, false);
    this.knob.style.transform = 'translate(-50%,-50%)';
  }

  _stickTo(e) {
    const r = this.stickBase.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = (e.clientX - cx) / STICK_R;
    let dy = (e.clientY - cy) / STICK_R;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // Deadzone with rescale, so the rim still reaches full deflection (and
    // full deflection still triggers the existing auto-sprint at 0.92).
    const m = Math.hypot(dx, dy);
    if (m < STICK_DEAD) {
      dx = 0;
      dy = 0;
    } else {
      const s = (m - STICK_DEAD) / (1 - STICK_DEAD) / m;
      dx *= s;
      dy *= s;
    }
    this.input.setTouchStick(dx, dy, true);
    this.knob.style.transform =
      `translate(calc(-50% + ${dx * STICK_R}px), calc(-50% + ${dy * STICK_R}px))`;
  }

  // ---- buttons ------------------------------------------------------------
  _btnDown(e, def) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* see above */
    }
    const input = this.input;
    if (def.mode === 'tap') {
      input.touchTap(def.code);
      this._flash(def.id);
    } else if (def.mode === 'toggle') {
      const held = !this._toggles.get(def.id);
      this._toggles.set(def.id, held);
      if (held) input.touchDown(def.code);
      else input.touchUp(def.code);
      setClass(this.btns.get(def.id), 'on', held);
    } else {
      input.touchDown(def.code);
      setClass(this.btns.get(def.id), 'on', true);
    }
  }

  _btnUp(e, def) {
    if (def.mode !== 'hold') return;
    this.input.touchUp(def.code);
    setClass(this.btns.get(def.id), 'on', false);
  }

  _flash(id) {
    const b = this.btns.get(id);
    setClass(b, 'on', true);
    setTimeout(() => setClass(b, 'on', false), 120);
  }

  /** Hide path: release everything so no virtual button sticks. */
  _releaseAll() {
    this.input.setTouchStick(0, 0, false);
    this.stickId = null;
    this.lookId = null;
    for (const def of BUTTONS) {
      if (def.mode === 'hold') this.input.touchUp(def.code);
      if (def.mode === 'toggle' && this._toggles.get(def.id)) {
        this._toggles.set(def.id, false);
        this.input.touchUp(def.code);
      }
      setClass(this.btns.get(def.id), 'on', false);
    }
    this.knob.style.transform = 'translate(-50%,-50%)';
  }

  dispose() {
    this._releaseAll();
    this.root.remove();
  }
}
