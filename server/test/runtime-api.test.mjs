import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function startRuntime(t, extraEnv = {}) {
  const port = await freePort();
  const token = 'runtime-test-token';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-runtime-api-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), RUNTIME_AUTH_TOKEN: token,
      RUNTIME_PROFILE: 'cloud', DATA_DIR: path.join(temp, 'data'),
      LOG_DIR: path.join(temp, 'logs'), IDLE_EXIT_MS: '0', ...extraEnv,
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return { url, token, temp, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('服务未启动');
}

function headers(token, additional = {}) {
  return { Authorization: `Bearer ${token}`, ...additional };
}

async function waitJob(url, token, id) {
  for (let i = 0; i < 60; i++) {
    const response = await fetch(`${url}/v1/jobs/${id}`, { headers: headers(token) });
    const { job } = await response.json();
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Job 超时');
}

test('assets, capabilities and persisted job envelope', async (t) => {
  const runtime = await startRuntime(t);
  const capabilities = await fetch(`${runtime.url}/v1/capabilities`, {
    headers: headers(runtime.token),
  }).then((response) => response.json());
  assert.equal(capabilities.profile, 'cloud');
  assert.deepEqual(capabilities.features.connectors, []);

  const upload = await fetch(`${runtime.url}/v1/assets?filename=sample.txt`, {
    method: 'POST',
    headers: headers(runtime.token, { 'Content-Type': 'application/octet-stream' }),
    body: 'hello runtime',
  });
  assert.equal(upload.status, 201);
  const { asset } = await upload.json();
  assert.equal(asset.filename, 'sample.txt');
  assert.equal(asset.size, 13);
  assert.equal('path' in asset, false);

  const submitted = await fetch(`${runtime.url}/v1/jobs`, {
    method: 'POST',
    headers: headers(runtime.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ operation: 'connector.douyin.import', input: { cookie: 'secret' } }),
  }).then((response) => response.json());
  const job = await waitJob(runtime.url, runtime.token, submitted.jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error.code, 'capability_unavailable');
  assert.equal(JSON.stringify(job).includes('secret'), false);
  const persisted = JSON.parse(
    await fs.readFile(path.join(runtime.temp, 'data', 'jobs', `${job.id}.json`), 'utf8'),
  );
  assert.equal(JSON.stringify(persisted).includes('secret'), false);

  const deleted = await fetch(`${runtime.url}/v1/assets/${asset.id}`, {
    method: 'DELETE', headers: headers(runtime.token),
  });
  assert.equal(deleted.status, 200);
});

test('llm messages are forwarded unchanged when repair is disabled', async (t) => {
  const mockPort = await freePort();
  let received;
  const mock = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {});
    setTimeout(() => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.split('\r\n\r\n')[1] || '{}';
      received = JSON.parse(body);
      const responseBody = JSON.stringify({ choices: [{ message: { content: 'exact response' } }], model: 'mock' });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`);
    }, 20);
  });
  await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
  t.after(() => mock.close());
  const runtime = await startRuntime(t);
  const messages = [{ role: 'system', content: 'developer-owned prompt' }, { role: 'user', content: 'input' }];
  const submitted = await fetch(`${runtime.url}/v1/jobs`, {
    method: 'POST',
    headers: headers(runtime.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      operation: 'llm.generate',
      input: {
        provider: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'request-key', model: 'mock' },
        messages,
      },
    }),
  }).then((response) => response.json());
  const job = await waitJob(runtime.url, runtime.token, submitted.jobId);
  assert.equal(job.status, 'done');
  assert.deepEqual(received.messages, messages);
  assert.equal(job.result.content, 'exact response');
  assert.equal(JSON.stringify(job).includes('request-key'), false);
});
