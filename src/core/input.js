/**
 * Input aggregation: keyboard, mouse (pointer-locked), gamepad and touch,
 * exposed as a stable per-frame snapshot so gameplay never touches raw DOM
 * events.
 *
 * Touch feeds the SAME snapshot: the virtual joystick overwrites the stick
 * vector, look drags accumulate into the look delta, and buttons inject the
 * keyboard/mouse codes they mirror — so movement, sprint, fire, ADS and every
 * edge query work with zero gameplay changes.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    // ---- touch -----------------------------------------------------------
    // touchMode shows the virtual controls; it latches on the first touch but
    // also honours the coarse-pointer heuristic and the `?touch=` override, so
    // desktop testing and mobile emulation both behave.
    this.touchMode = config.touch === 'on';
    if (config.touch !== 'off' && !this.touchMode) {
      try {
        this.touchMode =
          matchMedia('(pointer: coarse)').matches &&
          ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);
      } catch {
        this.touchMode = false;
      }
    }
    /** Virtual joystick state, gamepad-axes convention (up = -y). */
    this.touchStick = { x: 0, y: 0, active: false };
    this._touchLook = { x: 0, y: 0 };
    /** Touch drags cover less ground than a mouse, so they get extra gain. */
    this.touchLookGain = 2.2;

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  requestPointerLock() {
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    if (!this.pointerLocked && e.button === 0) this.requestPointerLock();
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._rawLook.x = 0;
    this._rawLook.y = 0;
    this._touchLook.x = 0;
    this._touchLook.y = 0;
    this.touchStick.x = 0;
    this.touchStick.y = 0;
    this.touchStick.active = false;
  }

  // ---- touch controls (see src/ui/touch.js) -------------------------------

  /** Virtual button held: injects a keyboard/mouse code into the edge queues. */
  touchDown(code) {
    if (!this.enabled) return;
    this.touchMode = true;
    this._pendingDown.add(code);
  }

  /** Virtual button released. */
  touchUp(code) {
    if (!this.enabled) return;
    this._pendingUp.add(code);
  }

  /** Virtual button tapped: down + up across this frame's edge queues. */
  touchTap(code) {
    if (!this.enabled) return;
    this.touchMode = true;
    this._pendingDown.add(code);
    this._pendingUp.add(code);
  }

  /** Look drag in CSS pixels from the touch layer. */
  addTouchLook(dx, dy) {
    if (!this.enabled || this.frozen) return;
    this.touchMode = true;
    this._touchLook.x += dx;
    this._touchLook.y += dy;
  }

  /** Virtual joystick, gamepad-axes convention (up = -y), unit disc. */
  setTouchStick(x, y, active = true) {
    this.touchStick.x = x;
    this.touchStick.y = y;
    this.touchStick.active = active;
    if (active) this.touchMode = true;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    // Touch drags join the mouse delta with extra gain (see touchLookGain).
    this._rawLook.x += this._touchLook.x * this.touchLookGain;
    this._rawLook.y += this._touchLook.y * this.touchLookGain;
    this._touchLook.x = 0;
    this._touchLook.y = 0;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s;
    this.look.y = this.frozen ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
    // The virtual joystick wins over a gamepad stick: a thumb on glass is
    // deliberate, a resting gamepad stick is noise.
    if (this.touchStick.active) {
      this.stick.moveX = this.touchStick.x;
      this.stick.moveY = this.touchStick.y;
    }
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
