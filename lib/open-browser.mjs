import { spawn } from 'node:child_process';

export function openBrowser(target) {
  const isHeadless =
    process.env.NO_AUTO_OPEN === '1' ||
    process.env.HEADLESS === '1' ||
    process.env.CI ||
    process.argv.includes('--headless') ||
    process.argv.includes('--no-open') ||
    process.argv.includes('--collector') ||
    process.argv.includes('--daemon');
  if (isHeadless) return;
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.on('error', error => console.log('[Crucix] Could not open browser:', error.message));
  child.unref();
}
