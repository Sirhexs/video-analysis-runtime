import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './load-env.js';
import { resolveRuntimeProfile } from './profiles.js';

// 必须在读取 process.env 之前加载 .env
const loadedEnvFiles = loadEnvFiles();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function numberEnv(name, fallback, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * ASR_PROVIDER:
 * - dashscope / bailian / qwen：百炼 qwen3-asr-flash
 * - local / faster-whisper：本机 faster-whisper（按任务加载，结束释放显存）
 * - openai / whisper：OpenAI 兼容 /audio/transcriptions
 * - off：跳过转写
 */
const asrProvider = (
  process.env.ASR_PROVIDER ||
  process.env.ASR_MODE ||
  'dashscope'
).toLowerCase();

const profile = resolveRuntimeProfile();

export const config = {
  port: Number(process.env.PORT || 18765),
  host: process.env.HOST || '127.0.0.1',
  authToken:
    process.env.RUNTIME_AUTH_TOKEN || '',
  authDisabled:
    process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  logDir: process.env.LOG_DIR || path.join(root, 'logs'),
  installDir: process.env.VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR || '',
  managed: process.env.VIDEO_ANALYSIS_RUNTIME_MANAGED === '1',
  allowedOrigins: listEnv('ALLOWED_ORIGINS'),
  profile,
  apiVersion: '1.0',
  /** 0=禁用；桌面启动器默认传入 15 分钟 */
  idleExitMs: numberEnv('IDLE_EXIT_MS', 0, 0),
  maxConcurrentJobs: Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1)),
  maxConcurrentLightJobs: Math.max(
    1,
    Number(process.env.MAX_CONCURRENT_LIGHT_JOBS || 3),
  ),
  keepMedia: process.env.KEEP_MEDIA === '1' || process.env.KEEP_MEDIA === 'true',
  jobRetentionMs: Math.max(
    60_000,
    Number(process.env.JOB_RETENTION_MS || 24 * 60 * 60 * 1000),
  ),
  assetRetentionMs: Math.max(
    60_000,
    numberEnv('ASSET_RETENTION_MS', 24 * 60 * 60 * 1000, 60_000),
  ),
  maxAssetBytes: numberEnv('MAX_ASSET_BYTES', 2 * 1024 * 1024 * 1024, 1),
  assetImportTimeoutMs: numberEnv('ASSET_IMPORT_TIMEOUT_MS', 180_000, 1000),
  douyinCookie: process.env.DOUYIN_COOKIE || '',
  asrProvider,
  loadedEnvFiles,
  ai: {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
    whisperBaseUrl:
      process.env.WHISPER_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1',
    whisperApiKey:
      process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || '',
  },
  dashscope: {
    apiKey:
      process.env.DASHSCOPE_API_KEY ||
      process.env.BAILIAN_API_KEY ||
      process.env.WHISPER_API_KEY ||
      '',
    baseUrl: (
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope.aliyuncs.com/api/v1'
    ).replace(/\/$/, ''),
    model: process.env.DASHSCOPE_ASR_MODEL || 'qwen3-asr-flash',
    compatibleBaseUrl: (
      process.env.DASHSCOPE_COMPATIBLE_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/$/, ''),
  },
  localAsr: {
    /** tiny | base | small | medium | large-v3 */
    model: process.env.LOCAL_ASR_MODEL || 'small',
    /** 桌面包可提供的本地模型绝对路径；未设置时由 asr-local 解析内置目录 */
    modelPath: process.env.LOCAL_ASR_MODEL_PATH || '',
    /** 桌面包自包含 runner；开发环境为空时继续使用 Python/venv */
    runner: process.env.VIDEO_ANALYSIS_RUNTIME_ASR_RUNNER || '',
    /** cuda | cpu | auto */
    device: process.env.LOCAL_ASR_DEVICE || 'cuda',
    /** float16 | int8_float16 | int8 | float32 | 空=自动 */
    computeType: process.env.LOCAL_ASR_COMPUTE_TYPE || '',
    language: process.env.LOCAL_ASR_LANGUAGE || 'zh',
    python: process.env.LOCAL_ASR_PYTHON || '',
    vad: process.env.LOCAL_ASR_VAD === '1' || process.env.LOCAL_ASR_VAD === 'true',
    timeoutMs: Number(process.env.LOCAL_ASR_TIMEOUT_MS || 600_000),
    /** 本地失败时回落：dashscope | openai | 空=不回落 */
    fallback: (process.env.LOCAL_ASR_FALLBACK || '').toLowerCase(),
  },
  maxKeyFrames: Number(process.env.MAX_KEY_FRAMES || 6),
  /** 全量分析时每段最长秒数（分段连续 ASR），可被 job payload 覆盖 */
  longVideoMaxSec: Number(process.env.LONG_VIDEO_MAX_SEC || 180),
  /** 最多分成几段（超长则拉长每段以覆盖全片） */
  maxChunks: Number(process.env.MAX_CHUNKS || 12),
  version: '1.0.0',
  product: 'Video Analysis Runtime',
};
