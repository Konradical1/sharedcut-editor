import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Windows performance checks should exercise the installed hardware-accelerated
// browser. Bundled headless Chromium can use software rendering/limited codecs.
export function browserExecutable() {
  if(process.env.PLAYWRIGHT_EXECUTABLE_PATH)return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if(process.platform!=='win32')return undefined;
  const candidates=[
    process.env.ProgramFiles&&join(process.env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),
    process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),
    process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'),
  ];
  return candidates.find(path=>path&&existsSync(path))||undefined;
}
