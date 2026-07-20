/**
 * 本地验证 polydl 下载：
 *   DOUYIN_COOKIE="..." node scripts/test-download.mjs 7661883734753090469
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadDouyinVideo } from '../src/download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2] || '7661883734753090469';
const workDir = path.join(__dirname, '..', 'data', 'videos', id);

console.log('awemeId=', id);
console.log('workDir=', workDir);
console.log('cookie length=', (process.env.DOUYIN_COOKIE || '').length);

try {
  const r = await downloadDouyinVideo({
    externalId: id,
    url: `https://www.douyin.com/video/${id}`,
    cookie: process.env.DOUYIN_COOKIE || '',
    workDir,
  });
  console.log('OK', r);
} catch (e) {
  console.error('FAIL', e);
  process.exit(1);
}
