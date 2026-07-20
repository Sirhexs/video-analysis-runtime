import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { abortError, RuntimeError } from './errors.js';
import { createAssetFromFile, getAsset, publicAsset } from './assets.js';
import {
  extractAudioWav,
  extractFrameAt,
  fileToDataUrl,
  probeDurationSec,
} from './ffmpeg.js';
import { runAsr, runLlm } from './providers.js';

function ensureNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function requireAsset(assetId) {
  const asset = await getAsset(assetId);
  if (!asset) throw new RuntimeError('asset_not_found', `Asset ${assetId} 不存在`, 404);
  return asset;
}

function capability(name) {
  if (!config.profile.operations.includes(name)) {
    throw new RuntimeError(
      'capability_unavailable',
      `当前 ${config.profile.name} 版本不包含 ${name}`,
    );
  }
}

function workDir(jobId, suffix) {
  return path.join(config.dataDir, 'work', jobId, suffix || randomUUID());
}

function interpolate(value, bindings) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([\w.-]+)\}\}/g, (_, key) => {
      const resolved = key.split('.').reduce((current, part) => current?.[part], bindings);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? '');
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, bindings));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, interpolate(child, bindings)]),
    );
  }
  return value;
}

function attachImages(messages, dataUrls) {
  if (!dataUrls.length) return messages;
  const out = structuredClone(messages);
  let index = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role === 'user') {
      index = i;
      break;
    }
  }
  if (index < 0) return out;
  const original = out[index].content;
  const content = Array.isArray(original)
    ? original
    : [{ type: 'text', text: String(original || '') }];
  for (const url of dataUrls) content.push({ type: 'image_url', image_url: { url } });
  out[index].content = content;
  return out;
}

async function mediaProbe(input) {
  const asset = await requireAsset(input.assetId);
  const durationSec = await probeDurationSec(asset.path);
  return { asset: publicAsset(asset), durationSec };
}

async function mediaExtractAudio(input, context) {
  const asset = await requireAsset(input.assetId);
  const dir = workDir(context.jobId, 'audio');
  const output = path.join(dir, 'audio.wav');
  await extractAudioWav(asset.path, output);
  ensureNotAborted(context.signal);
  const audio = await createAssetFromFile(output, {
    filename: `${path.parse(asset.filename).name}.wav`,
    contentType: 'audio/wav',
    source: 'generated',
    metadata: { parentAssetId: asset.id, operation: 'media.extract_audio' },
  });
  await fs.rm(dir, { recursive: true, force: true });
  return { asset: publicAsset(audio), assetId: audio.id };
}

