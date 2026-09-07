#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {api} from './api.js';
import {enqueue, loadConfig, saveConfig, loadQueue, saveQueue, eventKey} from './config.js';
import {commitData, git, parsePrePush, removeHooks, repositoryFingerprint, stagedData} from './git.js';
import {flush, runAgent, scanWatchedRoots} from './agent.js';
import {installStartup, stopStartup, withStartupRestart} from './install.js';
import {installationId, normalizeServerUrl, previousDeviceTokenForServer, rebindDeviceConfig, rebindWorkspaceConfig} from './pairing.js';
import {createInstallLogger, helpText, promptForWatchPaths} from './setup.js';

const args = process.argv.slice(2);
const command = args.shift();
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const config = loadConfig();

function bindWorkspace(workspaceId?: number, forceReset = false) {
  Object.assign(config, rebindWorkspaceConfig(config, workspaceId, forceReset));
  saveConfig(config);
}

async function exchangeInstallToken() {
  const requestedServer = flag('--server');
  const installToken = flag('--install-token');
  if (!requestedServer || !installToken) throw new Error('install requires its generated --server and --install-token arguments');
  const server = normalizeServerUrl(requestedServer);
  const previousAgentToken = previousDeviceTokenForServer(config, server);
  const exchangeConfig = {...config, serverUrl: server, agentToken: previousAgentToken, userToken: undefined};
  const response = await api<any>(exchangeConfig, '/api/agents/install/exchange', {method: 'POST', body: JSON.stringify({installToken, machineName: flag('--machine') || os.hostname(), installationId: installationId(server)})});
  const sameDevice = config.agentId === Number(response.agentId) && normalizeServerUrl(config.serverUrl) === server;
  const rebound = rebindDeviceConfig(config, server, response);
  Object.assign(config, rebound);
  delete config.userToken;
  if (sameDevice) saveConfig(rebound);
  else {
    saveConfig(rebound, {
      replaceCollections: true,
      beforeRepositoryStateReplace: current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } },
    });
    saveQueue([], rebound);
  }
  return response;
}

