import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const entry = path.join(serverRoot, 'src', 'index.js');
const logDir = process.env.LOG_DIR || path.join(serverRoot, 'logs');

fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'server.log');
const logFd = fs.openSync(logPath, 'a');

try {
  const child = spawn(process.execPath, [entry], {
    cwd: serverRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      VIDEO_ANALYSIS_RUNTIME_MANAGED: '1',
    },
  });
  child.unref();
} finally {
  fs.closeSync(logFd);
}
