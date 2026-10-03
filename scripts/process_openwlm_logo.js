import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGO_PATH = path.resolve(__dirname, '../public/assets/openwlm_logo.png');

async function processOpenWlmLogo() {
  console.log(`Processing OpenWLM logo at ${LOGO_PATH}...`);

  const { data, info } = await sharp(LOGO_PATH)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;
  const config = { bgTol: 24, fringeCut: 25, maxDelta: 100 };

  const out = Buffer.from(data);
  const visited = new Uint8Array(w * h);
  const queue = [];

  function isPureBg(x, y) {
    const idx = (y * w + x) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    return r >= 242 && g >= 242 && b >= 242 &&
           Math.abs(r - g) <= config.bgTol &&
           Math.abs(r - b) <= config.bgTol &&
           Math.abs(g - b) <= config.bgTol;
  }

  // Seed all perimeter pixels that match pure background
  for (let x = 0; x < w; x++) {
    if (isPureBg(x, 0) && !visited[x]) { visited[x] = 1; queue.push(x, 0); }
    if (isPureBg(x, h - 1) && !visited[(h - 1) * w + x]) { visited[(h - 1) * w + x] = 1; queue.push(x, h - 1); }
  }
  for (let y = 0; y < h; y++) {
    if (isPureBg(0, y) && !visited[y * w]) { visited[y * w] = 1; queue.push(0, y); }
    if (isPureBg(w - 1, y) && !visited[y * w + (w - 1)]) { visited[y * w + (w - 1)] = 1; queue.push(w - 1, y); }
  }

  // 1. BFS flood-fill exterior background
  let head = 0;
  while (head < queue.length) {
    const cx = queue[head++];
    const cy = queue[head++];
    const cidx = (cy * w + cx) * 4;
    out[cidx + 3] = 0; // Transparent

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const npos = ny * w + nx;
        if (!visited[npos] && isPureBg(nx, ny)) {
          visited[npos] = 1;
          queue.push(nx, ny);
        }
      }
    }
  }

  // 2. Multi-pass orthogonal de-matting to clean white fringe while preserving smooth antialiasing
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pos = y * w + x;
        if (visited[pos]) continue;

        let touchesBg = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && visited[ny * w + nx]) {
            touchesBg = true;
            break;
          }
        }

        if (touchesBg) {
          const idx = pos * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          const minC = Math.min(r, g, b);
          const delta = 252 - minC;

          if (delta <= config.fringeCut) {
            out[idx + 3] = 0;
            visited[pos] = 1;
          } else if (delta < config.maxDelta) {
            const alphaRatio = (delta - config.fringeCut) / (config.maxDelta - config.fringeCut);
            const alpha = Math.min(255, Math.max(0, Math.round(alphaRatio * 255)));
            out[idx + 3] = alpha;
            const a = alpha / 255;
            // Un-premultiply against off-white background (252, 252, 252)
            out[idx] = Math.min(255, Math.max(0, Math.round((r - 252 * (1 - a)) / a)));
            out[idx + 1] = Math.min(255, Math.max(0, Math.round((g - 252 * (1 - a)) / a)));
            out[idx + 2] = Math.min(255, Math.max(0, Math.round((b - 252 * (1 - a)) / a)));
          }
        }
      }
    }
  }

  // Backup original file if not already backed up
  const backupPath = `${LOGO_PATH}.orig_opaque`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(LOGO_PATH, backupPath);
    console.log(`Saved original opaque logo backup to ${backupPath}`);
  }

  // Overwrite openwlm_logo.png with true alpha transparent PNG
  await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(LOGO_PATH);

  const stats = fs.statSync(LOGO_PATH);
  console.log(`Successfully generated true alpha transparent logo at ${LOGO_PATH} (${stats.size} B)`);
}

processOpenWlmLogo().catch(err => {
  console.error('Error processing logo:', err);
  process.exit(1);
});
