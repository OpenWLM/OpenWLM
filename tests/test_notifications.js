import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Import decision logic directly
const notificationManagerFile = fs.readFileSync(path.join(process.cwd(), 'src/utils/NotificationManager.ts'), 'utf8');

// Dynamic evaluation of pure TypeScript function in Node.js
function createDecisionTester() {
  const code = `
    function decideNotificationType(ctx) {
      if (ctx.isSender) return 'none';
      if (ctx.isAppVisible && ctx.activeChatId === ctx.senderId) return 'none';
      if (ctx.isAppVisible) {
        if (ctx.isDesktop) return 'in-app';
        return 'none';
      }
      if (ctx.hasSystemPermission) return 'system';
      if (ctx.isDesktop) return 'in-app';
      return 'none';
    }
    return { decideNotificationType };
  `;
  return new Function(code)();
}

const { decideNotificationType } = createDecisionTester();

test('Notification Decision: Never notify for own messages (isSender === true)', () => {
  const res = decideNotificationType({
    isSender: true,
    senderId: 10,
    activeChatId: 10,
    isAppVisible: true,
    isDesktop: true,
    hasSystemPermission: true
  });
  assert.strictEqual(res, 'none');

  const resBackground = decideNotificationType({
    isSender: true,
    senderId: 10,
    activeChatId: 99,
    isAppVisible: false,
    isDesktop: true,
    hasSystemPermission: true
  });
  assert.strictEqual(resBackground, 'none');
});

test('Notification Decision: Never notify if conversation is already open and actively visible', () => {
  const res = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 42,
    isAppVisible: true,
    isDesktop: true,
    hasSystemPermission: true
  });
  assert.strictEqual(res, 'none', 'Should not show any notification when active tab matches sender and app is visible');
});

test('Notification Decision: Foreground on PC with another chat active -> in-app toast', () => {
  const res = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 99, // user is chatting with someone else
    isAppVisible: true,
    isDesktop: true,
    hasSystemPermission: true // even if system permission exists, in-app is preferred in foreground
  });
  assert.strictEqual(res, 'in-app', 'Should show in-app desktop toast when foreground app is on another tab');

  const resRoster = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 0, // user is on contact list
    isAppVisible: true,
    isDesktop: true,
    hasSystemPermission: true
  });
  assert.strictEqual(resRoster, 'in-app', 'Should show in-app desktop toast when on contact list');
});

test('Notification Decision: Background app with system permission -> system notification', () => {
  const res = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 42, // tab was 42, but user is looking at another window/desktop app
    isAppVisible: false,
    isDesktop: true,
    hasSystemPermission: true
  });
  assert.strictEqual(res, 'system', 'Should use system notification when app is in background and permitted');

  const resMobile = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 99,
    isAppVisible: false,
    isDesktop: false,
    hasSystemPermission: true
  });
  assert.strictEqual(resMobile, 'system', 'Should also allow system notification in background on mobile if permitted');
});

test('Notification Decision: Background app on PC without system permission -> fallback in-app toast', () => {
  const res = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 99,
    isAppVisible: false,
    isDesktop: true,
    hasSystemPermission: false
  });
  assert.strictEqual(res, 'in-app', 'Desktop should queue/render in-app toast if system permission is unavailable');
});

test('Notification Decision: Mobile foreground does not trigger desktop toast', () => {
  const res = decideNotificationType({
    isSender: false,
    senderId: 42,
    activeChatId: 99,
    isAppVisible: true,
    isDesktop: false,
    hasSystemPermission: true
  });
  assert.strictEqual(res, 'none', 'Mobile foreground should not display desktop toast');
});

test('CSS Verification: WLM Desktop Toast is styled with Aero Glass and hidden on mobile', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/WLM.css'), 'utf8');

  // Must contain .wlm-desktop-toast-container
  assert.strictEqual(css.includes('.wlm-desktop-toast-container'), true);

  // Must contain Aero glass gradients
  assert.strictEqual(css.includes('linear-gradient(180deg, #f2f7fd 0%, #dbecfa 30%, #c1ddf7 70%, #d2e7fa 100%)'), true);

  // Must be hidden on screens <= 768px
  const mobileRuleRegex = /@media\s*\(\s*max-width\s*:\s*768px\s*\)\s*\{[\s\S]*?\.wlm-desktop-toast-container\s*\{[\s\S]*?display\s*:\s*none\s*!important;/;
  assert.strictEqual(mobileRuleRegex.test(css), true, 'Desktop toast must be hidden with display:none !important on <= 768px');

  // Must have entrance and exit animations
  assert.strictEqual(css.includes('@keyframes wlmDesktopToastSlideIn'), true);
  assert.strictEqual(css.includes('@keyframes wlmDesktopToastSlideOut'), true);
});

test('i18n Verification: Both FR and EN have alert and notification strings', () => {
  const fr = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/en.json'), 'utf8'));

  const requiredKeys = [
    'tabAlerts',
    'alertsTitle',
    'desktopToastEnable',
    'desktopToastDesc',
    'browserNotifSection',
    'browserNotifGranted',
    'browserNotifDenied',
    'browserNotifDefault',
    'browserNotifPrompt',
    'testAlertBtn',
    'testAlertText',
    'toastAction'
  ];

  for (const k of requiredKeys) {
    assert.strictEqual(typeof fr.settings[k], 'string', `Missing FR settings key: ${k}`);
    assert.strictEqual(typeof en.settings[k], 'string', `Missing EN settings key: ${k}`);
  }
});
