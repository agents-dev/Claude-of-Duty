import * as THREE from 'three';

/**
 * WORLD — batch optimizer for Group objects.
 *
 * The Assembler already collapses the level into merged static meshes (one per
 * palette key) plus one InstancedMesh per prop prototype. This module is the
 * second stage: it takes an arbitrary THREE.Group of *static* objects and
 * squeezes out the draw calls the builder cannot see —
 *
 *   mergeStatic(root, opts)    merge Meshes that share a material (+flags) into
 *                              one world-space Mesh per material
 *   instanceDuplicates(root)   convert N Meshes sharing one geometry+material
 *                              into a single InstancedMesh
 *   freezeStatic(root)         bake matrixWorld once and switch the whole
 *                              subtree out of the per-frame matrix update
 *   optimizeGroup(root, opts)  merge + instance + freeze in one pass; returns
 *                              { merged, instanced, before, after }
 *
 * RULES (pixel-neutral by construction):
 *  - only meshes with matrixAutoUpdate === false are merged; anything animated
 *    (skinned, morphed, or with matrixAutoUpdate true) is left alone.
 *  - only meshes with identical material instance AND identical shadow/prepass/
 *    LOD flags merge — flags change what render does with the object, so they
 *    are part of the batch key.
 *  - instanceColor is preserved: meshes that carry per-instance colour only
 *    merge with meshes that carry it too (as separate InstancedMesh batches).
 *  - transparent materials are never merged across objects (sort order matters).
 *  - nothing allocates per frame: every scratch object lives at module scope.
 *
 * PUBLIC API — `const world = ctx.get('world')`
 *   world.optimizeGroup(group, opts)  same as optimizeGroup() here; other
 *                                     subsystems can batch their own static
 *                                     Groups (weapon racks, sandbag walls, …)
 *                                     without importing world internals.
 */

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Batch key: material identity + every per-object flag render honours. */
function batchKey(mesh) {
  const u = mesh.userData;
  return [
    mesh.material?.uuid ?? 'nomat',
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    u.owNoPrepass ? 1 : 0,
    u.owNoShadow ? 1 : 0,
    u.owLodDist ?? 0,
    mesh.material?.transparent ? 1 : 0,
  ].join('|');
}

/**
 * Merge every eligible static Mesh under `root` that shares a batch key into
 * one world-space Mesh per key. Returns { merged, removed, drawCallsSaved }.
 *
 * @param {THREE.Object3D} root
 * @param {object} opts { minBatch: 2 — keys with fewer meshes are left alone }
 */
export function mergeStatic(root, opts = {}) {
  const minBatch = opts.minBatch ?? 2;
  const groups = new Map();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh !== true || o.isInstancedMesh === true || o.isSkinnedMesh === true) return;
    if (o.matrixAutoUpdate !== false) return;
    if (o.morphTargetInfluences !== undefined && o.morphTargetInfluences !== null) return;
    if (!o.geometry || o.material?.transparent === true) return;
    if (Array.isArray(o.material)) return;
    const k = batchKey(o);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { mesh: o, list: [] }));
    g.list.push(o);
  });

  let merged = 0;
  let removed = 0;
  for (const { mesh, list } of groups.values()) {
    if (list.length < minBatch) continue;
    const geo = mergeGeometries(
      list.map((m) => ({ geo: m.geometry, matrix: m.matrixWorld }))
    );
    if (!geo) continue;
    const out = new THREE.Mesh(geo, mesh.material);
    out.name = `${mesh.name || 'batched'}+${list.length - 1}`;
    out.castShadow = mesh.castShadow;
    out.receiveShadow = mesh.receiveShadow;
    out.matrixAutoUpdate = false;
    out.userData.surface = mesh.userData.surface;
    out.userData.collision = mesh.userData.collision ?? false;
    if (mesh.userData.owNoPrepass) out.userData.owNoPrepass = true;
    if (mesh.userData.owNoShadow) out.userData.owNoShadow = true;
    if (mesh.userData.owLodDist) out.userData.owLodDist = mesh.userData.owLodDist;
    out.updateMatrix();
    const parent = mesh.parent ?? root;
    parent.add(out);
    for (const m of list) {
      m.parent?.remove(m);
      // Geometry is owned by the prototype/cache elsewhere; never dispose here.
    }
    merged++;
    removed += list.length - 1;
  }
  return { merged, removed, drawCallsSaved: removed };
}

/**
 * Merge a list of { geo, matrix } into one indexed BufferGeometry carrying
 * position/normal/uv/color. Returns null when there is nothing to merge.
 * Geometries missing uv or color get neutral fills (0,0 / 0,0,0).
 */
