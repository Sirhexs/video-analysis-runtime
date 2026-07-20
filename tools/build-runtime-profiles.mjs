import { execFileSync } from 'node:child_process';
import process from 'node:process';

const profiles = ['cloud', 'hybrid', 'douyin-cloud', 'douyin-hybrid'];
for (const profile of profiles) {
  execFileSync(process.execPath, ['tools/build-desktop.mjs', `--profile=${profile}`], {
    stdio: 'inherit',
    windowsHide: true,
  });
  execFileSync(process.execPath, ['tools/build-installer.mjs', `--profile=${profile}`], {
    stdio: 'inherit',
    windowsHide: true,
  });
}
