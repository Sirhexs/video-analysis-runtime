import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, token) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('服务未启动');
}

test('health requires token and shutdown exits cleanly', async (t) => {
  const port = await freePort();
  const token = 'test-token-1234567890';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-analysis-runtime-'));
  const bundledModel = path.join(temp, 'asr-model');
  const bundledRunner = path.join(temp, 'VideoAnalysisAsr.exe');
  await fs.mkdir(bundledModel, { recursive: true });
  await fs.writeFile(bundledRunner, 'test-runner');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RUNTIME_AUTH_TOKEN: token,
      RUNTIME_PROFILE: 'hybrid',
      DATA_DIR: path.join(temp, 'data'),
      LOG_DIR: path.join(temp, 'logs'),
      ASR_PROVIDER: 'local',
      VIDEO_ANALYSIS_RUNTIME_MANAGED: '1',
      VIDEO_ANALYSIS_RUNTIME_ASR_RUNNER: bundledRunner,
      LOCAL_ASR_MODEL: 'small',
      LOCAL_ASR_MODEL_PATH: bundledModel,
      IDLE_EXIT_MS: '0',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(url, token);
  assert.equal(health.ok, true);
  assert.equal(health.product, 'Video Analysis Runtime');
  assert.equal(health.version, '1.0.1');
  assert.equal(health.apiVersion, '1.0');
  assert.equal(health.profile, 'hybrid');
  assert.equal(health.activeJobs, 0);
  assert.equal(health.localAsr.bundledModel, true);
  assert.equal(health.localAsr.runtimeReady, true);
  assert.equal(health.localAsr.ready, true);

  const unauthorized = await fetch(`${url}/health`);
  assert.equal(unauthorized.status, 401);

  const shutdown = await fetch(`${url}/v1/control/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(shutdown.status, 200);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务退出超时')), 5000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
});
