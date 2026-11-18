'use strict';
/**
 * Source-only, read-only workspace policy. NOT an authorization or mount service.
 * Readers must be wired by trusted host code to authenticated observations and
 * owner approvals, never to MCP/webview input, arbitrary files, or a verified:true
 * field. There is intentionally no default reader and no existing Vault wiring.
 * A result is a point-in-time observation, never a reusable dismount permit.
 */
const path=require('node:path');
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_AGE=5000;
const validId=value=>typeof value==='string'&&IDENTIFIER.test(value);
const fresh=(time,now)=>Number.isSafeInteger(time)&&time<=now&&now-time<=MAX_AGE;
function canonicalDirectory(value){
  return typeof value==='string'&&value.startsWith('/')&&value!=='/'&&value.length<=4096&&
    !/[\\\x00-\x1f\x7f]/.test(value)&&path.posix.normalize(value)===value&&
    !value.split('/').some(segment=>segment==='.'||segment==='..'||!segment&&value.indexOf('//')>=0);
}
function createWorkspacePolicy({readTrustedState,readTrustedApproval,now=Date.now}={}){
  const sourcesAvailable=typeof readTrustedState==='function'&&typeof readTrustedApproval==='function';
  const unavailable=()=>({state:'unverified',reason:'trusted_workspace_sources_unavailable',accessGranted:false});
  async function status(input){
    // Request cannot supply paths, approvals, evidence, keys or safety booleans.
    if(!input||Object.keys(input).some(k=>!['workloadId','volumeId'].includes(k))||!validId(input.workloadId)||!validId(input.volumeId))
      return {state:'unverified',reason:'invalid_request',accessGranted:false};
    if(!sourcesAvailable)return unavailable();
    const {workloadId,volumeId}=input;
    const result=(state,reason)=>({state,reason,workloadId,volumeId,accessGranted:false});
    try{
      const [state,approval]=await Promise.all([readTrustedState({workloadId,volumeId}),readTrustedApproval({workloadId,volumeId})]);
      const time=now();
      if(!state||!fresh(state.observedAt,time)||state.workloadId!==workloadId||state.volumeId!==volumeId)
        return result('unverified','missing_stale_or_mismatched_observation');
      if(state.mounted!==true)return result('locked','volume_not_verified_mounted');
      if(state.engineVisible!==true)return result('engine_not_visible','mount_not_visible_on_engine_host');
      if(!canonicalDirectory(state.directory)||state.access!=='rw'||state.rootless!==true||state.directoryVerified!==true||state.noSensitiveFiles!==true)
        return result('unverified','workspace_boundary_not_verified');
      // directoryVerified means trusted reader checked canonical mount identity,
      // symlinks/reparse points and dedicated subfolder boundaries on engine host.
      // noSensitiveFiles covers KDBX/master keys/certificates and credential stores;
      // this module itself never opens a directory or scans those files.
      if(!approval||approval.workloadId!==workloadId||approval.volumeId!==volumeId||approval.directory!==state.directory||approval.access!=='rw'||
         !Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=time)
        return result('approval_required','exact_workload_volume_directory_rw_approval_required');
      if(state.usageComplete!==true||!Array.isArray(state.activeWorkloads)||state.activeWorkloads.length>1000||!state.activeWorkloads.every(validId))
        return result('unverified','writer_inventory_unknown');
      if(state.activeWorkloads.some(id=>id!==workloadId))return result('busy','another_workload_uses_volume');
      if(state.requiresRecreate===true)return result('recreate_required','existing_container_mount_differs');
      if(state.requiresRestart===true)return result('restart_required','container_needs_restart');
      if(state.requiresRecreate!==false||state.requiresRestart!==false)return result('unverified','container_mount_state_unknown');
      return {...result('ready','observed_scope_matches_approval'),readOnlyObservation:true};
    }catch{return result('unverified','trusted_workspace_observation_failed');}
  }
  async function canDismount(input){
    if(!input||Object.keys(input).some(k=>k!=='volumeId')||!validId(input.volumeId))return {blocked:true,reason:'invalid_request'};
    if(typeof readTrustedState!=='function')return {blocked:true,reason:'trusted_workspace_sources_unavailable'};
    try{
      const state=await readTrustedState({volumeId:input.volumeId});
      if(!state||state.volumeId!==input.volumeId||!fresh(state.observedAt,now())||state.mounted!==true||state.usageComplete!==true||
         !Array.isArray(state.activeWorkloads)||state.activeWorkloads.length>1000||!state.activeWorkloads.every(validId))
        return {blocked:true,reason:'usage_unknown_or_stale'};
      if(state.activeWorkloads.length)return {blocked:true,reason:'active_workloads'};
      // A future actual dismounter must atomically reserve against new writers and
      // recheck at action time. Do not convert this observation into authorization.
      return {blocked:false,reason:'no_active_workloads_observed',authorized:false,requiresAtomicRecheck:true};
    }catch{return {blocked:true,reason:'trusted_workspace_observation_failed'};}
  }
  return Object.freeze({status,canDismount});
}
module.exports={createWorkspacePolicy};
