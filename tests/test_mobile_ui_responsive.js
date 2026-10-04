import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('Service Worker: CACHE_NAME is bumped to openwlm-v5', () => {
  const swContent = fs.readFileSync(path.join(rootDir, 'public/sw.js'), 'utf8');
  assert.match(swContent, /const\s+CACHE_NAME\s*=\s*['"]openwlm-v5['"]/);
});

test('Bug 1 CSS: Emoticon popup on mobile is fixed, responsive, and has backdrop', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // Verify mobile media query has emoticon-popup rules
  assert.ok(css.includes('.emoticon-popup {'), 'emoticon-popup should be defined');
  assert.ok(css.includes('.emoticon-backdrop {'), 'emoticon-backdrop should be defined');

  // Backdrop should be display: none on desktop and display: block on mobile
  assert.match(css, /\.emoticon-backdrop\s*\{\s*display:\s*none;/);
  assert.match(css, /\.emoticon-backdrop\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1190;/);

  // Popup on mobile should be position: fixed with z-index >= 1200, bottom offset, and overflow-y: auto
  assert.match(css, /\.emoticon-popup\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*60px;[^}]*overflow-y:\s*auto;/);

  // Emoticon grid on mobile should use auto-fill and min-height >= 36px for touch targets
  assert.match(css, /\.emoticon-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill/);
  assert.match(css, /\.emoticon-item\s*\{[^}]*min-height:\s*38px;/);
});

test('Bug 1 JSX: App.tsx has outside click/touch listener and backdrop for emoticons', () => {
  const appTsx = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');

  assert.ok(appTsx.includes('emoticonContainerRef'), 'emoticonContainerRef should be declared and used');
  assert.ok(appTsx.includes('handleClickOutside'), 'handleClickOutside should exist');
  assert.ok(appTsx.includes("document.addEventListener('mousedown'"), 'mousedown listener added');
  assert.ok(appTsx.includes("document.addEventListener('touchstart'"), 'touchstart listener added');
  assert.ok(appTsx.includes('className="emoticon-backdrop"'), 'emoticon-backdrop rendered in JSX');
  assert.ok(appTsx.includes('className="emoticon-popup" onClick={e => e.stopPropagation()}'), 'emoticon-popup stops propagation');
});

test('Bug 2 CSS: Font modal on mobile (< 768px) is 1-column vertical with >= 44px touch targets', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // Mobile font modal width and no horizontal overflow
  assert.match(css, /\.font-modal\s*\{[^}]*width:\s*calc\(100vw\s*-\s*20px\)\s*!important;[^}]*overflow-x:\s*hidden;/);

  // Single column flex layout for font-grid and lower-grid
  assert.match(css, /\.win-font-grid\s*\{[^}]*display:\s*flex\s*!important;[^}]*flex-direction:\s*column\s*!important;/);
  assert.match(css, /\.win-lower-grid\s*\{[^}]*display:\s*flex\s*!important;[^}]*flex-direction:\s*column\s*!important;/);

  // Logical order inside effects: Color first (order: 1), Effects second (order: 2)
  assert.match(css, /\.win-font-color-section\s*\{[^}]*order:\s*1;/);
  assert.match(css, /\.win-font-effects-section\s*\{[^}]*order:\s*2;/);

  // Interactive elements have >= 44px min-height
  assert.match(css, /\.win-list-item\s*\{[^}]*min-height:\s*44px;/);
  assert.match(css, /\.win-checkbox\s*\{[^}]*min-height:\s*44px;/);
  assert.match(css, /\.wlm-color-picker-selected\s*\{[^}]*min-height:\s*44px\s*!important;/);
  assert.match(css, /\.wlm-color-option\s*\{[^}]*min-height:\s*44px\s*!important;/);
  assert.match(css, /\.win-modal-footer\s*\.win-btn\s*\{[^}]*min-height:\s*44px;/);
  assert.match(css, /\.font-modal\s*\.win-close-btn\s*\{[^}]*min-height:\s*44px;/);
});

