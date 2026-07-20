import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFfmpegBins } from './ffmpeg-path.js';

const bins = resolveFfmpegBins();

export function getFfmpegBins() {
  return bins;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        reject(
          new Error(
            `找不到 ${cmd}。请安装 ffmpeg 或设置 FFMPEG_PATH / FFPROBE_PATH。` +
              ` 当前解析：ffmpeg=${bins.ffmpeg}, ffprobe=${bins.ffprobe}`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${cmd} 退出 ${code}: ${(stderr || stdout).slice(-500)}`,
          ),
        );
    });
  });
}

export async function probeDurationSec(videoPath) {
  const { stdout } = await run(bins.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error('无法读取视频时长');
  return n;
}

/** 抽整段音轨为 16k mono wav（口播 ASR 友好） */
export async function extractAudioWav(videoPath, outWav) {
  await fs.mkdir(path.dirname(outWav), { recursive: true });
  await run(bins.ffmpeg, [
    '-y',
    '-i',
    videoPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outWav,
  ]);
  return outWav;
}

/**
 * 将总时长切成若干分析窗口（秒）。
 * 若段数超过 maxChunks，则均匀拉长每段以覆盖全片。
 * @returns {Array<{ index: number, startSec: number, durationSec: number, endSec: number }>}
 */
export function listChunkWindows(durationSec, chunkSec, maxChunks = 12) {
  const D = Math.max(0, Number(durationSec) || 0);
  const maxC = Math.max(1, Math.min(48, Number(maxChunks) || 12));
  let N = Math.max(15, Number(chunkSec) || 180);
  if (D <= 0) {
    return [{ index: 0, startSec: 0, durationSec: N, endSec: N }];
  }
  if (D <= N + 1) {
    return [{ index: 0, startSec: 0, durationSec: D, endSec: D }];
  }
  let count = Math.ceil(D / N);
  if (count > maxC) {
    N = Math.ceil(D / maxC);
    count = Math.ceil(D / N);
  }
  const windows = [];
  for (let i = 0; i < count; i++) {
    const startSec = i * N;
    if (startSec >= D - 0.5) break;
    const durationSecChunk = Math.min(N, D - startSec);
    windows.push({
      index: i,
      startSec,
      durationSec: durationSecChunk,
      endSec: startSec + durationSecChunk,
    });
  }
  return windows.length
    ? windows
    : [{ index: 0, startSec: 0, durationSec: D, endSec: D }];
}

/**
 * 从视频抽取 [startSec, startSec+durationSec) 为 16k mono 48k mp3
 */
export async function extractAudioMp3Segment(
  videoPath,
  outMp3,
  startSec,
  durationSec,
) {
  await fs.mkdir(path.dirname(outMp3), { recursive: true });
  const ss = Math.max(0, Number(startSec) || 0);
  const t = Math.max(1, Number(durationSec) || 180);
  // -ss 放在 -i 前：快切；ASR 对精确帧边界不敏感
  await run(bins.ffmpeg, [
    '-y',
    '-ss',
    String(ss),
    '-i',
    videoPath,
    '-t',
    String(t),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '48k',
    outMp3,
  ]);
  return outMp3;
}

/**
 * 导出整段或限长紧凑 mp3
 */
export async function extractAudioMp3(videoPath, outMp3, maxSec) {
  await fs.mkdir(path.dirname(outMp3), { recursive: true });
  const args = ['-y', '-i', videoPath];
  if (maxSec && maxSec > 0) {
    args.push('-t', String(maxSec));
  }
  args.push('-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outMp3);
  await run(bins.ffmpeg, args);
  return outMp3;
}

/** @deprecated 仅兼容旧调用；请用分段 listChunkWindows */
export async function clipVideoHead(videoPath, outPath, maxSec) {
  const dur = await probeDurationSec(videoPath).catch(() => 0);
  const n = Math.max(5, Number(maxSec) || 180);
  if (dur > 0 && dur <= n + 1) {
    return { clipPath: videoPath, clippedToSec: dur };
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(bins.ffmpeg, [
    '-y',
    '-i',
    videoPath,
    '-t',
    String(n),
    '-c',
    'copy',
    outPath,
  ]);
  return { clipPath: outPath, clippedToSec: n };
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** 在指定秒数截一帧 JPEG */
export async function extractFrameAt(videoPath, tSec, outJpg) {
  await fs.mkdir(path.dirname(outJpg), { recursive: true });
  const ss = Math.max(0, tSec);
  await run(bins.ffmpeg, [
    '-y',
    '-ss',
    String(ss),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outJpg,
  ]);
  return outJpg;
}

export async function fileToDataUrl(filePath, mime = 'image/jpeg') {
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}
