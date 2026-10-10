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
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
// Capture aussi l'AUDIO : route la sortie Web Audio de Ruffle vers un MediaRecorder
await page.addInitScript(() => {
  const W = window;
  W.__audioChunks = [];
  W.__recStart = 0;
  const Orig = W.AudioContext || W.webkitAudioContext;
  if (!Orig) return;
  W.AudioContext = class extends Orig {
    constructor(...args) {
      super(...args);
      try {
        W.__recStart = performance.now();
        const msd = this.createMediaStreamDestination();
        Object.defineProperty(this, 'destination', { get() { return msd; } });
        const rec = new MediaRecorder(msd.stream);
        rec.ondataavailable = (e) => { if (e.data.size) W.__audioChunks.push(e.data); };
        rec.start();
        W.__rec = rec;
      } catch (e) { W.__audioErr = String(e); }
    }
  };
});
await page.goto(`http://127.0.0.1:${PORT}/`);

try {
  for (const id of ids) {
    const swf = path.join(winksDir, id, `${id}.swf`);
    const meta = swfMeta(swf);
    const capMs = Math.ceil(meta.duration * 1000) + 400;

    const captured = await page.evaluate(async ({ swfUrl, capMs, w, h }) => {
      const W = window;
      W.__audioChunks = [];
      document.querySelectorAll('ruffle-player').forEach((p) => p.remove());
      if (!W.RufflePlayer) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/ruffle/ruffle.js'; s.onload = () => res(); s.onerror = () => rej(new Error('ruffle')); document.head.appendChild(s); });
      }
      const player = W.RufflePlayer.newest().createPlayer();
      player.style.width = w + 'px';
      player.style.height = h + 'px';
      document.body.appendChild(player);
      await new Promise((res) => { player.addEventListener('loadeddata', () => res(), { once: true }); setTimeout(res, 4000); player.ruffle().load(swfUrl); });
      await new Promise((r) => setTimeout(r, 150));
      const cv = (player.shadowRoot && player.shadowRoot.querySelector('canvas')) || player.querySelector('canvas');
      const out = [];
      let recOff = 0;
      if (cv) {
        const t0 = performance.now();
        // Offset entre le début d'enregistrement audio et le début de capture des frames :
        // on le « sautera » à la lecture pour aligner exactement son et animation.
        recOff = W.__recStart ? Math.max(0, Math.round(t0 - W.__recStart)) : 0;
        await new Promise((resolve) => { const tick = () => { out.push(cv.toDataURL('image/png')); if (performance.now() - t0 < capMs) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
      }
      let audioB64 = '';
      try { if (W.__rec) W.__rec.stop(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
      try {
        const blob = new Blob(W.__audioChunks || [], { type: 'audio/webm' });
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        audioB64 = btoa(s);
      } catch { /* ignore */ }
      return { frames: out, audioB64, recOff };
    }, { swfUrl: `/assets/winks/${id}/${id}.swf`, capMs, w: meta.w, h: meta.h });

    const dataUrls = captured.frames;
    // Écrire l'audio capturé (synchronisé à l'anim, extrait de Ruffle)
    if (captured.audioB64) {
      fs.writeFileSync(path.join(winksDir, id, `${id}.webm`), Buffer.from(captured.audioB64, 'base64'));
    }

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

    // Détourage : le fond (fill uni de Ruffle, souvent blanc) est rendu transparent par
    // FLOOD-FILL depuis les bords → ne retire QUE le fond CONNECTÉ au bord, ce qui préserve
    // le blanc INTERNE du personnage (ex : les yeux de la grenouille).
    const TOL = 28;
    const keyedFrame = (data, W, H) => {
      const n = W * H;
      const bc = new Map();
      const badd = (i) => { const o = i * 4; const k = `${data[o]},${data[o + 1]},${data[o + 2]}`; bc.set(k, (bc.get(k) || 0) + 1); };
      for (let x = 0; x < W; x++) { badd(x); badd((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { badd(y * W); badd(y * W + W - 1); }
      const bg = [...bc.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      const match = (i) => { const o = i * 4; return Math.abs(data[o] - bg[0]) <= TOL && Math.abs(data[o + 1] - bg[1]) <= TOL && Math.abs(data[o + 2] - bg[2]) <= TOL; };
      const seen = new Uint8Array(n);
      const stack = [];
      for (let x = 0; x < W; x++) { stack.push(x); stack.push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { stack.push(y * W); stack.push(y * W + W - 1); }
      while (stack.length) {
        const i = stack.pop();
        if (seen[i]) continue; seen[i] = 1;
        if (!match(i)) continue;
        data[i * 4 + 3] = 0;
        const x = i % W, y = (i - x) / W;
        if (x > 0) stack.push(i - 1);
        if (x < W - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - W);
        if (y < H - 1) stack.push(i + W);
      }
      return bg;
    };

    // Détourer chaque frame puis encoder en WebP animé AVEC alpha
    const files = [];
    let bgHex = '';
    for (let i = 0; i < picked.length; i++) {
      const { data, info } = await sharp(picked[i]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const bg = keyedFrame(data, info.width, info.height);
      if (i === 0) bgHex = '#' + bg.map((v) => v.toString(16).padStart(2, '0')).join('');
      const p = path.join(dir, `f${String(i).padStart(4, '0')}.png`);
      await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(p);
      files.push(p);
    }

    const outWebp = path.join(winksDir, id, `${id}.webp`);
    const delay = Math.max(20, Math.round(1000 / meta.fps));
    // -loop 1 : lecture UNIQUE (pas de boucle infinie → l'anim ne repart pas avant la fermeture)
    execFileSync('img2webp', ['-loop', '1', '-lossy', '-q', '80', '-d', String(delay), ...files, '-o', outWebp]);
    const sizeKb = (fs.statSync(outWebp).size / 1024).toFixed(0);
    const audioKb = captured.audioB64 ? (Buffer.from(captured.audioB64, 'base64').length / 1024).toFixed(0) : '0';
    const totalMs = target * delay;
    console.log(`${id.padEnd(15)} peintes=${String(painted).padStart(3)} -> ${target} frames  ${meta.w}x${meta.h} @${meta.fps}fps  fond=${bgHex}  décal=${captured.recOff}ms  durée=${totalMs}ms  webp ${sizeKb} Ko  audio ${audioKb} Ko`);
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