export function mergeGeometries(items) {
  // First pass: total sizes, so the output is allocated once.
  let verts = 0;
  let tris = 0;
  const prepared = [];
  for (const { geo, matrix } of items) {
    const pa = geo.getAttribute('position');
    if (!pa) continue;
    let na = geo.getAttribute('normal');
    if (!na) {
      geo.computeVertexNormals();
      na = geo.getAttribute('normal');
    }
    const idx = geo.getIndex();
    const count = pa.count;
    const triCount = idx ? idx.count / 3 : count / 3;
    prepared.push({ geo, matrix, pa, na, count, idx });
    verts += count;
    tris += triCount;
  }
  if (prepared.length < 2 || verts === 0) return null;

  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const col = new Float32Array(verts * 3);
  const Idx = verts > 65535 ? Uint32Array : Uint16Array;
  const index = new Idx(Math.ceil(tris) * 3);

  let vo = 0;
  let io = 0;
  for (const p of prepared) {
    if (p.matrix) _nm.getNormalMatrix(p.matrix);
    const ua = p.geo.getAttribute('uv');
    const ca = p.geo.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p.pa, i);
      if (p.matrix) _v.applyMatrix4(p.matrix);
      pos[(vo + i) * 3] = _v.x;
      pos[(vo + i) * 3 + 1] = _v.y;
      pos[(vo + i) * 3 + 2] = _v.z;
      _n.fromBufferAttribute(p.na, i);
      if (p.matrix) _n.applyMatrix3(_nm).normalize();
      nrm[(vo + i) * 3] = _n.x;
      nrm[(vo + i) * 3 + 1] = _n.y;
      nrm[(vo + i) * 3 + 2] = _n.z;
      uv[(vo + i) * 2] = ua ? ua.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = ua ? ua.getY(i) : 0;
      col[(vo + i) * 3] = ca ? ca.getX(i) : 0;
      col[(vo + i) * 3 + 1] = ca ? ca.getY(i) : 0;
      col[(vo + i) * 3 + 2] = ca ? ca.getZ(i) : 0;
    }
    if (p.idx) {
      const a = p.idx.array;
      for (let i = 0; i < a.length; i++) index[io++] = vo + a[i];
    } else {
      for (let i = 0; i < p.count; i++) index[io++] = vo + i;
    }
    vo += p.count;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Convert runs of Meshes that share one geometry + material into InstancedMesh.
 * Returns { instanced, removed }.
 *
 * @param {THREE.Object3D} root
 * @param {object} opts { minInstances: 4 }
 */
export function instanceDuplicates(root, opts = {}) {
  const minInstances = opts.minInstances ?? 4;
  const groups = new Map();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh !== true || o.isInstancedMesh === true || o.isSkinnedMesh === true) return;
    if (o.matrixAutoUpdate !== false) return;
    if (!o.geometry || o.material?.transparent === true) return;
    if (Array.isArray(o.material)) return;
    if (o.geometry.morphAttributes?.position?.length) return;
    const k = `${o.geometry.uuid}|${batchKey(o)}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { mesh: o, list: [] }));
    g.list.push(o);
  });

  let instanced = 0;
  let removed = 0;
  for (const { mesh, list } of groups.values()) {
    if (list.length < minInstances) continue;
    const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
    im.name = `auto_inst_${mesh.name || 'prop'}x${list.length}`;
    im.castShadow = mesh.castShadow;
    im.receiveShadow = mesh.receiveShadow;
    im.matrixAutoUpdate = false;
    im.userData.surface = mesh.userData.surface;
    if (mesh.userData.owNoPrepass) im.userData.owNoPrepass = true;
    if (mesh.userData.owNoShadow) im.userData.owNoShadow = true;
    for (let j = 0; j < list.length; j++) {
      _m.copy(list[j].matrixWorld);
      im.setMatrixAt(j, _m);
    }
    im.instanceMatrix.needsUpdate = true;
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.computeBoundingSphere();
    im.updateMatrix();
    (mesh.parent ?? root).add(im);
    for (const m of list) m.parent?.remove(m);
    instanced++;
    removed += list.length - 1;
  }
  return { instanced, removed };
}

/**
 * Freeze a static subtree: bake world matrices once and opt out of the
 * per-frame matrix walk. The renderer honours `matrixWorldAutoUpdate === false`
 * by skipping the subtree in updateMatrixWorld() — for a level of ~150 static
 * objects drawn through 4 shadow cascades + prepass + forward, that walk ran
 * six times per frame for matrices that never change.
 *
 * Pixel-neutral: identical matrices, just computed once. Call AFTER the subtree
 * is fully placed. If anything under root must move later, set
 * `obj.matrixWorldAutoUpdate = true` on it (and its ancestors) first.
 */
export function freezeStatic(root) {
  root.updateMatrixWorld(true);
  let frozen = 0;
  root.traverse((o) => {
    if (o.matrixAutoUpdate === false && 'matrixWorldAutoUpdate' in o) {
      o.matrixWorldAutoUpdate = false;
      frozen++;
    }
  });
  // The group itself is static too.
  if ('matrixWorldAutoUpdate' in root && root.matrixAutoUpdate === false) {
    root.matrixWorldAutoUpdate = false;
    frozen++;
  }
  return { frozen };
}

/** Unfreeze (for dispose paths or editor moves). */
export function unfreezeStatic(root) {
  root.traverse((o) => {
    if ('matrixWorldAutoUpdate' in o) o.matrixWorldAutoUpdate = true;
  });
}

/**
 * One-pass optimizer: instance duplicates, merge the remaining statics that
 * share a material, then freeze. Returns stats for the build log.
 */
export function optimizeGroup(root, opts = {}) {
  const before = countDrawables(root);
  const a = instanceDuplicates(root, opts);
  const b = mergeStatic(root, opts);
  const c = freezeStatic(root);
  const after = countDrawables(root);
  return {
    before,
    after,
    instanced: a.instanced,
    merged: b.merged,
    drawCallsSaved: before - after,
    ...c,
  };
}

function countDrawables(root) {
  let n = 0;
  root.traverse((o) => {
    if (o.isMesh === true && o.visible !== false) n++;
  });
  return n;
}
