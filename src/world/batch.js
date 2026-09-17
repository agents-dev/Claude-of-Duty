import * as THREE from 'three';
import { Accum } from './util.js';

/**
 * WORLD — batch optimizer for Group objects.
 *
 * Two jobs, one file:
 *
 *   1. `BatchOptimizer.optimizeGroup(group, opts)` — generic, reusable: walk an
 *      arbitrary THREE.Group/Object3D hierarchy, find the static Mesh children
 *      that share a material, and merge each material group into a single Mesh
 *      with baked world transforms. Fewer draw calls, identical pixels (same
 *      geometry, same material, same world matrices — just fewer objects).
 *
 *   2. `consolidateSmallBatches(assembler, root, opts)` — world-specific: the
 *      Assembler's instanced pass emits one InstancedMesh draw per prototype
 *      per spatial chunk. Prototypes with only a handful of instances (a couple
 *      of gas bottles, one planter, ...) each still cost a full draw through
 *      the forward pass, the depth prepass and all four shadow cascades.
 *      Prototypes below `maxInstances` that share a material AND the same
 *      render flags are baked into one merged static Mesh instead. This also
 *      drops the `instanced + instanceColor` shader permutation for those
 *      props, which is pure boot/compile budget saved.
 *
 * Both paths are build-time only: they allocate during `finalize()` and never
 * per frame. Everything merged is static world geometry (matrixAutoUpdate is
 * already false on it), so baking the transform is exact.
 *
 * Pixel-neutrality notes:
 *   - Instance tint masks (`instanceColor`) multiply the vertex mask colour in
 *     three's `color_vertex` chunk (`vColor *= instanceColor`), so the merge
 *     multiplies the baked vertex colour by the same mask. Same floats in,
 *     same floats out.
 *   - Only prototypes with identical `castShadow / receiveShadow / owNoPrepass`
 *     flags merge together, so prepass/shadow membership is unchanged.
 *   - Prototypes with a distance-LOD (`maxDist > 0`) are never merged: their
 *     per-mesh visibility toggling would be lost.
 */

/**
 * Prototypes with at most this many instances are baked to a static merge
 * instead of an InstancedMesh. 8 keeps the merged vertex counts small while
 * catching the long tail of one-off props.
 */
export const SMALL_BATCH_MAX = 8;

/** Stagger mask for the LOD pass (see Assembler.updateLod): 1/4 of the list. */
export const LOD_STRIDE = 4;

const _sph = new THREE.Sphere();

export class BatchOptimizer {
  /**
   * Merge the static Mesh children of a Group hierarchy by material.
   *
   * A Mesh counts as static when `mesh.matrixAutoUpdate === false` (the world
   * convention for baked geometry) or `mesh.userData.static === true`, and it
   * is skipped when it is skinned, instanced, has morph targets, or is
   * invisible. Callers must have called `group.updateMatrixWorld(true)` first
   * (this method does it for you when `opts.updateMatrixWorld !== false`).
   *
   * @param {THREE.Object3D} group
   * @param {object} [opts]
   * @param {number} [opts.minMerge=2]  merge a material group only when it has
   *   at least this many meshes (avoids churning singletons).
   * @param {boolean} [opts.updateMatrixWorld=true]
   * @returns {{ groups: number, before: number, after: number, tris: number }}
   */
  static optimizeGroup(group, opts = {}) {
    const minMerge = opts.minMerge ?? 2;
    if (opts.updateMatrixWorld !== false) group.updateMatrixWorld(true);

    // material uuid -> { material, list: [{ geo, matrix }] }
    const buckets = new Map();
    const meshes = [];
    group.traverse((o) => {
      if (o.isMesh !== true || o.isInstancedMesh === true || o.isSkinnedMesh === true) return;
      if (o.visible === false || o.geometry == null || o.material == null) return;
      if (Array.isArray(o.material)) return; // multi-material: leave alone
      if (o.morphTargetInfluences !== undefined && o.morphTargetInfluences !== null) {
        if (o.morphTargetInfluences.length > 0) return;
      }
      const isStatic = o.matrixAutoUpdate === false || o.userData.static === true;
      if (!isStatic) return;
      meshes.push(o);
      const key = o.material.uuid;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material: o.material, list: [] }));
      b.list.push(o);
    });

    const stats = { groups: 0, before: meshes.length, after: meshes.length, tris: 0 };
    if (meshes.length < minMerge) return stats;

    for (const b of buckets.values()) {
      if (b.list.length < minMerge) continue;
      // All members must agree on the render flags, or the merge would change
      // which passes see the geometry.
      const ref = b.list[0];
      const flags = BatchOptimizer._flagsOf(ref);
      let same = true;
      for (let i = 1; i < b.list.length; i++) {
        if (BatchOptimizer._flagsOf(b.list[i]) !== flags) {
          same = false;
          break;
        }
      }
      if (!same) continue;

      const acc = new Accum(`batch:${ref.name || 'static'}`);
      for (const m of b.list) acc.add(m.geometry, m.matrixWorld);
      if (acc.empty) continue;
      const geo = acc.build();
      const merged = new THREE.Mesh(geo, b.material);
      merged.name = `batch_${ref.name || 'static'}`;
      merged.castShadow = ref.castShadow;
      merged.receiveShadow = ref.receiveShadow;
      merged.matrixAutoUpdate = false;
      merged.updateMatrix();
      merged.userData.surface = ref.userData.surface;
      merged.userData.collision = ref.userData.collision ?? false;
      if (ref.userData.owNoPrepass === true) merged.userData.owNoPrepass = true;
      if (ref.userData.owNoShadow === true) merged.userData.owNoShadow = true;
      if (ref.userData.owProbe === true) merged.userData.owProbe = true;
      group.add(merged);

      for (const m of b.list) {
        m.parent?.remove(m);
        // Geometry is owned by whoever built the group; do not dispose here.
      }
      stats.groups++;
      stats.after -= b.list.length - 1;
      stats.tris += geo.index.count / 3;
    }
    return stats;
  }

  static _flagsOf(m) {
    return (
      `${m.castShadow ? 1 : 0}|${m.receiveShadow ? 1 : 0}|` +
      `${m.userData.owNoPrepass === true ? 1 : 0}|${m.userData.owNoShadow === true ? 1 : 0}`
    );
  }
}

