/**
 * Pré-rendu des winks : joue chaque .swf d'origine via Ruffle (headless) et capture les
 * frames réellement peintes (le canvas WebGL de Ruffle est vidé entre 2 dessins → on filtre
 * par alpha) pour les encoder en WebP animé (léger, natif, sans WASM au runtime).
 *
 * Usage : node scripts/prerender_winks.mjs [id ...]   (défaut : tous)
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const winksDir = path.join(publicDir, 'assets', 'winks');

function swfMeta(file) {
  let b = fs.readFileSync(file);
  const sig = b.toString('ascii', 0, 3);
  let body = b;
  if (sig === 'CWS') body = Buffer.concat([b.subarray(0, 8), zlib.inflateSync(b.subarray(8))]);
  let bit = 64;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) { const by = Math.floor(bit / 8), o = 7 - (bit % 8); v = (v << 1) | ((body[by] >> o) & 1); bit++; } return v; };
  const nb = rd(5);
  const xmin = rd(nb), xmax = rd(nb), ymin = rd(nb), ymax = rd(nb);
  const p = Math.ceil(bit / 8);
  const fps = body[p + 1] + body[p] / 256;
  const frames = body.readUInt16LE(p + 2);
  return { w: Math.round((xmax - xmin) / 20), h: Math.round((ymax - ymin) / 20), fps, frames, duration: frames / fps };
}

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.swf': 'application/x-shockwave-flash', '.png': 'image/png', '.json': 'application/json' };
function startServer(port) {
  const ruffleDir = path.join(root, '.ruffle');
  const srv = http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    let base = publicDir;
    if (url.startsWith('/ruffle/')) { base = ruffleDir; url = url.slice('/ruffle'.length); }
    const f = path.join(base, url);
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

const args = process.argv.slice(2);
const ids = args.length ? args : fs.readdirSync(winksDir).filter((d) => fs.existsSync(path.join(winksDir, d, `${d}.swf`)));

const PORT = 3199;
const server = await startServer(PORT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkpr-'));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

try {
  for (const id of ids) {
    const swf = path.join(winksDir, id, `${id}.swf`);
    const meta = swfMeta(swf);
    const capMs = Math.ceil(meta.duration * 1000) + 400;

    const dataUrls = await page.evaluate(async ({ swfUrl, capMs, w, h }) => {
      document.querySelectorAll('ruffle-player').forEach((p) => p.remove());
      if (!window.RufflePlayer) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/ruffle/ruffle.js'; s.onload = () => res(); s.onerror = () => rej(new Error('ruffle')); document.head.appendChild(s); });
      }
      const player = window.RufflePlayer.newest().createPlayer();
      player.style.width = w + 'px';
      player.style.height = h + 'px';
      document.body.appendChild(player);
      await new Promise((res) => { player.addEventListener('loadeddata', () => res(), { once: true }); setTimeout(res, 4000); player.ruffle().load(swfUrl); });
      await new Promise((r) => setTimeout(r, 150));
      const cv = (player.shadowRoot && player.shadowRoot.querySelector('canvas')) || player.querySelector('canvas');
      if (!cv) return [];
      const out = []; const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => { out.push(cv.toDataURL('image/png')); if (performance.now() - t0 < capMs) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      return out;
    }, { swfUrl: `/assets/winks/${id}/${id}.swf`, capMs, w: meta.w, h: meta.h });

    // Ne garder que les frames réellement peintes (alpha moyen ~255 ; le reste = buffer vidé)
    const kept = [];
    for (const du of dataUrls) {
      const buf = Buffer.from(du.split(',')[1], 'base64');
      const { data: px } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let sa = 0; for (let i = 3; i < px.length; i += 4) sa += px[i];
      if (sa / (px.length / 4) > 200) kept.push(buf);
    }
    const painted = kept.length;
    if (!painted) { console.warn(`${id}: aucune frame peinte capturée`); continue; }

    // Ré-échantillonner au nombre de frames d'origine
    const target = Math.max(1, Math.round(meta.duration * meta.fps));
    const step = kept.length / target;
    const picked = Array.from({ length: target }, (_, i) => kept[Math.min(kept.length - 1, Math.round(i * step))]);

    const dir = path.join(tmp, id); fs.mkdirSync(dir, { recursive: true });
    const files = picked.map((buf, i) => { const p = path.join(dir, `f${String(i).padStart(4, '0')}.png`); fs.writeFileSync(p, buf); return p; });

    const outWebp = path.join(winksDir, id, `${id}.webp`);
    const delay = Math.max(20, Math.round(1000 / meta.fps));
    execFileSync('img2webp', ['-loop', '0', '-d', String(delay), ...files, '-o', outWebp]);
    const sizeKb = (fs.statSync(outWebp).size / 1024).toFixed(0);
    console.log(`${id.padEnd(15)} peintes=${String(painted).padStart(3)} -> ${target} frames  ${meta.w}x${meta.h} @${meta.fps}fps  webp ${sizeKb} Ko`);
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
