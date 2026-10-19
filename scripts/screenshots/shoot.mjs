#!/usr/bin/env node
// Takes the screenshots with headless Chrome (--screenshot) against a running server.py + Vite.
// Usage: node shoot.mjs --lang ko|en --out <dir> [--port 1555] [--only main,diff] [--scale 2]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(join(here, 'shots.js')); // sets globalThis.__SHOTS__
const { SHOTS } = globalThis.__SHOTS__;

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const lang = arg('lang', 'ko');
const out = resolve(arg('out', join(here, 'out', lang)));
const port = arg('port', '1555');
const scale = arg('scale', '2');
const only = arg('only', '')?.split(',').filter(Boolean);
const MIN_W = 500;
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

execFileSync('mkdir', ['-p', out]);
for (const [name, [w, h, extra]] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const profile = mkdtempSync(join(tmpdir(), 'lanes-shot-'));
  const url = `http://127.0.0.1:${port}/index.html?shot=${name}&lang=${lang}${extra ? '&' + extra : ''}`;
  const file = join(out, name + '.png');
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`,
      `--window-size=${Math.max(w, MIN_W)},${h}`, `--force-device-scale-factor=${scale}`, '--virtual-time-budget=10000',
      `--lang=${lang === 'en' ? 'en-US' : 'ko-KR'}`, `--screenshot=${file}`, url,
    ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    if (w < MIN_W) {
      // keep the left `w` CSS px (needs Pillow)
      execFileSync('python3', ['-c', 'import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.crop((0, 0, int(sys.argv[2]), int(sys.argv[3]))).save(sys.argv[1])',
        file, String(w * scale), String(h * scale)]);
    }
    console.log('wrote', file);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