/**
 * Bake small instanced prototypes into merged static meshes.
 *
 * Runs inside `Assembler.finalize()` BEFORE the instanced pass: every
 * prototype with `0 < n <= maxInstances`, no distance LOD and a plain
 * single-sided opaque material group is consumed here (its matrices/masks are
 * cleared so the instanced pass skips it) and merged per material+flags.
 *
 * @param {object} assembler  the Assembler (uses .mat/.surfaceOf/.stats/.meshes)
 * @param {THREE.Object3D} root
 * @param {object} [opts]
 * @param {number} [opts.maxInstances=SMALL_BATCH_MAX]
 * @returns {{ mergedMeshes: number, consumedProtos: number, consumedInstances: number }}
 */
export function consolidateSmallBatches(assembler, root, opts = {}) {
  const maxInstances = opts.maxInstances ?? SMALL_BATCH_MAX;
  const out = { mergedMeshes: 0, consumedProtos: 0, consumedInstances: 0 };

  // material key + render flags -> { key, castShadow, receiveShadow, noPrepass, items }
  const groups = new Map();
  for (const p of assembler._protos.values()) {
    const n = p.matrices.length;
    if (n === 0 || n > maxInstances) continue;
    if (p.maxDist > 0) continue; // distance LOD must keep its own mesh
    if (!p.geo?.getAttribute?.('position')) continue;
    const gk = `${p.key}|${p.castShadow ? 1 : 0}|${p.receiveShadow ? 1 : 0}|${p.noPrepass ? 1 : 0}`;
    let g = groups.get(gk);
    if (!g) {
      groups.set(
        gk,
        (g = {
          key: p.key,
          castShadow: p.castShadow,
          receiveShadow: p.receiveShadow,
          noPrepass: p.noPrepass,
          protos: [],
        })
      );
    }
    g.protos.push(p);
  }

  for (const g of groups.values()) {
    const acc = new Accum(`world:batch:${g.key}`);
    let count = 0;
    for (const p of g.protos) {
      for (let i = 0; i < p.matrices.length; i++) {
        const base = acc.verts;
        acc.add(p.geo, p.matrices[i]);
        // instanceColor multiplies vColor in the shader, so bake the same
        // multiply into the merged vertex colours.
        const mask = p.masks[i];
        if (mask) {
          const col = acc.col;
          for (let v = base; v < acc.verts; v++) {
            col[v * 3] *= mask[0];
            col[v * 3 + 1] *= mask[1];
            col[v * 3 + 2] *= mask[2];
          }
        }
        count++;
      }
    }
    if (acc.empty) continue;
    const geo = acc.build();
    const mesh = new THREE.Mesh(geo, assembler.mat(g.key));
    mesh.name = `world_batch_${g.key}`;
    mesh.castShadow = g.castShadow;
    mesh.receiveShadow = g.receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.userData.surface = assembler.surfaceOf(g.key);
    mesh.userData.collision = false;
    if (g.noPrepass) mesh.userData.owNoPrepass = true;
    mesh.updateMatrix();
    root.add(mesh);
    assembler.meshes.push(mesh);
    assembler.stats.drawCalls++;
    assembler.stats.staticTris += geo.index.count / 3;
    assembler.stats.instances += count;
    out.mergedMeshes++;
    out.consumedProtos += g.protos.length;
    out.consumedInstances += count;

    for (const p of g.protos) {
      p.matrices.length = 0;
      p.masks.length = 0;
    }
  }
  return out;
}

/**
 * Staggered distance-LOD check shared by the world's prop clouds.
 *
 * The full list is too cheap to matter per item but not per frame at 120 Hz
 * physics-adjacent rates: each entry is visited once every `stride` frames
 * (round-robin by index), and the distance test is sqrt-free.
 *
 * @param {THREE.Object3D[]} lodGroups  meshes with boundingSphere + userData.owLodDist
 * @param {THREE.Vector3} camPos
 * @param {number} frame  monotonically increasing frame counter
 * @param {number} [stride=LOD_STRIDE]
 */
export function updateLodStaggered(lodGroups, camPos, frame, stride = LOD_STRIDE) {
  const slot = frame % stride;
  for (let i = 0; i < lodGroups.length; i++) {
    if ((i % stride) !== slot) continue;
    const im = lodGroups[i];
    const s = im.boundingSphere;
    if (!s) continue;
    _sph.copy(s);
    const d2 = camPos.distanceToSquared(_sph.center);
    const r = _sph.radius + im.userData.owLodDist;
    im.visible = d2 < r * r;
  }
}
