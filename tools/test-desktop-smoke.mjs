import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv.find((value) => value.startsWith('--profile='))?.slice(10) || 'douyin-hybrid';
const installDir = path.join(root, 'dist', 'desktop', profile);
const hostExe = path.join(installDir, 'VideoAnalysisRuntimeHost.exe');
const localAppData = path.join(root, 'dist', `runtime-smoke-${profile}`);
const expectsLocal = profile === 'hybrid' || profile === 'douyin-hybrid';
const expectsDouyin = profile.startsWith('douyin-');

async function existingServiceStatus() {
  try {
    return (await fetch('http://127.0.0.1:18765/health', { signal: AbortSignal.timeout(800) })).status;
  } catch { return undefined; }
}

async function hostAction(action) {
  const child = spawn(hostExe, ['--action', action], {
    windowsHide: true,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR: installDir,
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Host 超时：${action}`)); }, 20_000);
    child.once('error', reject);
    child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  return JSON.parse(Buffer.concat(stdout).toString('utf8').trim());
}

await fs.rm(localAppData, { recursive: true, force: true });
assert.equal(await fs.stat(hostExe).then((stat) => stat.isFile()).catch(() => false), true);
assert.equal(
  await fs.stat(path.join(installDir, 'asr')).then(() => true).catch(() => false),
  expectsLocal,
);
assert.equal(
  await fs.stat(path.join(installDir, 'server', 'src', 'download.js')).then(() => true).catch(() => false),
  expectsDouyin,
);
if (await existingServiceStatus() !== undefined) {
  console.log('18765 已被占用，跳过进程冒烟测试');
  process.exit(0);
}
const started = await hostAction('ensure_started');
assert.equal(started.ok, true, started.error);
const health = await fetch(`${started.url}/health`, {
  headers: { Authorization: `Bearer ${started.token}` },
}).then((response) => response.json());
assert.equal(health.ok, true);
assert.equal(health.product, 'Video Analysis Runtime');
assert.equal(health.apiVersion, '1.0');
assert.equal(health.profile, profile);
assert.equal(health.features.connectors.includes('douyin'), expectsDouyin);
assert.equal(Boolean(health.localAsr.ready), expectsLocal);
const stopped = await hostAction('stop');
assert.equal(stopped.ok, true, stopped.error);
console.log(`Profile 冒烟测试通过：${profile}`);
