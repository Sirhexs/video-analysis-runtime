import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist', 'asr-bundle');
const runner = path.join(bundle, 'runtime', 'VideoAnalysisAsr.exe');
const model = path.join(bundle, 'models', 'faster-whisper-small');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-analysis-asr-'));
const audio = path.join(temp, 'silence.wav');

function makeSilenceWav(seconds = 1) {
  const sampleRate = 16_000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

assert.equal(await fs.stat(runner).then((s) => s.isFile()).catch(() => false), true);
assert.equal(await fs.stat(path.join(model, 'model.bin')).then((s) => s.isFile()).catch(() => false), true);
await fs.writeFile(audio, makeSilenceWav());

const child = spawn(runner, [audio, '--model', model, '--device', 'cpu', '--compute-type', 'int8', '--language', 'zh'], {
  cwd: bundle,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (value) => { stdout += value; });
child.stderr.on('data', (value) => { stderr += value; });
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`ASR Bundle 超时。stderr=${stderr.slice(-500)}`));
  }, 120_000);
  child.once('error', reject);
  child.once('exit', (value) => {
    clearTimeout(timer);
    resolve(value);
  });
});

assert.equal(code, 0, `ASR runner 退出码 ${code}：${stderr.slice(-1000)}`);
const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
assert.ok(lines.length > 0, `ASR runner 无 JSON 输出：${stderr.slice(-1000)}`);
const result = JSON.parse(lines.at(-1));
assert.equal(typeof result.text, 'string');
assert.ok(Array.isArray(result.segments));
await fs.rm(temp, { recursive: true, force: true });
console.log('ASR Bundle 冒烟测试通过');
