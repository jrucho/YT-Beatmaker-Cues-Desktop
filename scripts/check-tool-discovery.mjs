import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from '../server/node_modules/esbuild/lib/main.js';

const root = await mkdtemp(path.join(tmpdir(), 'beatmaker-tools-'));
const previousBin = process.env.MUSIKE_BIN_DIR;
const previousYtdlp = process.env.YTDLP_PATH;
try {
  process.env.MUSIKE_BIN_DIR = root;
  delete process.env.YTDLP_PATH;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  await mkdir(path.join(root, 'ffmpeg'));
  const executable = path.join(root, 'ffmpeg', `ffmpeg${suffix}`);
  await writeFile(executable, '', {mode: 0o755});
  // An executable-looking directory must never be returned as a tool.
  await mkdir(path.join(root, `yt-dlp${suffix}`));
  const bundled = await build({
    entryPoints: ['server/src/tools.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm',
    define: {'import.meta.url': JSON.stringify(new URL('../server/src/config.ts', import.meta.url).href)},
  });
  const {refreshTools} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const tools = await refreshTools();
  assert.equal(tools.ffmpeg, executable);
  assert.equal(tools.ytdlp, null);
  assert.ok(tools.env[Object.keys(tools.env).find(key => key.toUpperCase() === 'PATH')].split(path.delimiter).includes(path.dirname(executable)));
  console.log('PASS: nested FFmpeg executable discovery; directories rejected; executable folder added to PATH');
} finally {
  if (previousBin === undefined) delete process.env.MUSIKE_BIN_DIR;
  else process.env.MUSIKE_BIN_DIR = previousBin;
  if (previousYtdlp === undefined) delete process.env.YTDLP_PATH;
  else process.env.YTDLP_PATH = previousYtdlp;
  await rm(root, {recursive: true, force: true});
}
