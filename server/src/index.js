import http from 'node:http';
import fs from 'node:fs/promises';
import { config } from './config.js';
import {
  cleanupExpiredAssets,
  createAssetFromStream,
  deleteAsset,
  getAsset,
  importAssetUrl,
  initializeAssets,
  publicAsset,
} from './assets.js';
import {
  cancelRuntimeJob,
  cleanupExpiredJobs,
  createRuntimeJob,
  getRuntimeJob,
  getRuntimeJobStats,
  initializeJobs,
} from './runtime-jobs.js';
import { errorBody, RuntimeError } from './errors.js';
import { getFfmpegBins } from './ffmpeg.js';
import { getLocalAsrStatus } from './asr-local.js';

await fs.mkdir(config.dataDir, { recursive: true });
await fs.mkdir(config.logDir, { recursive: true });
await initializeAssets();
await initializeJobs();

const ffmpegBins = getFfmpegBins();
let lastActivityAt = Date.now();
let shuttingDown = false;

function touchActivity() {
  lastActivityAt = Date.now();
}

function isAllowedOrigin(origin) {
  return Boolean(origin) && config.allowedOrigins.includes(origin);
}

function commonHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename',
  };
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function send(req, res, status, body) {
  res.writeHead(status, commonHeaders(req));
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RuntimeError('request_too_large', '请求体过大', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RuntimeError('invalid_json', '请求体不是有效 JSON');
  }
}

function authorized(req) {
  if (config.authDisabled) return true;
  if (!config.authToken) return !config.managed;
  return req.headers.authorization === `Bearer ${config.authToken}`;
}

function capabilities() {
  return {
    product: config.product,
    version: config.version,
    apiVersion: config.apiVersion,
    profile: config.profile.name,
    features: {
      media: config.profile.media,
      asr: config.profile.asr,
      llm: config.profile.llm,
      connectors: config.profile.connectors,
      operations: config.profile.operations,
    },
    localAsr: config.profile.localAsr ? getLocalAsrStatus() : { ready: false },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    touchActivity();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, commonHeaders(req));
      res.end();
      return;
    }
    if (!authorized(req)) {
      send(req, res, 401, { error: { code: 'unauthorized', message: '未授权' } });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      const stats = getRuntimeJobStats();
      send(req, res, 200, {
        ok: true,
        ...capabilities(),
        ffmpegResolved: ffmpegBins.resolved,
        activeJobs: stats.active,
        queuedJobs: stats.queued,
        idleExitSec: config.idleExitMs ? Math.round(config.idleExitMs / 1000) : 0,
        managed: config.managed,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/capabilities') {
      send(req, res, 200, capabilities());
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/assets') {
      const contentType = String(req.headers['content-type'] || 'application/octet-stream');
      if (contentType.includes('application/json')) {
        const body = await readJson(req);
        if (!body.url) throw new RuntimeError('invalid_request', 'URL 导入需要 url');
        const asset = await importAssetUrl(body.url, { filename: body.filename });
        send(req, res, 201, { asset: publicAsset(asset) });
        return;
      }
      const filename =
        req.headers['x-filename'] || url.searchParams.get('filename') || 'media.bin';
      const asset = await createAssetFromStream(req, {
        filename,
        contentType: contentType.split(';')[0],
      });
      send(req, res, 201, { asset: publicAsset(asset) });
      return;
    }

    const assetMatch = pathname.match(/^\/v1\/assets\/([^/]+)$/);
    if (assetMatch && req.method === 'GET') {
      const asset = await getAsset(assetMatch[1]);
      if (!asset) throw new RuntimeError('asset_not_found', 'Asset 不存在', 404);
      send(req, res, 200, { asset: publicAsset(asset) });
      return;
    }
    if (assetMatch && req.method === 'DELETE') {
      if (!(await deleteAsset(assetMatch[1]))) {
        throw new RuntimeError('asset_not_found', 'Asset 不存在', 404);
      }
      send(req, res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/jobs') {
      const job = await createRuntimeJob(await readJson(req));
      send(req, res, 202, { jobId: job.id, job });
      return;
    }

    const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      const job = getRuntimeJob(jobMatch[1]);
      if (!job) throw new RuntimeError('job_not_found', 'Job 不存在', 404);
      send(req, res, 200, { job });
      return;
    }
    const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const job = await cancelRuntimeJob(cancelMatch[1]);
      if (!job) throw new RuntimeError('job_not_found', 'Job 不存在', 404);
      send(req, res, 200, { job });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/control/shutdown') {
      const stats = getRuntimeJobStats();
      if (stats.active || stats.queued) {
        throw new RuntimeError('jobs_active', '仍有任务，暂不能退出', 409, stats);
      }
      send(req, res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => void shutdown('control'), 50).unref?.();
      return;
    }

    throw new RuntimeError('not_found', '接口不存在', 404);
  } catch (error) {
    console.error('[Video Analysis Runtime]', error?.code || error?.name, error?.message);
    send(req, res, error?.statusCode || 500, { error: errorBody(error) });
  }
});

if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.authToken) {
  throw new Error('非回环地址必须配置 RUNTIME_AUTH_TOKEN');
}
if (config.managed && !config.authToken && !config.authDisabled) {
  throw new Error('托管模式必须配置 RUNTIME_AUTH_TOKEN');
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Video Analysis Runtime] shutting down reason=${reason}`);
  const forceTimer = setTimeout(() => process.exit(0), 5000);
  forceTimer.unref?.();
  server.close(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

const maintenance = setInterval(() => {
  void cleanupExpiredJobs();
  void cleanupExpiredAssets();
  if (!config.idleExitMs || shuttingDown) return;
  const stats = getRuntimeJobStats();
  if (!stats.active && !stats.queued && Date.now() - lastActivityAt >= config.idleExitMs) {
    void shutdown('idle');
  }
}, 30_000);
maintenance.unref?.();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  console.log(
    `[Video Analysis Runtime] http://${config.host}:${config.port} profile=${config.profile.name} data=${config.dataDir}`,
  );
});
