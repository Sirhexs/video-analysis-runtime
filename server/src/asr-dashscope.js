/**
 * 阿里云百炼 qwen3-asr-flash 同步转写
 * 文档：https://help.aliyun.com/zh/model-studio/qwen-speech-recognition
 *
 * 限制：≤5 分钟、≤10MB（Base64 后仍需满足）
 * 输入：公网 URL 或 data:audio/wav;base64,...
 */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { getFfmpegBins } from './ffmpeg.js';

const MAX_BYTES = 9 * 1024 * 1024; // 留余量 < 10MB

/**
 * @param {string} audioPath wav/mp3 等本地路径
 * @param {{ apiKey?: string, baseUrl?: string, model?: string }} [opts]
 * @returns {Promise<{ text: string, segments: Array<{start:number,end:number,text:string}> }>}
 */
export async function transcribeWithDashScope(audioPath, opts = {}) {
  const apiKey = opts.apiKey || config.dashscope.apiKey;
  const baseUrl = (opts.baseUrl || config.dashscope.baseUrl).replace(/\/$/, '');
  const model = opts.model || config.dashscope.model;
  if (!apiKey) {
    throw new Error(
      '未配置百炼 API Key：请设置环境变量 DASHSCOPE_API_KEY（或 BAILIAN_API_KEY）',
    );
  }

  let filePath = audioPath;
  let mime = guessMime(audioPath);
  let buf = await fs.readFile(filePath);

  // 过大则压成 mp3
  if (buf.length > MAX_BYTES) {
    console.warn(
      `[asr-dashscope] 音频 ${(buf.length / 1024 / 1024).toFixed(1)}MB 过大，尝试压缩为 mp3`,
    );
    filePath = await compressToMp3(audioPath);
    mime = 'audio/mpeg';
    buf = await fs.readFile(filePath);
    if (buf.length > MAX_BYTES) {
      throw new Error(
        `音频仍超过百炼限制（${(buf.length / 1024 / 1024).toFixed(1)}MB > 10MB），请裁剪视频时长`,
      );
    }
  }

  const b64 = buf.toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;

  // 1) 原生 multimodal-generation
  try {
    return await callNativeGeneration(apiKey, dataUrl, { baseUrl, model });
  } catch (e1) {
    console.warn(
      '[asr-dashscope] native API failed, try compatible-mode',
      e1 instanceof Error ? e1.message : e1,
    );
  }

  // 2) OpenAI 兼容 chat/completions + input_audio
  return await callCompatibleChat(apiKey, dataUrl, { model });
}

async function callNativeGeneration(apiKey, audioDataUrl, runtime) {
  const url = `${runtime.baseUrl}/services/aigc/multimodal-generation/generation`;
  const body = {
    model: runtime.model,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ audio: audioDataUrl }],
        },
      ],
    },
    parameters: {
      asr_options: {
        enable_itn: false,
        language: 'zh',
      },
    },
  };

  console.log(
    `[asr-dashscope] POST ${url} model=${runtime.model} (native)`,
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`DashScope ${res.status}: ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  if (data.code && data.code !== 'Success' && data.message) {
    throw new Error(`DashScope: ${data.code} ${data.message}`);
  }
  return parseDashScopeResult(data);
}

async function callCompatibleChat(apiKey, audioDataUrl, runtime) {
  const url = `${config.dashscope.compatibleBaseUrl}/chat/completions`;
  const body = {
    model: runtime.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: audioDataUrl },
          },
        ],
      },
    ],
    stream: false,
    // 部分 SDK 用 extra_body；HTTP 里直接放顶层 asr_options 也试
    asr_options: { enable_itn: false, language: 'zh' },
  };

  console.log(
    `[asr-dashscope] POST ${url} model=${runtime.model} (compatible)`,
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`DashScope compatible ${res.status}: ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  // OpenAI 形
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return { text: content.trim(), segments: [] };
  }
  return parseDashScopeResult(data);
}

function parseDashScopeResult(data) {
  // 多种返回形态
  let text = '';
  const segments = [];

  // output.choices[0].message.content
  const content =
    data.output?.choices?.[0]?.message?.content ??
    data.choices?.[0]?.message?.content ??
    data.output?.text;

  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') text += part;
      else if (part?.text) text += part.text;
      else if (part?.transcript) text += part.transcript;
    }
    text = text.trim();
  } else if (content && typeof content === 'object' && content.text) {
    text = String(content.text).trim();
  }

  // 部分结果带 sentences
  const sentences =
    data.output?.sentences ||
    data.output?.choices?.[0]?.message?.sentences ||
    data.sentences;
  if (Array.isArray(sentences)) {
    for (const s of sentences) {
      let start = Number(s.begin_time ?? s.start ?? s.begin ?? 0);
      let end = Number(s.end_time ?? s.end ?? 0);
      // 百炼常见毫秒时间戳
      if (start > 1000 || end > 1000) {
        start /= 1000;
        end /= 1000;
      }
      segments.push({
        start,
        end,
        text: String(s.text || s.sentence || '').trim(),
      });
    }
    if (!text) text = segments.map((s) => s.text).join('');
  }

  if (!text) {
    throw new Error(
      `DashScope 返回无法解析文本: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }

  // 去掉可能的 language 前缀标记
  text = text.replace(/^\[?(zh|en|yue|ja|ko)\]?\s*/i, '').trim();

  return { text, segments };
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.webm') return 'audio/webm';
  return 'audio/wav';
}

async function compressToMp3(inputPath) {
  const bins = getFfmpegBins();
  const out = inputPath.replace(/\.[^.]+$/, '') + '.asr-compact.mp3';
  await new Promise((resolve, reject) => {
    const child = spawn(
      bins.ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '48k',
        out,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let err = '';
    child.stderr?.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg compress failed: ${err.slice(-300)}`));
    });
  });
  return out;
}
