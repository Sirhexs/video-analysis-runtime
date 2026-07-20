import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * 解析 ffmpeg / ffprobe 可执行文件路径。
 * 优先环境变量，其次 PATH，再扫 winget/scoop 常见目录。
 * 解决：系统终端有 ffmpeg，但 VS Code 集成终端 PATH 未刷新。
 */
export function resolveFfmpegBins() {
  const envFfmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN;
  const envFfprobe = process.env.FFPROBE_PATH || process.env.FFPROBE_BIN;

  const bundledDir =
    process.env.VIDEO_ANALYSIS_RUNTIME_FFMPEG_DIR ||
    (process.env.VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR
      ? path.join(process.env.VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR, 'ffmpeg')
      : '');
  const bundledFfmpeg = bundledDir
    ? path.join(bundledDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : '';
  const bundledFfprobe = bundledDir
    ? path.join(bundledDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : '';

  const ffmpeg =
    envFfmpeg ||
    (bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : null) ||
    findBin('ffmpeg');
  const ffprobe =
    envFfprobe ||
    (bundledFfprobe && fs.existsSync(bundledFfprobe)
      ? bundledFfprobe
      : null) ||
    (ffmpeg ? siblingBin(ffmpeg, 'ffprobe') : null) ||
    findBin('ffprobe');

  return {
    ffmpeg: ffmpeg || 'ffmpeg',
    ffprobe: ffprobe || 'ffprobe',
    resolved: Boolean(ffmpeg && ffprobe),
  };
}

function siblingBin(ffmpegPath, name) {
  const dir = path.dirname(ffmpegPath);
  const cand =
    process.platform === 'win32'
      ? path.join(dir, `${name}.exe`)
      : path.join(dir, name);
  return fs.existsSync(cand) ? cand : null;
}

function findBin(name) {
  // 1) PATH（当前进程）
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (out && fs.existsSync(out)) return out;
    } else {
      const out = execFileSync('which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out && fs.existsSync(out)) return out;
    }
  } catch {
    /* ignore */
  }

  // 2) 从「系统注册表级 PATH」再找一遍（VS Code 旧 PATH 时仍可用）
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$m=[Environment]::GetEnvironmentVariable('Path','Machine');` +
            `$u=[Environment]::GetEnvironmentVariable('Path','User');` +
            `$env:Path=\"$m;$u\";` +
            `(Get-Command ${name} -ErrorAction SilentlyContinue).Source`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* ignore */
    }
  }

  // 3) 常见安装位置
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const wingetRoot = path.join(
      home,
      'AppData',
      'Local',
      'Microsoft',
      'WinGet',
      'Packages',
    );
    if (fs.existsSync(wingetRoot)) {
      for (const pkg of fs.readdirSync(wingetRoot)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const pkgDir = path.join(wingetRoot, pkg);
        try {
          walkForBin(pkgDir, name, candidates, 4);
        } catch {
          /* ignore */
        }
      }
    }
    candidates.push(
      path.join(home, 'scoop', 'shims', `${name}.exe`),
      path.join('C:\\', 'ffmpeg', 'bin', `${name}.exe`),
      path.join('C:\\', 'Program Files', 'ffmpeg', 'bin', `${name}.exe`),
      path.join(
        'C:\\',
        'ProgramData',
        'chocolatey',
        'bin',
        `${name}.exe`,
      ),
    );
  } else {
    candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`);
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function walkForBin(dir, name, out, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      const base = e.name.toLowerCase();
      if (
        base === name.toLowerCase() ||
        base === `${name.toLowerCase()}.exe`
      ) {
        out.push(full);
      }
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      walkForBin(full, name, out, depth - 1);
    }
  }
}
