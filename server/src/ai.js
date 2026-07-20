import fs from 'node:fs/promises';
import { config } from './config.js';

function resolveAi(payloadAi) {
  const chatBase = String(payloadAi?.baseUrl || config.ai.baseUrl).replace(/\/$/, '');
  const whisperBase = String(
    process.env.WHISPER_BASE_URL || config.ai.whisperBaseUrl || chatBase,
  ).replace(/\/$/, '');
  return {
    baseUrl: chatBase,
    apiKey: payloadAi?.apiKey || config.ai.apiKey,
    model: payloadAi?.model || config.ai.model,
    whisperModel: config.ai.whisperModel,
    whisperBaseUrl: whisperBase,
    whisperApiKey:
      process.env.WHISPER_API_KEY ||
      config.ai.whisperApiKey ||
      payloadAi?.apiKey ||
      config.ai.apiKey,
  };
}

export function resolveAsrSettings(payloadAsr, payloadAi) {
  const requested = String(payloadAsr?.provider || 'server').toLowerCase();
  const provider = requested === 'server' ? config.asrProvider : requested;
  const allowed = new Set([
    'off', 'none', 'local', 'faster-whisper', 'dashscope', 'bailian',
    'qwen', 'qwen3-asr-flash', 'openai', 'whisper',
  ]);
  return {
    provider: allowed.has(provider) ? provider : config.asrProvider,
    baseUrl: String(payloadAsr?.baseUrl || '').trim(),
    apiKey: String(payloadAsr?.apiKey || '').trim(),
    model: String(payloadAsr?.model || '').trim(),
    ai: resolveAi(payloadAi),
  };
}

function transcriptionUrls(base) {
  const value = String(base || '').replace(/\/$/, '');
  const urls = [`${value}/audio/transcriptions`];
  if (!/\/v1$/i.test(value)) urls.push(`${value}/v1/audio/transcriptions`);
  if (/\/chat\/completions$/i.test(value)) {
    const root = value.replace(/\/chat\/completions$/i, '');
    urls.push(`${root}/audio/transcriptions`, `${root}/v1/audio/transcriptions`);
  }
  return [...new Set(urls)];
}

export async function transcribeAudio(audioPath, payloadAi, payloadAsr) {
  const runtime = resolveAsrSettings(payloadAsr, payloadAi);
  const provider = runtime.provider;
  if (provider === 'off' || provider === 'none') throw new Error('ASR 已关闭');
  if (provider === 'local' || provider === 'faster-whisper') {
    try {
      const { transcribeWithLocalFasterWhisper } = await import('./asr-local.js');
      return await transcribeWithLocalFasterWhisper(audioPath, {
        model: runtime.model || undefined,
      });
    } catch (error) {
      const fallback = config.localAsr?.fallback;
      if (['dashscope', 'bailian', 'qwen'].includes(fallback)) {
        return transcribeDashscope(audioPath, runtime);
      }
      if (['openai', 'whisper'].includes(fallback)) {
        return transcribeOpenAiCompatible(audioPath, runtime);
      }
      throw error;
    }
  }
  if (['dashscope', 'bailian', 'qwen', 'qwen3-asr-flash'].includes(provider)) {
    return transcribeDashscope(audioPath, runtime);
  }
  return transcribeOpenAiCompatible(audioPath, runtime);
}

async function transcribeDashscope(audioPath, runtime) {
  const { transcribeWithDashScope } = await import('./asr-dashscope.js');
  const apiKey =
    runtime.apiKey ||
    config.dashscope.apiKey ||
    process.env.DASHSCOPE_API_KEY ||
    runtime.ai.whisperApiKey;
  return transcribeWithDashScope(audioPath, {
    apiKey,
    baseUrl: runtime.baseUrl || undefined,
    model: runtime.model || undefined,
  });
}

async function transcribeOpenAiCompatible(audioPath, runtime) {
  const apiKey = runtime.apiKey || runtime.ai.whisperApiKey || runtime.ai.apiKey;
  if (!apiKey) throw new Error('ASR API Key 未配置');
  const buffer = await fs.readFile(audioPath);
  const baseUrl = runtime.baseUrl || runtime.ai.whisperBaseUrl || runtime.ai.baseUrl;
  const model = runtime.model || runtime.ai.whisperModel;
  const errors = [];
  for (const url of transcriptionUrls(baseUrl)) {
    for (const responseFormat of ['verbose_json', 'json']) {
      try {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', model);
        form.append('response_format', responseFormat);
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        const body = await response.text();
        if (!response.ok) {
          errors.push(`${url} -> ${response.status} ${body.slice(0, 120)}`);
          continue;
        }
        let data;
        try { data = JSON.parse(body); } catch { return { text: body.trim(), segments: [] }; }
        const segments = Array.isArray(data.segments)
          ? data.segments.map((segment) => ({
              start: Number(segment.start) || 0,
              end: Number(segment.end) || 0,
              text: String(segment.text || '').trim(),
            }))
          : [];
        const text = String(data.text || data.result || '').trim();
        if (text || segments.length) {
          return { text: text || segments.map((segment) => segment.text).join(''), segments };
        }
        errors.push(`${url} -> empty transcription`);
      } catch (error) {
        errors.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`OpenAI compatible ASR failed:\n- ${errors.slice(0, 6).join('\n- ')}`);
}
