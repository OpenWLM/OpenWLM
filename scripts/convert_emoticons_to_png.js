import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import UPNG from 'upng-js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMOTICONS_DIR = path.resolve(__dirname, '../public/assets/emoticons');

function processFrame(frameBuffer, w, h) {
  const out = Buffer.from(frameBuffer);
  const visited = new Uint8Array(w * h);
  const queue = [];

  function isBgPixel(x, y) {
    const idx = (y * w + x) * 4;
    const a = frameBuffer[idx + 3];
    if (a < 128) return true; // already transparent
    const r = frameBuffer[idx];
    const g = frameBuffer[idx + 1];
    const b = frameBuffer[idx + 2];
    // White or near-white background
    return r >= 240 && g >= 240 && b >= 240 && Math.abs(r - g) <= 15 && Math.abs(r - b) <= 15;
  }

  // Seed queue with all border pixels that are background
  for (let x = 0; x < w; x++) {
    if (isBgPixel(x, 0) && !visited[0 * w + x]) {
      visited[0 * w + x] = 1;
      queue.push(x, 0);
    }
    if (isBgPixel(x, h - 1) && !visited[(h - 1) * w + x]) {
      visited[(h - 1) * w + x] = 1;
      queue.push(x, h - 1);
    }
  }
  for (let y = 0; y < h; y++) {
    if (isBgPixel(0, y) && !visited[y * w + 0]) {
      visited[y * w + 0] = 1;
      queue.push(0, y);
    }
    if (isBgPixel(w - 1, y) && !visited[y * w + (w - 1)]) {
      visited[y * w + (w - 1)] = 1;
      queue.push(w - 1, y);
    }
  }

  // BFS flood-fill exterior background
  let head = 0;
  while (head < queue.length) {
    const cx = queue[head++];
    const cy = queue[head++];
    const cidx = (cy * w + cx) * 4;
    out[cidx] = 0;
    out[cidx + 1] = 0;
    out[cidx + 2] = 0;
    out[cidx + 3] = 0;

    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const npos = ny * w + nx;
        if (!visited[npos] && isBgPixel(nx, ny)) {
          visited[npos] = 1;
          queue.push(nx, ny);
        }
      }
    }
  }

  // 4-way orthogonal boundary de-matting for anti-aliasing edges
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pos = y * w + x;
      if (visited[pos]) continue;

      let touchesBg = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && visited[ny * w + nx]) {
          touchesBg = true;
          break;
        }
      }

      if (touchesBg) {
        const idx = pos * 4;
        const r = frameBuffer[idx];
        const g = frameBuffer[idx + 1];
        const b = frameBuffer[idx + 2];
        const minC = Math.min(r, g, b);
        const maxC = Math.max(r, g, b);

        if (minC >= 180 && (maxC - minC) <= 25) {
          const delta = 255 - minC;
          if (delta <= 12) {
            out[idx] = 0;
            out[idx + 1] = 0;
            out[idx + 2] = 0;
            out[idx + 3] = 0;
          } else {
            const alpha = Math.min(255, Math.max(0, Math.round((delta / 180) * 255)));
            out[idx + 3] = alpha;
            const a = alpha / 255;
            out[idx] = Math.min(255, Math.max(0, Math.round((r - 255 * (1 - a)) / a)));
            out[idx + 1] = Math.min(255, Math.max(0, Math.round((g - 255 * (1 - a)) / a)));
            out[idx + 2] = Math.min(255, Math.max(0, Math.round((b - 255 * (1 - a)) / a)));
          }
        }
      }
    }
  }

  return out;
}

async function convertEmoticon(filename) {
  const inPath = path.join(EMOTICONS_DIR, filename);
  const meta = await sharp(inPath, { animated: true }).metadata();
  const w = meta.width;
  const h = meta.pageHeight || meta.height;
  const pages = meta.pages || 1;
  const delays = meta.delay || Array(pages).fill(100);

  const processedFrames = [];
  for (let p = 0; p < pages; p++) {
    const rawFrame = await sharp(inPath, { page: p }).ensureAlpha().raw().toBuffer();
    const cleanFrame = processFrame(rawFrame, w, h);
    // Explicit slice of ArrayBuffer to match byteOffset and length
    const frameArrayBuffer = cleanFrame.buffer.slice(
      cleanFrame.byteOffset,
      cleanFrame.byteOffset + cleanFrame.byteLength
    );
    processedFrames.push(frameArrayBuffer);
  }

  const outName = filename.replace(/\.gif$/, '.png');
  const outPath = path.join(EMOTICONS_DIR, outName);

  if (pages > 1) {
    const apngBuf = Buffer.from(UPNG.encode(processedFrames, w, h, 0, delays));
    fs.writeFileSync(outPath, apngBuf);
    return { name: outName, pages, type: 'APNG', size: apngBuf.length };
  } else {
    const buf = Buffer.from(processedFrames[0]);
    await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
    const stat = fs.statSync(outPath);
    return { name: outName, pages: 1, type: 'PNG', size: stat.size };
  }
}

async function main() {
  const files = fs.readdirSync(EMOTICONS_DIR).filter(f => f.endsWith('.gif')).sort();
  console.log(`Found ${files.length} GIF emoticons to convert in ${EMOTICONS_DIR}`);

  const results = [];
  for (const file of files) {
    const res = await convertEmoticon(file);
    results.push(res);
    console.log(`[OK] ${file.padEnd(20)} -> ${res.name.padEnd(20)} (${res.type}, ${res.pages} frame(s), ${res.size} B)`);
  }

  console.log(`\nSuccessfully converted all ${results.length} emoticons.`);
}

main().catch(err => {
  console.error('Error during conversion:', err);
  process.exit(1);
});
