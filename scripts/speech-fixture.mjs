import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Real, repeatable speech for local inference tests; never contacts a TTS service. */
export async function speechFixture(output, text) {
  if (process.platform === 'win32') {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $voice.SetOutputToWaveFile($env:SHAREDCUT_TEST_WAV); $voice.Speak($env:SHAREDCUT_TEST_TEXT) } finally { $voice.Dispose() }'],
      { env: { ...process.env, SHAREDCUT_TEST_WAV: output, SHAREDCUT_TEST_TEXT: text }, windowsHide: true });
  } else if (process.platform === 'darwin') {
    await exec('say', ['-v', 'Samantha', '-r', '165', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', output, text]);
  } else {
    await exec('espeak', ['-s', '165', '-w', output, text]);
  }
}