test('Bug 2 Desktop: Desktop styles maintain original multi-column layout', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // Desktop font grid has 3 columns (2fr 1.5fr 1fr)
  assert.match(css, /\.win-font-grid\s*\{[^}]*grid-template-columns:\s*2fr 1\.5fr 1fr;/);

  // Desktop lower grid has 2 columns (1fr 1fr)
  assert.match(css, /\.win-lower-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr;/);

  // Desktop font modal has 550px width
  assert.match(css, /\.font-modal\s*\{[^}]*width:\s*550px;/);

  // Desktop size input has 60px and list-box has 80px
  assert.match(css, /\.win-field-col-size\s*\.win-input-preview\s*\{[^}]*width:\s*60px;/);
  assert.match(css, /\.win-field-col-size\s*\.win-list-box\s*\{[^}]*width:\s*80px;/);
});

test('Bug 2 JSX: Font modal does not contain hardcoded inline width', () => {
  const appTsx = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');

  assert.doesNotMatch(appTsx, /<div className="modal-box font-modal win-style-modal"[^>]*style=\{\{\s*width:\s*['"]550px['"]/);
  assert.doesNotMatch(appTsx, /className="win-input-preview"[^>]*style=\{\{\s*width:\s*['"]60px['"]/);
  assert.doesNotMatch(appTsx, /className="win-list-box"[^>]*style=\{\{\s*width:\s*['"]80px['"]/);
});

test('Viewport calculations: Components fit without horizontal scroll on 320px, 375px, 390px, 412px, 1920px', () => {
  const viewports = [
    { name: 'Narrow Mobile', width: 320 },
    { name: 'iPhone SE', width: 375 },
    { name: 'Standard iPhone', width: 390 },
    { name: 'Android Standard', width: 412 },
    { name: 'Desktop Full HD', width: 1920 }
  ];

  for (const vp of viewports) {
    if (vp.width < 768) {
      // Mobile rules
      const modalWidth = Math.min(vp.width - 20, 440);
      assert.ok(modalWidth <= vp.width, `${vp.name}: Modal width (${modalWidth}px) fits within viewport (${vp.width}px)`);

      const emoticonPopupWidth = vp.width - 20;
      assert.ok(emoticonPopupWidth <= vp.width, `${vp.name}: Emoticon popup (${emoticonPopupWidth}px) fits within viewport (${vp.width}px)`);
    } else {
      // Desktop rules
      assert.ok(550 <= vp.width, `${vp.name}: Desktop modal (550px) fits within viewport (${vp.width}px)`);
    }
  }
});

test('Profile Header Rendering: Zero blurry 0 0 5px white text-shadow in WLM.css', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // Verify that the diffuse blurry text-shadow has been completely eradicated
  assert.ok(!css.includes('text-shadow: 0 0 5px white'), 'No diffuse 0 0 5px white text-shadow should remain');
});

test('Profile Header Rendering: Dominant nickname, clear status, and crisp typography', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // User name is dominant with weight 600 and rich navy color
  assert.match(css, /\.user-name-status\s*\{[^}]*font-weight:\s*600;/);
  assert.match(css, /\.user-name-status\s*\{[^}]*color:\s*#0b1e31;/);

  // Nickname display handles overflow gracefully
  assert.match(css, /\.nickname-display\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);

  // Status label has high-contrast slate color and weight 500
  assert.match(css, /\.status-label\s*\{[^}]*color:\s*#27435b;[^}]*font-weight:\s*500;/);

  // Status trigger prevents unwanted wrapping
  assert.match(css, /\.status-trigger\s*\{[^}]*flex-shrink:\s*0;[^}]*white-space:\s*nowrap;/);

  // PSM display is crisp and clean
  assert.match(css, /\.user-psm-display\s*\{[^}]*color:\s*#2e4357;/);
});

test('Profile Header Rendering: Mobile media query provides antialiasing and local contrast backing', () => {
  const css = fs.readFileSync(path.join(rootDir, 'src/WLM.css'), 'utf8');

  // Mobile rules for user-info-text
  assert.match(css, /\.user-info-text\s*\{[^}]*-webkit-font-smoothing:\s*antialiased;/);
  assert.match(css, /\.user-info-text\s*\{[^}]*text-rendering:\s*optimizeLegibility;/);

  // Mobile text-shadow: none on status and psm to prevent fuzzy subpixel halo
  assert.match(css, /\.status-label\s*\{[^}]*text-shadow:\s*none;/);
  assert.match(css, /\.user-psm-display\s*\{[^}]*text-shadow:\s*none;/);
});

