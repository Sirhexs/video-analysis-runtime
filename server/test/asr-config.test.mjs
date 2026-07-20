import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { resolveAsrSettings } from '../src/ai.js';

test('task ASR settings override provider and cloud fields', () => {
  const resolved = resolveAsrSettings(
    {
      provider: 'openai',
      baseUrl: 'https://asr.example.com/v1/',
      apiKey: 'asr-key',
      model: 'whisper-large-v3',
    },
    {
      baseUrl: 'https://chat.example.com/v1',
      apiKey: 'chat-key',
      model: 'chat-model',
    },
  );
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.baseUrl, 'https://asr.example.com/v1/');
  assert.equal(resolved.apiKey, 'asr-key');
  assert.equal(resolved.model, 'whisper-large-v3');
  assert.equal(resolved.ai.apiKey, 'chat-key');
});

test('server provider keeps environment configuration as fallback', () => {
  const resolved = resolveAsrSettings({ provider: 'server' }, {});
  assert.equal(resolved.provider, config.asrProvider);
  assert.equal(resolved.baseUrl, '');
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.model, '');
});

test('unknown task provider falls back to server provider', () => {
  const resolved = resolveAsrSettings({ provider: 'unknown' }, {});
  assert.equal(resolved.provider, config.asrProvider);
});
