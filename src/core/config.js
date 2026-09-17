/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  /**
   * Handhelds. Same baked static shadows as low (no per-frame cascade render),
   * but leaner everywhere the GPU is weak: 0.6 render scale, no bloom pyramid,
   * tiny particle/decal pools, 2x anisotropy, half-res material bakes.
   * Auto-selected on phones/tablets (see detectMobile); `?q=` still overrides.
   */
  mobile: {
    renderScale: 0.6,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 45,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: false,
    anisotropy: 2,
    particleBudget: 1200,
    decalBudget: 32,
    staticShadows: true,
  },  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
    // Baked static sun shadows replace the per-frame CSM cascade render: the
    // sun depth of all static geometry is rendered ONCE into a single
    // world-covering shadow map (see src/render/staticshadows.js) and sampled
    // in the base pass. Dynamics stop casting (AI keeps its blob shadows), but
    // the cascade render — depth prepass not included — drops to zero.
    staticShadows: true,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
    staticShadows: false,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
    staticShadows: false,
  },
  ultra: {
    renderScale: 1.0,
    // 2048, not 4096: CascadedShadowMaps clamps to 2048 (4 x 4096 x R32F would
    // be 256 MB for shadows nobody can see), so the preset says what the
    // engine actually delivers. 2048 with PCSS reads sharper than 4096 flat.
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
    staticShadows: false,
  },
};

export const DEFAULTS = {
  quality: 'low',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

/**
 * True on phones/tablets: mobile UA, or a coarse pointer on a small screen
 * (covers iPadOS "desktop" UA when a touch screen is the primary input).
 * Guarded so it never throws outside a browser.
 */
export function detectMobile() {
  try {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Touch/i.test(ua)) return true;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
    const minDim = Math.min(screen.width || 0, screen.height || 0);
    return coarse && touch && minDim > 0 && minDim < 820;
  } catch {
    return false;
  }
}

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  if (cfg.isMobile === undefined) cfg.isMobile = detectMobile();
  /** Touch controls: 'auto' (show on touch devices), 'on' (force), 'off'. */
  if (cfg.touch === undefined) cfg.touch = 'auto';
  /** Quality the game booted with (menu Defaults restores this, not ultra). */
  cfg.defaultQuality = cfg.quality;
  cfg.setQuality = (name) => {
    const p = QUALITY_PRESETS[name];
    if (!p) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    // Drop keys the new preset does not define, so a removed flag can never
    // linger stale (matters for render.applyQuality, which diffs old vs new).
    for (const k of Object.keys(cfg.q)) if (!(k in p)) delete cfg.q[k];
    Object.assign(cfg.q, p);
  };
  return cfg;
}
