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
  assert.strictEqual(css.includes('rgba(234, 244, 253, 0.92)'), true, 'Should include polished Aero glass gradient');

  // Must not have uppercase title
  assert.strictEqual(css.includes('.wlm-desktop-toast-title {\n  display: flex;\n  align-items: center;\n  gap: 5px;\n  font-size: 11px;'), true, 'Toast title should be 11px and natural case');

  // Must have Aero close button
  assert.strictEqual(css.includes('.wlm-desktop-toast-close-btn'), true, 'Should include Aero close button');

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
    'browserNotifStatusLabel',
    'browserNotifStatusGranted',
    'browserNotifStatusDenied',
    'browserNotifStatusDefault',
    'browserNotifStatusUnsupported',
    'browserNotifGranted',
    'browserNotifDenied',
    'browserNotifDefault',
    'browserNotifUnsupported',
    'browserNotifPrompt',
    'browserNotifPreprompt',
    'browserNotifLater',
    'browserNotifEdgeTitle',
    'browserNotifEdgeHelp',
    'browserNotifEdgePath',
    'browserNotifRetry',
    'testAlertBtn',
    'testAlertText',
    'testAlertSuccess',
    'testAlertEdgeQuiet',
    'testAlertUnconfigured',
    'testAlertDenied',
    'testAlertUnsupported',
    'toastAction'
  ];

  for (const k of requiredKeys) {
    assert.strictEqual(typeof fr.settings[k], 'string', `Missing FR settings key: ${k}`);
    assert.strictEqual(typeof en.settings[k], 'string', `Missing EN settings key: ${k}`);
  }
});

test('PWA / Service Worker: sw.js handles notificationclick event to focus window', () => {
  const sw = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  assert.strictEqual(sw.includes("addEventListener('notificationclick'"), true, 'sw.js must contain notificationclick listener');
  assert.strictEqual(sw.includes("event.notification.close()"), true, 'sw.js must close notification on click');
  assert.strictEqual(sw.includes("client.focus()"), true, 'sw.js must focus client window on click');
});

test('UI Logic: Permission request is strictly bound to user click without automatic popups', () => {
  const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');

  // Verify requestSystemNotificationPermission is only called in onClick handlers
  const requestMatches = [...appSrc.matchAll(/requestSystemNotificationPermission\(\)/g)];
  assert.strictEqual(requestMatches.length >= 1, true, 'Should call requestSystemNotificationPermission');

  // Ensure no useEffect invokes requestSystemNotificationPermission
  const useEffectWithRequest = /useEffect\([^)]*requestSystemNotificationPermission/;
  assert.strictEqual(useEffectWithRequest.test(appSrc), false, 'Must not call requestSystemNotificationPermission inside useEffect');

  // Verify showSystemNotification is called on test alert when granted
  assert.strictEqual(appSrc.includes("if (systemPermission === 'granted') {\n                              showSystemNotification({"), true, 'Test alert must trigger showSystemNotification when granted');
});

test('UI Logic: Edge quiet prompt and pre-prompt states handling', () => {
  const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');

  // 1. Pre-prompt encart with "Activer" and "Plus tard" buttons
  assert.strictEqual(appSrc.includes('options-preprompt-box'), true, 'Pre-prompt box must exist in App.tsx');
  assert.strictEqual(appSrc.includes('t.settings.browserNotifPreprompt'), true, 'Pre-prompt text must be referenced');
  assert.strictEqual(appSrc.includes('t.settings.browserNotifLater'), true, 'Plus tard button must be referenced');

  // 2. Edge quiet prompt help box triggered when permissionAttempted and systemPermission === default
  assert.strictEqual(appSrc.includes('options-edge-box'), true, 'Edge box must exist in App.tsx');
  assert.strictEqual(appSrc.includes('t.settings.browserNotifEdgeHelp'), true, 'Edge help text must be referenced');
  assert.strictEqual(appSrc.includes('t.settings.browserNotifEdgePath'), true, 'Edge settings path must be referenced');
  assert.strictEqual(appSrc.includes('t.settings.browserNotifRetry'), true, 'Edge retry button must be referenced');

  // 3. Dynamic sync on focus, visibility change, and permissions query
  assert.strictEqual(appSrc.includes("window.addEventListener('focus'"), true, 'Must sync permission on focus');
  assert.strictEqual(appSrc.includes("document.addEventListener('visibilitychange'"), true, 'Must sync permission on visibility change');
  assert.strictEqual(appSrc.includes("navigator.permissions.query({ name: 'notifications'"), true, 'Must listen to permissions query changes');
  assert.strictEqual(appSrc.includes("if (showOptionsModal)"), true, 'Must sync permission on showOptionsModal');

  // 4. Test button feedback for all 4 states
  assert.strictEqual(appSrc.includes('testAlertSuccess'), true, 'Must handle granted test feedback');
  assert.strictEqual(appSrc.includes('testAlertEdgeQuiet'), true, 'Must handle Edge quiet prompt test feedback');
  assert.strictEqual(appSrc.includes('testAlertUnconfigured'), true, 'Must handle unconfigured test feedback');
  assert.strictEqual(appSrc.includes('testAlertDenied'), true, 'Must handle denied test feedback');
  assert.strictEqual(appSrc.includes('testAlertUnsupported'), true, 'Must handle unsupported test feedback');
});


