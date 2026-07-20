import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const profile = args.find((value) => value.startsWith('--profile='))?.slice(10) || 'douyin-hybrid';
const desktopDir = path.join(root, 'dist', 'desktop', profile);
const versionPath = path.join(desktopDir, 'version.json');
if (!fs.existsSync(versionPath)) throw new Error(`请先构建 profile=${profile}`);
const version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
if (!version.ffmpegBundled) throw new Error('正式安装器必须包含 FFmpeg');
const hasDouyin = profile.startsWith('douyin-');
const candidates = [
  process.env.ISCC_PATH,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].filter(Boolean);
const iscc = candidates.find((candidate) => fs.existsSync(candidate));
if (!iscc) throw new Error('未找到 Inno Setup 6');

const defines = [
  `/DProfile=${profile}`,
  `/DMyAppVersion=${version.version}`,
  `/DHasDouyin=${hasDouyin ? 1 : 0}`,
];
if (hasDouyin) {
  const chromeId = process.env.VIDEO_ANALYSIS_CHROME_EXTENSION_ID;
  const edgeId = process.env.VIDEO_ANALYSIS_EDGE_EXTENSION_ID || chromeId;
  if (!chromeId || !/^[a-p]{32}$/.test(chromeId)) throw new Error('Douyin Profile 需要有效 Chrome 扩展 ID');
  if (!edgeId || !/^[a-p]{32}$/.test(edgeId)) throw new Error('Douyin Profile 需要有效 Edge 扩展 ID');
  defines.push(`/DChromeExtensionId=${chromeId}`, `/DEdgeExtensionId=${edgeId}`);
}
execFileSync(iscc, [...defines, path.join(root, 'installer', 'VideoAnalysisRuntime.iss')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
const installerPath = path.join(
  root, 'dist', 'installer',
  `Video-Analysis-Runtime-${version.version}-win-x64-${profile}.exe`,
);
if (!fs.existsSync(installerPath)) throw new Error(`未生成安装器：${installerPath}`);
const hash = crypto.createHash('sha256').update(fs.readFileSync(installerPath)).digest('hex');
fs.writeFileSync(`${installerPath}.sha256`, `${hash}  ${path.basename(installerPath)}\n`, 'ascii');
console.log(`安装器已生成：${installerPath}`);
