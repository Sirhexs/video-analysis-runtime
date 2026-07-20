/**
 * 轻量加载 .env（无第三方依赖）。
 * - 不覆盖已在 shell 里设置的环境变量
 * - 支持 KEY=VALUE、可选引号、# 注释
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

export function loadEnvFiles() {
  const candidates = [
    path.join(serverRoot, '.env'),
    path.join(serverRoot, '.env.local'),
  ];
  const loaded = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    applyEnvFile(file);
    loaded.push(path.basename(file));
  }
  return loaded;
}

function applyEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  // 去掉 UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // 已有环境变量优先（便于临时覆盖）
    if (process.env[key] !== undefined && process.env[key] !== '') continue;

    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // 简单反转义
    val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    process.env[key] = val;
  }
}
