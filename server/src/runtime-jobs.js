import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { errorBody, RuntimeError } from './errors.js';
import { readJsonFile, redactSecrets, writeJsonAtomic } from './json-store.js';
import { executeOperation, executePipeline } from './operations.js';

const jobsDir = path.join(config.dataDir, 'jobs');
const jobs = new Map();
const secrets = new Map();
const controllers = new Map();
const waiting = [];
let active = 0;

function jobFile(id) {
  return path.join(jobsDir, `${id}.json`);
}

function publicJob(job) {
  return structuredClone(job);
}

async function persist(job) {
  jobs.set(job.id, job);
  await writeJsonAtomic(jobFile(job.id), job);
}

function mergeSecrets(redacted, original) {
  if (redacted === '[REDACTED]') return original;
  if (Array.isArray(redacted)) {
    return redacted.map((item, index) => mergeSecrets(item, original?.[index]));
  }
  if (redacted && typeof redacted === 'object') {
    return Object.fromEntries(
      Object.entries(redacted).map(([key, value]) => [key, mergeSecrets(value, original?.[key])]),
    );
  }
  return redacted;
}

export async function initializeJobs() {
  await fs.mkdir(jobsDir, { recursive: true });
  const entries = await fs.readdir(jobsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const job = await readJsonFile(path.join(jobsDir, entry.name), null);
    if (!job) continue;
    if (job.status === 'pending' || job.status === 'running') {
      job.status = 'error';
      job.phase = 'error';
      job.error = {
        code: 'service_restarted',
        message: '服务重启导致任务中断，请重新提交',
      };
      job.updatedAt = Date.now();
      await writeJsonAtomic(jobFile(job.id), job);
    }
    jobs.set(job.id, job);
  }
}

export async function createRuntimeJob(request) {
  const operation = String(request?.operation || '');
  if (!operation) throw new RuntimeError('invalid_request', '需要 operation');
  const id = randomUUID();
  const now = Date.now();
  const sanitizedRequest = redactSecrets(request);
  const job = {
    id,
    operation,
    status: 'pending',
    phase: 'queued',
    progress: 0,
    warnings: [],
    request: sanitizedRequest,
    result: undefined,
    error: undefined,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.jobRetentionMs,
  };
  secrets.set(id, request);
  await persist(job);
  waiting.push(id);
  void drain();
  return publicJob(job);
}

export function getRuntimeJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function getRuntimeJobStats() {
  return { active, queued: waiting.length, retained: jobs.size };
}

export async function cancelRuntimeJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (['done', 'error', 'cancelled'].includes(job.status)) return publicJob(job);
  const waitingIndex = waiting.indexOf(id);
  if (waitingIndex >= 0) waiting.splice(waitingIndex, 1);
  controllers.get(id)?.abort();
  Object.assign(job, {
    status: 'cancelled',
    phase: 'cancelled',
    error: { code: 'job_cancelled', message: '任务已取消' },
    updatedAt: Date.now(),
  });
  secrets.delete(id);
  await persist(job);
  return publicJob(job);
}

async function patchJob(job, partial) {
  Object.assign(job, partial, { updatedAt: Date.now() });
  await persist(job);
}

async function run(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'pending') return;
  const request = mergeSecrets(job.request, secrets.get(id));
  const controller = new AbortController();
  controllers.set(id, controller);
  await patchJob(job, { status: 'running', phase: 'starting', progress: 0 });
  try {
    const context = {
      jobId: id,
      signal: controller.signal,
      onProgress(update) {
        Object.assign(job, update, { updatedAt: Date.now() });
        void persist(job);
      },
    };
    const result = request.operation === 'pipeline.run'
      ? await executePipeline(request, context)
      : await executeOperation(request.operation, request.input || {}, context);
    if (job.status === 'cancelled') return;
    await patchJob(job, {
      status: 'done',
      phase: 'done',
      progress: 100,
      result,
      error: undefined,
    });
  } catch (error) {
    if (job.status !== 'cancelled') {
      await patchJob(job, {
        status: error?.code === 'job_cancelled' ? 'cancelled' : 'error',
        phase: error?.code === 'job_cancelled' ? 'cancelled' : 'error',
        error: errorBody(error, job.phase),
      });
    }
  } finally {
    controllers.delete(id);
    secrets.delete(id);
  }
}

async function drain() {
  while (active < config.maxConcurrentJobs && waiting.length) {
    const id = waiting.shift();
    active += 1;
    void run(id).finally(() => {
      active -= 1;
      void drain();
    });
  }
}

export async function cleanupExpiredJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (Number(job.expiresAt) > now || ['pending', 'running'].includes(job.status)) continue;
    jobs.delete(id);
    secrets.delete(id);
    await fs.rm(jobFile(id), { force: true });
  }
}
