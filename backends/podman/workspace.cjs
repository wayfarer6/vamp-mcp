'use strict';
/** Planning only. No filesystem, credentials, mounts, process or engine access.
 * readVerifiedSnapshot is installed ONLY by the trusted composition root, never
 * from MCP/UI arguments. It must combine authenticated Vault, OS and engine
 * observations, not return user-supplied assertions. There is no production
 * probe adapter yet; the default planner is deliberately unavailable.
 * mountId/scopeId identify a mounted volume and dedicated, authorized subfolder.
 * A path string or volume label alone is not an identity.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOPOLOGIES = new Set(['linux-local', 'wsl', 'windows-debian-vm']);
const ACTIONS = Object.freeze({
  unavailable: 'verify', missing: 'configure', locked: 'unlock_explicitly',
  engine_not_visible: 'verify_engine_mapping', recreate_required: 'recreate_explicitly',
  restart_required: 'start_explicitly', ready: 'none',
});
const reason = (state, why, topology) => Object.freeze({
  state, recommendation: ACTIONS[state], reason: why,
  ...(topology ? { topology, destination: '/workspace', access: 'rw', exclusiveWriter: true } : {}),
});
const opaque = value => typeof value === 'string' && ID.test(value);

// Internal pure decision function: intentionally not exported for raw UI input.
function planWorkspace(snapshot, targetId, now) {
  if (!snapshot || snapshot.targetId !== targetId || !TOPOLOGIES.has(snapshot.topology))
    return reason('unavailable', 'invalid_target_evidence');
  if (!Number.isFinite(snapshot.observedAt) || !Number.isFinite(now) ||
      snapshot.observedAt > now || now - snapshot.observedAt > 30000)
    return reason('unavailable', 'stale_evidence');
  const { volume: v, engine: e, writers: w, container: c, topology } = snapshot;
  if (!v || typeof v.present !== 'boolean') return reason('unavailable', 'volume_unverified');
  if (!v.present) return reason('missing', 'volume_missing');
  if (typeof v.unlocked !== 'boolean') return reason('unavailable', 'lock_state_unverified');
  if (!v.unlocked) return reason('locked', 'volume_locked');
  if (!opaque(v.mountId) || !opaque(v.scopeId) || v.dedicated !== true ||
      v.containsSensitiveMaterial !== false || v.symlinkFree !== true || v.scopeAuthorized !== true)
    return reason('unavailable', 'dedicated_scope_unverified');
  if (!e || e.visible !== true || e.mappingVerified !== true ||
      e.mountId !== v.mountId || e.scopeId !== v.scopeId)
    return reason('engine_not_visible', 'engine_mapping_unverified');
  // All topologies require a real engine-side identity check. In particular,
  // a Windows/WSL host path is not evidence of a Debian VM/engine mount.
  if (e.rootless !== true) return reason('unavailable', 'rootless_engine_unverified');
  if (!w || w.known !== true || !Array.isArray(w.ids) || w.ids.some(id => !opaque(id)))
    return reason('unavailable', 'writer_usage_unverified');
  if (!c || typeof c.exists !== 'boolean') return reason('unavailable', 'container_unverified');
  if (w.ids.length > 1 || (w.ids.length === 1 && (!c.exists || w.ids[0] !== c.id)))
    return reason('unavailable', 'writer_conflict');
  if (!c.exists) return reason('recreate_required', 'container_missing', topology);
  if (!opaque(c.id) || typeof c.running !== 'boolean') return reason('unavailable', 'container_unverified');
  if (c.mountId !== v.mountId || c.scopeId !== v.scopeId ||
      c.destination !== '/workspace' || c.access !== 'rw')
    return reason('recreate_required', 'container_mount_mismatch', topology);
  if (!c.running) return reason('restart_required', 'container_stopped', topology);
  if (w.ids.length !== 1 || w.ids[0] !== c.id) return reason('unavailable', 'writer_usage_unverified');
  if (c.insideReadWriteVerified !== true) return reason('unavailable', 'container_read_write_unverified');
  return reason('ready', 'verified_workspace', topology);
}

function createWorkspacePlanner({ readVerifiedSnapshot, now = Date.now } = {}) {
  return Object.freeze({
    async planWorkspace(targetId) {
      if (!opaque(targetId)) return reason('unavailable', 'invalid_target');
      if (typeof readVerifiedSnapshot !== 'function') return reason('unavailable', 'trusted_probe_unavailable');
      try {
        // Pass only an opaque target ID. Never accept an evidence object here.
        const snapshot = await readVerifiedSnapshot(targetId);
        return planWorkspace(snapshot, targetId, now());
      } catch {
        // Probe errors may contain hosts, paths, tokens or credential details.
        return reason('unavailable', 'trusted_probe_failed');
      }
    },
  });
}
module.exports = { createWorkspacePlanner };
