import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type {Config} from './config.js';

export type DevicePairing = {agentToken: string; agentId: number; workspaceId: number};

export function normalizeServerUrl(serverUrl: string) {
  const parsed = new URL(serverUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !local) parsed.protocol = 'https:';
  return parsed.origin;
}

export function installationId(serverUrl: string) {
  let machineId = os.hostname();
  try { machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim() || machineId; } catch {}
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  return crypto.createHash('sha256').update(`tracemini-installation-v1\0${normalizeServerUrl(serverUrl)}\0${uid}\0${machineId}`).digest('hex');
}

export function previousDeviceTokenForServer(config: Config, nextServerUrl: string) {
  if (!config.agentToken || !config.serverUrl) return undefined;
  try {
    return normalizeServerUrl(config.serverUrl) === normalizeServerUrl(nextServerUrl) ? config.agentToken : undefined;
  } catch {
    return undefined;
  }
}

export function rebindDeviceConfig(config: Config, serverUrl: string, pairing: DevicePairing): Config {
  const {userToken: _userToken, ...local} = config;
  const sameDevice = config.agentId === pairing.agentId && normalizeServerUrl(config.serverUrl) === normalizeServerUrl(serverUrl);
  return {
    ...local,
    serverUrl,
    agentToken: pairing.agentToken,
    agentId: pairing.agentId,
    workspaceId: pairing.workspaceId,
    watchedPaths: sameDevice ? config.watchedPaths : [],
    watchedRoots: sameDevice ? config.watchedRoots : [],
    clones: sameDevice ? config.clones : [],
  };
}

export function rebindWorkspaceConfig(config: Config, workspaceId?: number, _forceReset = false): Config {
  const rebound = {...config};
  if (workspaceId) rebound.workspaceId = workspaceId;
  else delete rebound.workspaceId;
  return rebound;
}
