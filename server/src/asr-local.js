/**
 * 本地 faster-whisper：按任务 spawn Python 子进程，结束释放显存。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asrDir = process.env.VIDEO_ANALYSIS_RUNTIME_ASR_DIR
  ? path.resolve(process.env.VIDEO_ANALYSIS_RUNTIME_ASR_DIR)
  : process.env.VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR
    ? path.join(process.env.VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR, 'asr')
    : path.resolve(__dirname, '..', 'asr');
let cudaFallbackActive = false;

function pathExists(value) {
  return Boolean(value) && fs.existsSync(value);
}

function resolveRunner() {
  const configured =
    config.localAsr?.runner ||
    process.env.VIDEO_ANALYSIS_RUNTIME_ASR_RUNNER;
  if (pathExists(configured)) return path.resolve(configured);
  const candidates = [
    path.join(asrDir, 'runtime', 'VideoAnalysisAsr.exe'),
    path.join(asrDir, 'runtime', 'VideoAnalysisAsr', 'VideoAnalysisAsr.exe'),
  ];
  return candidates.find(pathExists);
}

function resolveModel(model) {
  const requested = String(model || '').trim();
  const configured = config.localAsr?.modelPath || process.env.LOCAL_ASR_MODEL_PATH;
  if (pathExists(configured)) return path.resolve(configured);
  if (path.isAbsolute(requested) && pathExists(requested)) {
    return path.resolve(requested);
  }
  const names = requested ? [requested] : ['small'];
  const candidates = names.flatMap((name) => [
    path.join(asrDir, 'models', name),
    path.join(asrDir, 'models', `faster-whisper-${name}`),
  ]);
  return candidates.find(pathExists) || requested || 'small';
}

/** 桌面健康检查与日志使用；不会触发模型加载或网络下载。 */
export function getLocalAsrStatus() {
  const configuredModel = config.localAsr?.model || 'small';
  const model = resolveModel(configuredModel);
  const runner = resolveRunner();
  const script = path.join(asrDir, 'transcribe.py');
  const winVenv = path.join(asrDir, '.venv', 'Scripts', 'python.exe');
  const nixVenv = path.join(asrDir, '.venv', 'bin', 'python');
  const python = config.localAsr?.python ||
    (pathExists(winVenv) ? winVenv : pathExists(nixVenv) ? nixVenv : undefined);
  const bundledModel = pathExists(model) && path.resolve(model) !== path.resolve(configuredModel);
  const runtimeReady = Boolean(runner || (pathExists(script) && python));
  return {
    provider: config.asrProvider,
    model: configuredModel,
    modelPath: pathExists(model) ? model : undefined,
    bundledModel,
    runner: runner || undefined,
    runtimeReady,
    ready: runtimeReady && (!config.managed || bundledModel),
    device: config.localAsr?.device || 'cuda',
    computeType: config.localAsr?.computeType || '',
  };
}

function looksLikeMissingCudaRuntime(text) {
  return /cublas|cudnn|libcudart|nvrtc|cuda.+(?:not found|cannot be loaded|unavailable)/i.test(
    text || '',
  );
}