async function main() {
  if (command === 'setup' || command === 'install') {
    const log = createInstallLogger();
    const transactionDir = flag('--transaction-dir');
    let exchanged = false;
    let freshDevice = false;
    try {
      log.step(1, 7, 'Checking local environment');
      if (process.platform !== 'linux') throw new Error('automatic setup currently supports Linux only');
      log.success(`Node.js ${process.versions.node} on Linux`);
      log.step(2, 7, 'Checking the existing installation');
      stopStartup();
      log.success('Background service is ready for setup');
      log.step(3, 7, 'Collecting watched folders');
      const roots = await promptForWatchPaths();
      log.step(4, 7, 'Connecting this device');
      const response = await exchangeInstallToken();
      exchanged = true;
      freshDevice = Boolean(response.created);
      if (transactionDir) fs.writeFileSync(path.join(transactionDir, 'credential-exchanged'), '', {mode: 0o600});
      log.success(`Device ${response.agentId} connected`);
      log.step(5, 7, 'Discovering repositories');
      let found = 0;
      for (const root of roots) {
        if (!config.watchedPaths.includes(root)) config.watchedPaths.push(root);
        found += await scanWatchedRoots(config, [root]);
      }
      log.success(`${found} repository candidate(s) discovered`);
      log.step(6, 7, 'Installing the background service');
      installStartup();
      log.success('Background service started');
      log.step(7, 7, 'Verifying the installation');
      await api(config, '/api/agents/status');
      log.success('Server connection is healthy');
      console.log(`\n✓ TraceMini installation completed successfully\n✓ Watched paths: ${roots.length}\n✓ Repository candidates discovered: ${found}`);
      console.log('\nNext: open TraceMini Settings and select which repositories to trace.');
      console.log('\nYou can add another folder at any time:\n\n  tracemini watch "$HOME/path"');
      console.log('\nFor all available CLI commands and options, run:\n\n  tracemini --help');
      console.log(`\nInstallation log:\n  ${log.path}`);
    } catch (error: any) {
      log.failure(error.message || String(error));
      if (exchanged && freshDevice) {
        try { await api(config, '/api/agents/install/abort', {method: 'POST'}); } catch {}
      } else if (exchanged) {
        console.error('The installer will restore the previous executable while keeping the newly connected device credential valid.');
      }
      console.error(`Details: ${log.path}`);
      throw error;
    }
    return;
  }
  if (command === 'sync') {
    const response = await withStartupRestart(exchangeInstallToken);
    console.log(`Device ${response.agentId} synced to workspace ${response.workspaceId}`);
    return;
  }
  if (command === 'login') {
    const previousServer = config.serverUrl;
    const server = flag('--server');
    if (server) config.serverUrl = server;
    const bearer = flag('--token');
    if (!bearer) throw new Error('login requires --token; browser onboarding should use the generated install command instead');
    config.userToken = bearer;
    const agent = await api<any>(config, '/api/agents/register', {method: 'POST', body: JSON.stringify({machineName: flag('--machine') || os.hostname(), installationId: installationId(config.serverUrl)})}, false);
    const sameDevice = config.agentId === Number(agent.agentId) && normalizeServerUrl(previousServer) === normalizeServerUrl(config.serverUrl);
    config.agentToken = agent.token;
    config.agentId = agent.agentId;
    delete config.userToken;
    if (sameDevice) {
      saveConfig(config);
      console.log(`Device ${agent.agentId} synchronized`);
      return;
    }
    delete config.workspaceId;
    config.watchedPaths = [];
    config.watchedRoots = [];
    config.clones = [];
    config.documents = [];
    saveConfig(config, {
      replaceCollections: true,
      beforeRepositoryStateReplace: current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } },
    });
    saveQueue([], config);
    console.log(`Device ${agent.agentId} registered`);
    return;
  }
  if (command === 'use-workspace') {
    const workspaceId = Number(args[0]);
    if (!workspaceId) throw new Error('use-workspace requires a workspace id');
    await api(config, '/api/agents/workspace', {method: 'POST', body: JSON.stringify({workspaceId: String(workspaceId)})});
    bindWorkspace(workspaceId);
    console.log(`Workspace ${config.workspaceId} selected`);
    return;
  }
  if (command === 'watch') {
    if (!config.workspaceId) throw new Error('install or select a workspace first');
    if (!args[0]) throw new Error('watch requires a repository root path');
    const root = path.resolve(args[0]);
    if (!config.watchedPaths.includes(root)) config.watchedPaths.push(root);
    const found = await scanWatchedRoots(config, [root]);
    console.log(`Scanned watched roots; ${found} repository candidate(s) discovered. Select tracing in TraceMini Settings.`);
    return;
  }
  if (command === 'repositories') { console.table(config.clones); return; }
  if (command === 'status') {
    const status = await api<any>(config, '/api/agents/status');
    console.log(JSON.stringify({...status, server: config.serverUrl, workspaceId: config.workspaceId, watchedPaths: config.watchedPaths, clones: config.clones.length, queued: loadQueue().length}, null, 2));
    return;
  }
  if (command === 'event') {
    const repoPath = path.resolve(flag('--repo') || process.cwd());
    const type = flag('--type') || args[0];
    const clones = config.clones.filter(item => item.path === repoPath);
    if (!clones.length) throw new Error(`repository is not registered: ${repoPath}`);
    const identityFingerprint = repositoryFingerprint(repoPath);
    if (clones.some(clone => !clone.repositoryFingerprint || clone.repositoryFingerprint !== identityFingerprint)) throw new Error(`repository identity changed: ${repoPath}`);
    if (type === 'push' && flag('--hook') === 'pre-push') {
      const stdin = fs.readFileSync(0, 'utf8');
      for (const intent of parsePrePush(args.at(-2) || '', args.at(-1) || '', stdin)) {
        if (repositoryFingerprint(repoPath) !== identityFingerprint) throw new Error(`repository identity changed: ${repoPath}`);
        const occurredAt = new Date().toISOString();
        let sent = 0;
        let firstError: unknown;
        for (const clone of clones) {
          try {
            await api(config, '/api/pushes/pending', {method: 'POST', body: JSON.stringify({...intent, repositoryId: clone.repositoryId, localKey: clone.path, identityFingerprint, occurredAt, eventKey: eventKey(['push', config.agentId, identityFingerprint, intent.ref, intent.expectedSha, occurredAt])})});
            sent++;
          } catch (error) {
            firstError ??= error;
          }
        }
        if (!sent && firstError) throw firstError;
      }
      return;
    }
    let data: any = {branch: git(repoPath, ['branch', '--show-current']) || '(detached)', hook: flag('--hook')};
    if (type === 'commit') data = commitData(repoPath);
    else if (type === 'stage') data = stagedData(repoPath);
    else if (type === 'branch') data = {...data, oldCommit: args.at(-3), newCommit: args.at(-2), branchCheckout: args.at(-1)};
    else if (type === 'merge' || type === 'pull') data = {...data, commitSha: git(repoPath, ['rev-parse', 'HEAD'])};
    else if (type === 'push') data = {...data, confirmation: 'unconfirmed', reason: 'explicit event has no remote verification target'};
    if (repositoryFingerprint(repoPath) !== identityFingerprint) throw new Error(`repository identity changed: ${repoPath}`);
    const occurredAt = new Date().toISOString();
    for (const clone of clones) {
      enqueue(config, {eventKey: eventKey([type, config.agentId, identityFingerprint, data.commitSha || '', data.oldCommit || '', data.newCommit || '', occurredAt.slice(0, 16), data]), workspaceId: clone.workspaceId, repositoryId: clone.repositoryId, localKey: clone.path, identityFingerprint, type, occurredAt, data, attempts: 0, nextAttempt: 0});
    }
    await flush(config);
    return;
  }
  if (command === 'start' || command === 'once') { await runAgent(config, command === 'once'); return; }
  if (command === '--help' || command === '-h' || command === 'help' || !command) { console.log(helpText); return; }
  throw new Error(`unknown command: ${command}\n\n${helpText}`);
}

main().catch(error => {
  console.error(`TraceMini: ${error.message || error}`);
  process.exitCode = 1;
});