async function mediaExtractFrames(input, context) {
  const asset = await requireAsset(input.assetId);
  const timestamps = Array.isArray(input.timestamps)
    ? input.timestamps.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (!timestamps.length) throw new RuntimeError('invalid_request', '截帧需要 timestamps');
  const dir = workDir(context.jobId, 'frames');
  const frames = [];
  for (let index = 0; index < Math.min(timestamps.length, 24); index++) {
    ensureNotAborted(context.signal);
    const tSec = timestamps[index];
    const output = path.join(dir, `frame-${index}.jpg`);
    await extractFrameAt(asset.path, tSec, output);
    const frame = await createAssetFromFile(output, {
      filename: `frame-${index}-${Math.round(tSec * 1000)}.jpg`,
      contentType: 'image/jpeg',
      source: 'generated',
      metadata: { parentAssetId: asset.id, tSec },
    });
    frames.push({ tSec, assetId: frame.id, asset: publicAsset(frame) });
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { frames };
}

async function asrTranscribe(input, context) {
  const asset = await requireAsset(input.assetId);
  ensureNotAborted(context.signal);
  const result = await runAsr(asset.path, input.provider || {});
  return {
    text: result.text,
    segments: result.segments || [],
    language: result.language,
    assetId: asset.id,
  };
}

async function douyinImport(input, context) {
  capability('connector.douyin.import');
  const { downloadDouyinVideo } = await import('./download.js');
  const dir = workDir(context.jobId, 'douyin');
  const downloaded = await downloadDouyinVideo({
    externalId: input.externalId,
    url: input.url,
    cookie: input.cookie,
    workDir: dir,
  });
  ensureNotAborted(context.signal);
  const sourcePath = downloaded.videoPath || downloaded.audioPath;
  if (!sourcePath) throw new RuntimeError('douyin_media_missing', '抖音 Connector 未返回媒体');
  const asset = await createAssetFromFile(sourcePath, {
    filename: path.basename(sourcePath),
    source: 'connector.douyin',
    metadata: {
      externalId: downloaded.awemeId || input.externalId,
      url: input.url,
      audioOnly: Boolean(downloaded.audioOnly),
    },
  });
  await fs.rm(dir, { recursive: true, force: true });
  return { assetId: asset.id, asset: publicAsset(asset), metadata: asset.metadata };
}

async function videoAnalyze(input, context) {
  const asset = await requireAsset(input.assetId);
  const dir = workDir(context.jobId, 'video-analysis');
  const audioPath = path.join(dir, 'audio.wav');
  await extractAudioWav(asset.path, audioPath);
  const transcript = await runAsr(audioPath, input.asr || {});
  ensureNotAborted(context.signal);
  const bindings = {
    ...(input.context || {}),
    transcript: transcript.text,
    segments: transcript.segments || [],
  };
  const rank = await runLlm({
    ...(input.rank || {}),
    messages: interpolate(input.rank?.messages || [], bindings),
  });
  const ranked = rank.output || (() => {
    try { return JSON.parse(rank.content); } catch { return {}; }
  })();
  const keyMoments = Array.isArray(ranked.keyMoments)
    ? ranked.keyMoments
        .map((moment) => ({ ...moment, tSec: Number(moment.tSec) }))
        .filter((moment) => Number.isFinite(moment.tSec) && moment.tSec >= 0)
        .slice(0, Number(input.maxFrames) || 6)
    : [];
  const frameUrls = [];
  for (let index = 0; index < keyMoments.length; index++) {
    ensureNotAborted(context.signal);
    const output = path.join(dir, `frame-${index}.jpg`);
    await extractFrameAt(asset.path, keyMoments[index].tSec, output);
    frameUrls.push(await fileToDataUrl(output));
  }
  const finalBindings = {
    ...bindings,
    keyMoments,
    draft: ranked,
  };
  const finalMessages = attachImages(
    interpolate(input.final?.messages || [], finalBindings),
    frameUrls,
  );
  const final = finalMessages.length
    ? await runLlm({ ...input.final, messages: finalMessages })
    : rank;
  await fs.rm(dir, { recursive: true, force: true });
  return {
    transcript: transcript.text,
    segments: transcript.segments || [],
    keyMoments,
    rank: ranked,
    output: final.output,
    content: final.content,
    model: final.model,
    frameCount: frameUrls.length,
  };
}

export async function executeOperation(operation, input, context) {
  capability(operation);
  switch (operation) {
    case 'media.probe': return mediaProbe(input || {});
    case 'media.extract_audio': return mediaExtractAudio(input || {}, context);
    case 'media.extract_frames': return mediaExtractFrames(input || {}, context);
    case 'asr.transcribe': return asrTranscribe(input || {}, context);
    case 'llm.generate': return runLlm(input || {});
    case 'connector.douyin.import': return douyinImport(input || {}, context);
    case 'video.analyze': return videoAnalyze(input || {}, context);
    default:
      throw new RuntimeError('operation_not_found', `未知 operation=${operation}`, 404);
  }
}

function readReference(reference, rootInput, stageOutputs) {
  const match = String(reference).match(/^\$(input|stages)(?:\.([\w-]+))?(?:\.(.*))?$/);
  if (!match) throw new RuntimeError('invalid_reference', `无效引用 ${reference}`);
  let current;
  if (match[1] === 'input') {
    current = rootInput;
    if (match[2]) current = current?.[match[2]];
  } else {
    const stageId = match[2];
    if (!stageId || !(stageId in stageOutputs)) {
      throw new RuntimeError('invalid_reference', `Stage 尚未完成或不存在：${stageId}`);
    }
    current = stageOutputs[stageId];
  }
  if (match[3]) {
    for (const part of match[3].split('.')) current = current?.[part];
  }
  return structuredClone(current);
}

function resolveReferences(value, rootInput, outputs) {
  if (typeof value === 'string' && value.startsWith('$')) {
    return readReference(value, rootInput, outputs);
  }
  if (Array.isArray(value)) return value.map((child) => resolveReferences(child, rootInput, outputs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveReferences(child, rootInput, outputs)]),
    );
  }
  return value;
}

export async function executePipeline(spec, context) {
  const stages = Array.isArray(spec.stages) ? spec.stages : [];
  if (!stages.length) throw new RuntimeError('invalid_request', 'pipeline.run 需要 stages');
  const ids = new Set();
  const outputs = {};
  for (let index = 0; index < stages.length; index++) {
    ensureNotAborted(context.signal);
    const stage = stages[index];
    if (!stage?.id || ids.has(stage.id)) {
      throw new RuntimeError('invalid_pipeline', '每个 Stage 必须有唯一 id');
    }
    ids.add(stage.id);
    context.onProgress?.({
      phase: stage.id,
      progress: Math.round((index / stages.length) * 100),
    });
    const input = resolveReferences(stage.input || {}, spec.input || {}, outputs);
    outputs[stage.id] = await executeOperation(stage.type, input, context);
  }
  context.onProgress?.({ phase: 'done', progress: 100 });
  return { stages: outputs, output: outputs[stages.at(-1).id] };
}
