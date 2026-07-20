import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((value) => value.startsWith('--out='));
const pythonArg = args.find((value) => value.startsWith('--python='));
const modelArg = args.find((value) => value.startsWith('--model-dir='));
const outDir = path.resolve(root, outArg?.slice('--out='.length) || 'dist/asr-bundle');
const asrSource = path.join(root, 'server', 'asr');
const python = path.resolve(
  pythonArg?.slice('--python='.length) ||
    process.env.VIDEO_ANALYSIS_RUNTIME_ASR_BUILD_PYTHON ||
    path.join(asrSource, '.venv', 'Scripts', 'python.exe'),
);

function fail(message) {
  throw new Error(`[ASR Bundle] ${message}`);
}

function run(file, commandArgs) {
  execFileSync(file, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
}

function pathExists(value) {
  return Boolean(value) && fs.existsSync(value);
}

function findModelSnapshot() {
  const explicit =
    modelArg?.slice('--model-dir='.length) ||
    process.env.VIDEO_ANALYSIS_RUNTIME_ASR_MODEL_DIR;
  if (explicit) return path.resolve(explicit);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const hfHome = process.env.HF_HOME || path.join(home, '.cache', 'huggingface');
  const snapshots = path.join(
    hfHome,
    'hub',
    'models--Systran--faster-whisper-small',
    'snapshots',
  );
  if (!pathExists(snapshots)) return undefined;
  return fs
    .readdirSync(snapshots, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(snapshots, entry.name))
    .filter((dir) => pathExists(path.join(dir, 'model.bin')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

if (!pathExists(python)) {
  fail(`找不到 Python 构建环境：${python}。请先创建 server/asr/.venv 并安装 requirements.txt。`);
}

const modelSource = findModelSnapshot();
if (!modelSource || !pathExists(path.join(modelSource, 'model.bin'))) {
  fail(
    '找不到 faster-whisper-small 模型。请先运行一次 transcribe.py 下载模型，或设置 VIDEO_ANALYSIS_RUNTIME_ASR_MODEL_DIR。',
  );
}

try {
  run(python, ['-m', 'PyInstaller', '--version']);
} catch {
  fail(
    '当前 Python 未安装 PyInstaller。请在 server/asr/.venv 中执行：python -m pip install -r requirements-build.txt',
  );
}

const workDir = path.join(root, 'dist', 'asr-build');
fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const runtimeDir = path.join(outDir, 'runtime');
run(python, [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name',
  'VideoAnalysisAsr',
  '--distpath',
  runtimeDir,
  '--workpath',
  path.join(workDir, 'work'),
  '--specpath',
  path.join(workDir, 'spec'),
  '--collect-all',
  'faster_whisper',
  '--collect-all',
  'ctranslate2',
  '--collect-all',
  'av',
  '--collect-all',
  'tokenizers',
  '--collect-all',
  'huggingface_hub',
  '--collect-all',
  'onnxruntime',
  '--collect-all',
  'nvidia',
  '--copy-metadata',
  'faster-whisper',
  '--copy-metadata',
  'ctranslate2',
  path.join(asrSource, 'transcribe.py'),
]);

const pyInstallerDir = path.join(runtimeDir, 'VideoAnalysisAsr');
const builtRunner = path.join(pyInstallerDir, 'VideoAnalysisAsr.exe');
if (!pathExists(builtRunner)) fail(`PyInstaller 未生成 runner：${builtRunner}`);
// 对外固定 runner 名称，避免 Host 依赖 PyInstaller 的目录布局。
for (const entry of fs.readdirSync(pyInstallerDir)) {
  fs.cpSync(path.join(pyInstallerDir, entry), path.join(runtimeDir, entry), {
    recursive: true,
  });
}
fs.rmSync(pyInstallerDir, { recursive: true, force: true });
const runner = path.join(runtimeDir, 'VideoAnalysisAsr.exe');

const modelTarget = path.join(outDir, 'models', 'faster-whisper-small');
fs.cpSync(modelSource, modelTarget, { recursive: true });
fs.copyFileSync(path.join(asrSource, 'transcribe.py'), path.join(outDir, 'transcribe.py'));

const manifest = {
  runtime: 'faster-whisper',
  runner: 'runtime/VideoAnalysisAsr.exe',
  model: 'faster-whisper-small',
  modelPath: 'models/faster-whisper-small',
  modelSource: 'Systran/faster-whisper-small',
  modelSizeBytes: fs
    .readdirSync(modelTarget, { withFileTypes: true })
    .reduce((total, entry) => {
      const target = path.join(modelTarget, entry.name);
      return total + (entry.isFile() ? fs.statSync(target).size : 0);
    }, 0),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(outDir, 'asr-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`[ASR Bundle] 已生成：${outDir}`);
console.log(`[ASR Bundle] 模型：${modelSource}`);
