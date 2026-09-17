import * as THREE from 'three';

/**
 * Baked static sun shadows.
 *
 * The per-frame CSM cascade render — one depth draw of the whole scene per
 * cascade, plus the PCSS/PCF sampling cost in every lit pixel — is the single
 * most expensive thing the renderer does that a *static* level does not need
 * every frame. Nothing it draws moves: buildings, props, ground. Only the sun
 * (time of day) and the actors move.
 *
 * So on the low preset the cascades stay off and the sun depth of all static
 * geometry is rendered ONCE into a single world-covering shadow map, then
 * sampled in the base pass (`owBakedShadow`, injected by materialpatch.js next
 * to `owSunShadow`). Cost per frame after the bake: one 2x2 PCF tap per lit
 * pixel. Re-bakes only when the sun has moved ~0.5 degrees (throttled to one
 * bake per 30 frames), so a fixed time of day pays exactly one depth render.
 *
 * Deliberate trade-offs, all confined to the low preset:
 *   - Dynamic objects (AI soldiers, grenades) stop CASTING sun shadows. They
 *     still RECEIVE the baked field at their world position (approximately
 *     right — the map is world-space), and AI keeps its blob ground shadows,
 *     so nothing floats.
 *   - One 2048 map over ~130 m is ~6.5 cm/texel with a 2x2 kernel: softer and
 *     coarser than 4xPCSS cascades. That is what "low" means.
 *
 * Pixel-neutrality: the shader path is compiled into every chunk but returns
 * 1.0 unless `owBakedParams.x` is set, which only happens after a successful
 * bake — and bakes only run when the low preset asked for them.
 */

/** Single-layer baked map resolution. 2048 over the map is ~6.5 cm/texel. */
export const BAKED_SIZE = 2048;

/** Sun-travel threshold (dot) that triggers a re-bake: ~0.5 degrees. */
export const REBAKE_DOT = 0.99995;

/** Minimum frames between re-bakes. */
export const REBAKE_INTERVAL = 30;

const _sphere = new THREE.Sphere();
const _center = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _mat = new THREE.Matrix4();
const _origin = new THREE.Vector4();

/** Uniform objects shared by reference into every patched material. */
export function createBakedUniforms() {
  return {
    owBakedMap: { value: null },
    owBakedMatrix: { value: new THREE.Matrix4() },
    // x: enable (0/1), y: strength, z: world texel size (m), w: frustum range (m)
    owBakedParams: { value: new THREE.Vector4(0, 1, 0.01, 1) },
    // x: size px, y: 1/size
    owBakedMapSize: { value: new THREE.Vector2(BAKED_SIZE, 1 / BAKED_SIZE) },
  };
}

/**
 * Sampled by `owSunShadow()` (see csm.js). Declared BEFORE it: GLSL needs the
 * declaration first. Everything here is a no-op returning 1.0 until a bake
 * enables it, so compiling it into every chunk costs nothing at runtime.
 */
export const BAKED_GLSL = /* glsl */ `
uniform sampler2D owBakedMap;
uniform mat4 owBakedMatrix;
uniform vec4 owBakedParams;
uniform vec2 owBakedMapSize;

float owBakedShadow( vec3 wPos, vec3 wN, float NdL ) {
  if ( owBakedParams.x < 0.5 ) return 1.0;
  vec3 p = wPos + wN * ( owBakedParams.z * 1.2 );
  vec4 sc = owBakedMatrix * vec4( p, 1.0 );
  vec3 proj = sc.xyz / sc.w * 0.5 + 0.5;
  if ( proj.z >= 1.0 || proj.z <= 0.0 ) return 1.0;
  vec2 edge = min( proj.xy, 1.0 - proj.xy );
  if ( min( edge.x, edge.y ) <= 0.0 ) return 1.0;
  float slope = clamp( sqrt( max( 0.0, 1.0 - NdL * NdL ) ) / max( NdL, 0.12 ), 0.0, 5.0 );
  float recv = proj.z - ( owBakedParams.z * ( 0.7 + 1.15 * slope ) ) / owBakedParams.w;
  vec2 o = vec2( owBakedMapSize.y * 0.5 );
  float sum = 0.0;
  sum += step( recv, texture2D( owBakedMap, proj.xy + vec2( -o.x, -o.y ) ).r );
  sum += step( recv, texture2D( owBakedMap, proj.xy + vec2( o.x, -o.y ) ).r );
  sum += step( recv, texture2D( owBakedMap, proj.xy + vec2( -o.x, o.y ) ).r );
  sum += step( recv, texture2D( owBakedMap, proj.xy + vec2( o.x, o.y ) ).r );
  return mix( 1.0, sum * 0.25, owBakedParams.y );
}
`;