function resolvePython() {
  if (config.localAsr?.python) return config.localAsr.python;
  // 优先 venv
  const winVenv = path.join(asrDir, '.venv', 'Scripts', 'python.exe');
  const nixVenv = path.join(asrDir, '.venv', 'bin', 'python');
  if (process.platform === 'win32' && fs.existsSync(winVenv)) return winVenv;
  if (fs.existsSync(nixVenv)) return nixVenv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolveBundledNvidiaPath() {
  const sitePackages = path.join(asrDir, '.venv', 'Lib', 'site-packages');
  const candidates = [
    path.join(sitePackages, 'nvidia', 'cublas', 'bin'),
    path.join(sitePackages, 'nvidia', 'cudnn', 'bin'),
    path.join(sitePackages, 'nvidia', 'cuda_nvrtc', 'bin'),
  ].filter((dir) => fs.existsSync(dir));
  return candidates.length
    ? [...candidates, process.env.PATH || ''].join(path.delimiter)
    : process.env.PATH;
}

/**
 * @param {string} wavPath
 * @returns {Promise<{ text: string, segments: Array<{start:number,end:number,text:string}> }>}
 */
export async function transcribeWithLocalFasterWhisper(wavPath, opts = {}) {
  const audioPath = path.resolve(wavPath);
  if (!fs.existsSync(audioPath)) {
    throw new Error(`本地 ASR：音频不存在 ${audioPath}`);
  }

  const script = path.join(asrDir, 'transcribe.py');
  const runner = resolveRunner();
  if (!runner && !fs.existsSync(script)) {
    throw new Error(`本地 ASR：找不到 ${script}`);
  }

  const python = runner || resolvePython();
  const model = resolveModel(opts.model || config.localAsr?.model || 'small');
  const requestedDevice = config.localAsr?.device || 'cuda';
  const device =
    requestedDevice === 'cuda' && cudaFallbackActive ? 'cpu' : requestedDevice;
  const computeType =
    requestedDevice === 'cuda' && cudaFallbackActive
      ? 'int8'
      : config.localAsr?.computeType || '';
  const language = config.localAsr?.language || 'zh';
  const timeoutMs = config.localAsr?.timeoutMs || 10 * 60 * 1000;

  const args = [
    ...(runner ? [] : [script]),
    audioPath,
    '--model',
    model,
    '--device',
    device,
    '--language',
    language,
  ];
  if (computeType) {
    args.push('--compute-type', computeType);
  }
  if (config.localAsr?.vad) {
    args.push('--vad');
  }

  console.log(
    `[asr-local] ${python} model=${model} device=${device} file=${path.basename(audioPath)} bundled=${Boolean(runner)}`,
  );
  if (!pathExists(model) || !path.isAbsolute(model)) {
    console.log(
      '[asr-local] 未找到内置模型目录，将按 faster-whisper 默认行为从本地缓存或 HuggingFace 查找。',
    );
  }

  const result = await runProcess(python, args, {
    cwd: asrDir,
    timeoutMs,
  });

  if (
    requestedDevice === 'cuda' &&
    device === 'cuda' &&
    looksLikeMissingCudaRuntime(result.stderr)
  ) {
    cudaFallbackActive = true;
    console.warn(
      '[asr-local] 已记住 CUDA 运行库不可用；本次服务后续分段将直接使用 CPU int8',
    );
  }

  let parsed;
  try {
    // 取最后一行非空 JSON
    const lines = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1] || '';
    parsed = JSON.parse(last);
  } catch {
    throw new Error(
      `本地 ASR 输出无法解析 JSON。stderr=${result.stderr.slice(-400)} stdout=${result.stdout.slice(-200)}`,
    );
  }

  if (parsed.error) {
    throw new Error(`本地 ASR: ${parsed.error}`);
  }

  const text = String(parsed.text || '').trim();
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || '').trim(),
      }))
    : [];

  if (!text && !segments.length) {
    throw new Error('本地 ASR 返回空转写');
  }

  return {
    text: text || segments.map((s) => s.text).join(''),
    segments,
  };
}

function runProcess(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // Windows 中文系统默认可能让管道使用 GBK，导致 Node 按 UTF-8 解码后 JSON 损坏。
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // 支持通过 pip 安装在项目 venv 内的 NVIDIA cuBLAS/cuDNN DLL。
        PATH: resolveBundledNvidiaPath(),
        // Windows 无 symlink 时的提示；不改变功能
        HF_HUB_DISABLE_SYMLINKS_WARNING:
          process.env.HF_HUB_DISABLE_SYMLINKS_WARNING || '1',
        // 国内可在 .env 设 HF_ENDPOINT=https://hf-mirror.com
      },
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`本地 ASR 超时（>${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += stdoutDecoder.write(d);
    });
    child.stderr?.on('data', (d) => {
      const s = stderrDecoder.write(d);
      stderr += s;
      // 转发进度日志
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) console.log(line.trim());
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `无法启动本地 ASR（${cmd}）: ${err.message}。桌面版请确认安装包包含 asr/runtime；开发环境请创建 server/asr/.venv 并 pip install -r requirements.txt`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      stderr += stderrTail;
      if (stderrTail.trim()) console.log(stderrTail.trim());
      if (code === 0 || stdout.trim()) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        new Error(
          `本地 ASR 退出码 ${code}。stderr=${stderr.slice(-500)}`,
        ),
      );
    });
  });
}
