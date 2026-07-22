import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspacePackage = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const version = String(workspacePackage.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json 中的版本号无效：${version || '<empty>'}`);
}
const args = process.argv.slice(2);
const valueArg = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = valueArg('profile') || 'douyin-hybrid';
const profilePath = path.join(root, 'profiles', `${profile}.json`);
if (!fs.existsSync(profilePath)) throw new Error(`未知 profile=${profile}`);
const profileManifest = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const features = {
  localAsr: Boolean(profileManifest.localAsr),
  douyin: Array.isArray(profileManifest.connectors) && profileManifest.connectors.includes('douyin'),
};
const outDir = path.resolve(root, valueArg('out') || path.join('dist', 'desktop', profile));
const skipFfmpeg = args.includes('--skip-ffmpeg');

function run(file, commandArgs, cwd = root) {
  execFileSync(file, commandArgs, { cwd, stdio: 'inherit', windowsHide: true });
}

function findOnPath(name) {
  try {
    return execFileSync('where.exe', [name], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/)
      .map((value) => value.trim())
      .find((candidate) => candidate && !isChocolateyShim(candidate));
  } catch { return undefined; }
}

function chocolateyRoots() {
  return [
    process.env.ChocolateyInstall,
    process.env.ProgramData && path.join(process.env.ProgramData, 'chocolatey'),
    'C:\\ProgramData\\chocolatey',
  ].filter(Boolean).map((value) => path.resolve(value));
}

function isChocolateyShim(candidate) {
  const directory = path.dirname(path.resolve(candidate)).toLowerCase();
  return chocolateyRoots().some(
    (rootDir) => directory === path.join(rootDir, 'bin').toLowerCase(),
  );
}

function findNamedFile(rootDir, name) {
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return undefined;
}

function findChocolateyFfmpeg(name) {
  for (const rootDir of chocolateyRoots()) {
    const toolsDir = path.join(rootDir, 'lib', 'ffmpeg', 'tools');
    const preferred = path.join(toolsDir, 'ffmpeg', 'bin', name);
    if (fs.existsSync(preferred)) return preferred;
    const discovered = findNamedFile(toolsDir, name);
    if (discovered) return discovered;
  }
  return undefined;
}

function configuredExecutable(candidate, name) {
  if (!candidate) return undefined;
  return isChocolateyShim(candidate) ? findChocolateyFfmpeg(name) : candidate;
}

function findWingetFfmpeg(name) {
  const packageRoot = path.join(
    process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
  );
  try {
    return fs.readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('ffmpeg-'))
      .map((entry) => path.join(packageRoot, entry.name, 'bin', name))
      .find((candidate) => fs.existsSync(candidate));
  } catch { return undefined; }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function verifyBundledExecutable(target, name, source) {
  try {
    execFileSync(target, ['-version'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
  } catch (error) {
    const stderr = error?.stderr?.toString('utf8').trim();
    const detail = stderr || error?.message || String(error);
    throw new Error(`打包后的 ${name} 无法独立运行（来源：${source}）：${detail}`);
  }
}

function copyServer() {
  const source = path.join(root, 'server');
  const target = path.join(outDir, 'server');
  fs.cpSync(source, target, {
    recursive: true,
    filter(current) {
      const relative = path.relative(source, current);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (parts.includes('data') || parts.includes('logs')) return false;
      if (parts.includes('.venv') || parts.includes('__pycache__')) return false;
      if (parts[0] === 'node_modules') return false;
      if (!features.douyin && relative === path.join('src', 'download.js')) return false;
      if (path.basename(current).startsWith('.env') && path.basename(current) !== '.env.example') return false;
      return true;
    },
  });
  const packagePath = path.join(target, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!features.douyin) packageJson.dependencies = {};
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  if (!features.douyin) {
    const lockPath = path.join(target, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages = { '': { ...lock.packages[''], dependencies: {} } };
    lock.dependencies = {};
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (features.douyin) {
    const modules = path.join(source, 'node_modules');
    if (!fs.existsSync(modules)) throw new Error('server/node_modules 不存在，请先 npm ci');
    fs.cpSync(modules, path.join(target, 'node_modules'), { recursive: true });
  }
}

function resolveAsrBundle() {
  const configured = valueArg('asr-bundle') || process.env.VIDEO_ANALYSIS_RUNTIME_ASR_BUNDLE;
  const candidates = [configured, path.join(root, 'dist', 'asr-bundle'), path.join(root, 'vendor', 'asr-bundle')]
    .filter(Boolean).map((value) => path.resolve(value));
  const bundle = candidates.find((value) => fs.existsSync(value));
  if (!bundle) throw new Error('Hybrid Profile 需要 ASR Bundle，请先执行 npm run prepare:asr');
  const runner = path.join(bundle, 'runtime', 'VideoAnalysisAsr.exe');
  const model = path.join(bundle, 'models', 'faster-whisper-small');
  const manifest = path.join(bundle, 'asr-manifest.json');
  if (!fs.existsSync(runner) || !fs.existsSync(model) || !fs.existsSync(manifest)) {
    throw new Error('ASR Bundle 不完整');
  }
  return { bundle, manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')) };
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

run('cargo', ['build', '--manifest-path', path.join(root, 'native-host', 'Cargo.toml'), '--release']);
copyFile(
  path.join(root, 'native-host', 'target', 'release', 'VideoAnalysisRuntimeHost.exe'),
  path.join(outDir, 'VideoAnalysisRuntimeHost.exe'),
);
copyFile(process.execPath, path.join(outDir, 'runtime', 'node.exe'));
copyServer();

let asrManifest;
if (features.localAsr) {
  const asrBundle = resolveAsrBundle();
  asrManifest = asrBundle.manifest;
  fs.cpSync(asrBundle.bundle, path.join(outDir, 'asr'), {
    recursive: true,
    filter(current) { return !current.split(path.sep).includes('__pycache__'); },
  });
}

const ffmpegDir = valueArg('ffmpeg-dir');
const ffmpeg = ffmpegDir
  ? path.resolve(root, ffmpegDir, 'ffmpeg.exe')
  : configuredExecutable(process.env.FFMPEG_PATH, 'ffmpeg.exe') || findOnPath('ffmpeg.exe') ||
    findChocolateyFfmpeg('ffmpeg.exe') || findWingetFfmpeg('ffmpeg.exe');
const ffprobe = ffmpegDir
  ? path.resolve(root, ffmpegDir, 'ffprobe.exe')
  : configuredExecutable(process.env.FFPROBE_PATH, 'ffprobe.exe') || findOnPath('ffprobe.exe') ||
    findChocolateyFfmpeg('ffprobe.exe') || findWingetFfmpeg('ffprobe.exe');
let ffmpegBundled = false;
if (ffmpeg && ffprobe && fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
  const bundledFfmpeg = path.join(outDir, 'ffmpeg', 'ffmpeg.exe');
  const bundledFfprobe = path.join(outDir, 'ffmpeg', 'ffprobe.exe');
  copyFile(ffmpeg, bundledFfmpeg);
  copyFile(ffprobe, bundledFfprobe);
  verifyBundledExecutable(bundledFfmpeg, 'ffmpeg.exe', ffmpeg);
  verifyBundledExecutable(bundledFfprobe, 'ffprobe.exe', ffprobe);
  ffmpegBundled = true;
} else if (!skipFfmpeg) {
  throw new Error('找不到 ffmpeg/ffprobe');
}

fs.mkdirSync(path.join(outDir, 'licenses'), { recursive: true });
if (features.douyin) {
  const license = path.join(root, 'server', 'node_modules', 'polydl', 'LICENSE');
  if (fs.existsSync(license)) copyFile(license, path.join(outDir, 'licenses', 'polydl-MIT.txt'));
}
fs.writeFileSync(
  path.join(outDir, 'licenses', 'FFmpeg-NOTICE.txt'),
  'This distribution may include FFmpeg. See https://ffmpeg.org/legal.html\n',
);

const capabilities = {
  product: 'Video Analysis Runtime',
  apiVersion: '1.0',
  profile,
  localAsr: features.localAsr,
  connectors: features.douyin ? ['douyin'] : [],
};
fs.writeFileSync(path.join(outDir, 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, 'version.json'),
  `${JSON.stringify({
    version,
    profile,
    node: process.version,
    builtAt: new Date().toISOString(),
    ffmpegBundled,
    asrBundled: features.localAsr,
    asrModel: asrManifest?.model,
  }, null, 2)}\n`,
);
console.log(`Video Analysis Runtime 已生成：${outDir}`);