export class StaticShadows {
  constructor() {
    this.size = BAKED_SIZE;
    /** Allocated lazily on the first bake, so higher presets pay nothing. */
    this.rt = null;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1000);
    this.camera.matrixAutoUpdate = false;
    /** Mirror of the uniforms patcher shares into materials (set in attach). */
    this.uniforms = null;
    /** Intent: the active preset wants baked shadows (not yet the shader flag). */
    this.enabled = false;
    /** A usable bake exists and the shader flag is live. */
    this.baked = false;
    this.lastSun = new THREE.Vector3(0, -1, 0);
    this.lastFrame = -1e9;
    this._prevClear = new THREE.Color();
  }

  /** Point the shared uniform objects at this baker. Called once by render. */
  attach(uniforms) {
    this.uniforms = uniforms;
  }

  /** Arm (or disarm) baked shadows. The shader flag goes live on first bake. */
  setEnabled(on, strength = 1) {
    this.enabled = on === true;
    if (this.uniforms) {
      // Disarming is immediate; arming waits for a bake so an unbaked map can
      // never darken a pixel (it would sample null/clear colour).
      if (!this.enabled) {
        this.uniforms.owBakedParams.value.x = 0;
        this.baked = false;
      }
      this.uniforms.owBakedParams.value.y = strength;
    }
  }

  /**
   * Fit the ortho camera to `bounds` along `sunDir` (sunDir points TOWARD the
   * sun) with a texel-snapped projection, exactly like one CSM cascade that
   * covers the whole map. Writes the sampling uniforms; draws nothing.
   */
  fit(sunDir, bounds) {
    bounds.getBoundingSphere(_sphere);
    _center.copy(_sphere.center);
    const r = Math.ceil(_sphere.radius * 16) / 16;
    const back = r + 5;

    const cam = this.camera;
    const up = Math.abs(sunDir.y) > 0.98 ? _altUp : _up;
    cam.position.copy(_center).addScaledVector(sunDir, r + back);
    cam.up.copy(up);
    cam.lookAt(_center);
    cam.updateMatrix();
    cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0;
    cam.far = 2 * r + back;
    cam.updateProjectionMatrix();

    // Texel snap: nail the sample grid to world space so a re-bake after a
    // small sun move does not swim (same trick as csm.js).
    _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _origin.set(0, 0, 0, 1).applyMatrix4(_mat);
    const half = this.size * 0.5;
    const dx = (Math.round(_origin.x * half) - _origin.x * half) / half;
    const dy = (Math.round(_origin.y * half) - _origin.y * half) / half;
    cam.projectionMatrix.elements[12] += dx;
    cam.projectionMatrix.elements[13] += dy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    if (this.uniforms) {
      this.uniforms.owBakedMatrix.value.multiplyMatrices(
        cam.projectionMatrix,
        cam.matrixWorldInverse
      );
      this.uniforms.owBakedParams.value.z = (2 * r) / this.size;
      this.uniforms.owBakedParams.value.w = cam.far - cam.near;
    }
    return r;
  }

  /**
   * Render the depth of the currently-visible static casters into the map.
   * The caller hides everything dynamic first; this only binds, clears and
   * draws with the CSM depth material (which already handles instancing).
   */
  renderStatic(renderer, scene, depthMaterial) {
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(this.size, this.size, {
        type: THREE.FloatType,
        format: THREE.RedFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.rt.texture.name = 'baked-static-shadow';
      if (this.uniforms) this.uniforms.owBakedMap.value = this.rt.texture;
    }
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this._prevClear);
    const prevAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = depthMaterial;
    renderer.autoClear = false;
    // Clear to white = fully lit: texels no caster reaches stay unshadowed.
    renderer.setClearColor(0xffffff, 1);
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(this._prevClear, prevAlpha);
    renderer.setRenderTarget(null);
  }

  /** Mark a bake complete and raise the shader flag. */
  finish(frame, sunDir) {
    this.baked = true;
    this.lastSun.copy(sunDir);
    this.lastFrame = frame;
    if (this.uniforms) this.uniforms.owBakedParams.value.x = this.enabled ? 1 : 0;
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    if (this.uniforms) {
      this.uniforms.owBakedMap.value = null;
      this.uniforms.owBakedParams.value.x = 0;
    }
    this.uniforms = null;
    this.baked = false;
    this.enabled = false;
  }
}
