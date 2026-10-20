// Génère les icônes Android depuis public/pwa-*.png : node scripts/gen_android_icons.cjs (racine du dépôt).
const sharp = require('sharp');
const res = 'android/app/src/main/res';
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  for (const [d, k] of Object.entries(dens)) {
    const legacy = Math.round(48 * k), fg = Math.round(108 * k);
    await sharp('public/pwa-512x512.png').resize(legacy, legacy).png().toFile(`${res}/mipmap-${d}/ic_launcher.png`);
    const circle = Buffer.from(`<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`);
    await sharp('public/pwa-maskable-512x512.png').resize(legacy, legacy).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(`${res}/mipmap-${d}/ic_launcher_round.png`);
    // Icône adaptative : la zone sûre d'une icône maskable (80 %) doit tenir dans les 72 dp visibles sur 108.
    const inner = Math.round(fg * 0.8);
    const img = await sharp('public/pwa-maskable-512x512.png').resize(inner, inner).png().toBuffer();
    await sharp({ create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: img, gravity: 'center' }]).png().toFile(`${res}/mipmap-${d}/ic_launcher_foreground.png`);
  }
})();
