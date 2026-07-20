import { config } from './config.js';
import { RuntimeError } from './errors.js';
import { transcribeAudio } from './ai.js';

function trimBase(value) {
  return String(value || '').replace(/\/$/, '');
}

function providerFromRef(ref, kind) {
  const name = String(ref || 'default');
  if (kind === 'llm' && ['default', 'openai', 'openai-compatible'].includes(name)) {
    return {
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
    };
  }
  if (kind === 'asr' && ['default', 'server'].includes(name)) {
    return { provider: config.asrProvider };
  }
  if (kind === 'asr' && ['local', 'dashscope', 'openai'].includes(name)) {
    return { provider: name };
  }
  throw new RuntimeError('provider_not_found', `未找到 ${kind} providerRef=${name}`, 404);
}

export function resolveProvider(spec, kind) {
  if (spec?.providerRef || !spec) {
    return { ...providerFromRef(spec?.providerRef, kind), ...(spec || {}) };
  }
  return { ...spec };
}

function assertCapability(provider, kind) {
  if (kind !== 'asr') return;
  const requested = String(provider.provider || 'server').toLowerCase();
  const actual = requested === 'server' ? config.asrProvider : requested;
  const normalized = ['faster-whisper'].includes(actual) ? 'local' : actual;
  const cloudName = ['bailian', 'qwen', 'qwen3-asr-flash'].includes(normalized)
    ? 'dashscope'
    : ['whisper'].includes(normalized)
      ? 'openai'
      : normalized;
  if (!config.profile.asr.includes(cloudName)) {
    throw new RuntimeError(
      'capability_unavailable',
      `当前 ${config.profile.name} 版本不包含 ASR provider=${cloudName}`,
      400,
    );
  }
}

export async function runAsr(filePath, spec = {}) {
  const provider = resolveProvider(spec, 'asr');
  assertCapability(provider, 'asr');
  const payloadAsr = {
    provider: provider.provider || provider.providerRef || 'server',
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
  };
  const payloadAi = provider.llm || {
    baseUrl: provider.baseUrl || config.ai.baseUrl,
    apiKey: provider.apiKey || config.ai.apiKey,
    model: provider.model || config.ai.model,
  };
  return transcribeAudio(filePath, payloadAi, payloadAsr);
}

function extractJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new RuntimeError('invalid_json_output', 'LLM 未返回有效 JSON', 502);
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new RuntimeError('invalid_json_output', 'LLM 未返回有效 JSON', 502);
    }
  }
}

function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && schema.type !== type) {
    errors.push(`${path} 应为 ${schema.type}，实际为 ${type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} 不在 enum 中`);
  if (type === 'object') {
    for (const required of schema.required || []) {
      if (!(required in value)) errors.push(`${path}.${required} 为必填字段`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateSchema(value[key], childSchema, `${path}.${key}`));
    }
  }
  if (type === 'array' && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateSchema(item, schema.items, `${path}[${index}]`));
    });
  }
  return errors;
}

async function chatOnce(provider, request, messages) {
  if (!provider.apiKey) {
    throw new RuntimeError('provider_credentials_missing', 'LLM API Key 未配置', 400);
  }
  const baseUrl = trimBase(provider.baseUrl || config.ai.baseUrl);
  const endpoint = /\/chat\/completions$/i.test(baseUrl)
    ? baseUrl
    : `${baseUrl}/chat/completions`;
  const body = {
    model: provider.model || config.ai.model,
    messages,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RuntimeError(
      'llm_request_failed',
      `LLM HTTP ${response.status}: ${text.slice(0, 300)}`,
      502,
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RuntimeError('llm_invalid_response', 'LLM 响应不是 JSON', 502);
  }
  const content = data.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new RuntimeError('llm_empty_response', 'LLM 返回为空', 502);
  }
  return { content, raw: data, model: data.model || body.model };
}

export async function runLlm(request = {}) {
  if (!Array.isArray(request.messages) || !request.messages.length) {
    throw new RuntimeError('invalid_request', 'llm.generate 需要 messages');
  }
  const provider = resolveProvider(request.provider, 'llm');
  const schema = request.jsonSchema || request.responseFormat?.json_schema?.schema;
  const repairAttempts = Math.max(0, Math.min(3, Number(request.repairAttempts) || 0));
  let messages = structuredClone(request.messages);
  let last;
  for (let attempt = 0; attempt <= repairAttempts; attempt++) {
    last = await chatOnce(provider, request, messages);
    if (!schema) return { ...last, repairAttemptsUsed: attempt };
    try {
      const parsed = extractJson(last.content);
      const errors = validateSchema(parsed, schema);
      if (!errors.length) {
        return { ...last, output: parsed, repairAttemptsUsed: attempt };
      }
      if (attempt === repairAttempts) {
        throw new RuntimeError('schema_validation_failed', 'LLM 输出不符合 JSON Schema', 502, {
          errors,
        });
      }
      messages = [
        ...messages,
        { role: 'assistant', content: String(last.content) },
        {
          role: 'user',
          content: `上一次输出未通过调用方提供的 JSON Schema：${errors.join('；')}。请只返回修正后的 JSON。`,
        },
      ];
    } catch (error) {
      if (attempt === repairAttempts) throw error;
      messages = [
        ...messages,
        { role: 'assistant', content: String(last.content) },
        { role: 'user', content: '上一次输出不是有效 JSON。请只返回符合调用方 Schema 的 JSON。' },
      ];
    }
  }
  return last;
}
