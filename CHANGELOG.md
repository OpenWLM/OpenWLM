<p align="center">
  <b>English</b> • <a href="CHANGELOG.fr.md">Français</a>
</p>

# Changelog - OpenWLM

All notable changes to this project are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.4.0] - 2026-10-05

### 🔔 Notifications & PWA Web Push (Desktop & Mobile)
- **End-to-End VAPID Web Push Configuration (RFC 8291 / RFC 8292)**:
  - Standardized configuration parameters: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
  - Integrated `web-push` library with RFC 8291 payload encryption (`aes128gcm`) and RFC 8292 VAPID JWT signatures (`ES256`).
  - Strict startup validation: environment priority with automatic fallback to secure local file `.vapid_keys.json` (chmod `0600`, excluded from git); cleanly disables push without crashing if keys are missing.
  - Zero private key exposure: `VAPID_PRIVATE_KEY` is never exposed in API payloads, responses, or client bundles.
  - Health check endpoint `GET /api/push/status` clearly reports `available`, `hasVapid`, and `publicKey`.
  - Authenticated test route `POST /api/push/test` allows immediate test push dispatch to registered devices.
  - Automatic pruning of expired or unregistered subscriptions (`HTTP 404 / 410 Gone`) in SQLite `push_subscriptions`.
  - Added key generation utility `scripts/generate_vapid_keys.js` with safeguards against unintended key overwrites.
- **Android PWA & Background Support**:
  - Full background notification delivery via Service Worker (`push` and `notificationclick`).
  - Automatic chat window navigation and focus (`OPEN_CHAT`) on notification click.
  - Added compliant PWA maskable icons (`pwa-maskable-192x192.png` and `pwa-maskable-512x512.png`) with `#d5e9f8` solid background and 80% safe zone to eliminate white borders on Android.
- **Desktop Notifications & Retro WLM In-App Toasts**:
  - Smart arbitration: retro Aero in-app toast when active in foreground on PC, native OS notification when in background, zero notifications for own messages or actively focused conversations.
  - Guided permission activation workflow for Microsoft Edge and Windows PWAs handling quiet notification requests.

### 🔄 Real-Time Multi-Session Sync
- **Messages delivered to every active session of an account**:
  - Server-side multi-socket tracking (`userId → Set<socketId>`) replacing the former single-socket mapping, which overwrote the previous session on each new connection.
  - Per-user Socket.IO rooms (`user:<id>`) joined on handshake authentication and on `identify`.
  - New messages are delivered to **all** recipient sessions and to the sender's **other** sessions (no duplicate on the originating session).
  - Nudges, winks, private mode, WebRTC calls, games and status updates migrated to user rooms.
  - Offline status is only broadcast when the account's **last** session closes.
  - Client-side, messages synced from one of your own other sessions are filed under the correct conversation (the recipient's), with no sound, no notification and no replayed nudge/wink. E2EE unchanged (`keySender` already present).
  - Integration test `tests/test_multi_session_sync.js` (real server on an isolated database, 2 sessions × 2 accounts).

### 🗂️ Conversation Tabs
- **Drag-and-drop tab reordering**: horizontal dragging with a clear insertion indicator, order committed on drop, without affecting opening, closing, the active tab or new-message indicators (`src/utils/TabUtils.ts`, `tests/test_tabs_drag_and_drop.js`).

### 🔐 Secrets Provisioning
- Provisioning script `scripts/provision_vapid.sh` and documented `.env.example`; real keys are never written to a Git-tracked file.
- Secret scanner `scripts/check_secrets.js` (run by `npm test`) and an installable Git pre-commit hook via `scripts/install_git_hooks.sh`.

## [1.3.0] - 2026-10-03

### 🔒 Security & Client Persistence
- **Hardened Client Storage Architecture**:
  - Eliminated JWT tokens, raw RSA private keys, JWKs, encrypted key vaults, and cryptographic blobs from browser `localStorage` and `sessionStorage`.
  - Restricted `wlm_user` in `localStorage` strictly to an explicit whitelist of non-sensitive display fields: `{ id, username, nickname, avatar, scene, status, rememberMe }`.
  - Implemented proactive startup hygiene sweeps that scrub residual tokens, legacy private keys, and unauthorized storage keys left over from previous versions.
- **Hardware-Isolated E2EE Key Storage (`IndexedDB + Web Crypto`)**:
  - Implemented secure device vault `WLM_DeviceVault_v1` using native IndexedDB structured clones to persist private RSA keys as non-extractable `CryptoKey` objects (`extractable: false`).
  - Strengthened defense against direct key theft: private key material is not exportable through standard Web Crypto APIs (direct calls to `crypto.subtle.exportKey()` are rejected by browser engines), which significantly reduces exfiltration risk and helps contain sensitive material outside Web Storage.
- **Server-Side Session Hardening with `HttpOnly; SameSite=Strict` Cookies**:
  - Login endpoint (`/api/login`) automatically issues session tokens via secure `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h` cookies.
  - Transparent dual-fallback authentication across all Express endpoints and Socket.IO handshakes (`io.use`), accepting both cookie headers and in-memory authorization headers.
  - Instant session revocation and cookie purge on logout (`/api/logout`).
- **Resilient "Remember Keys on this Device" UX**:
  - Modernized mobile-friendly wording: *"Remember my E2EE keys on this device"* / *"Mémoriser mes clés E2EE sur cet appareil"*.
  - Non-blocking authentication design: if local persistence encounters an error (e.g. storage quota limits, private browsing sandbox), user login continues smoothly in memory with a friendly non-blocking notification toast.
  - *"Forget this device"* (`Oublier cet appareil`): cleanly removes cryptographic keys from IndexedDB, purges local markers, and transitions active session to memory-only without forced logout.
- **Discreet Retro Aero Indicator**:
  - Replaced bulky textual topbar badge with a minimalist 12px SVG padlock icon adjacent to the user status selector, with comprehensive hover tooltips preserving retro Aero aesthetics and mobile responsiveness.
- **Service Worker Cache Upgrade**:
  - Incremented cache to `openwlm-v4` to force immediate browser cache eviction and new bundle consumption.

## [1.2.1] - 2026-10-03

### 🎨 Visual & Assets
- **True Alpha Transparency for All Emoticons (PNG & APNG)**:
  - Eliminated white rectangular halos, opaque borders, and matte fringes around all emoticons when rendered on colored (Aero blue `#3B84D1`) or dark backgrounds.
  - Converted all 59 static emoticon assets from legacy 8-bit GIF89a to full 32-bit RGBA PNG files with anti-aliased alpha transparency and edge de-matting.
  - Converted all 10 animated emoticon assets (`cry_smile`, `wink_smile`, `party`, `Sleepy`, `thinking`, `eye-rolling`, `idk`, `Lightning`, `bat`, `cake`) to native Animated PNG (APNG) with 8-bit per-frame alpha transparency while strictly preserving authentic frame counts and millisecond animation timings.
  - Updated Add Contact modal placeholder from legacy hotmail to `pseudo@openwlm.dev`.
- **True Alpha Transparency for OpenWLM Butterfly Logo**:
  - Eliminated the opaque off-white rectangular bounding box around `openwlm_logo.png` visible on dark mode and colored backgrounds.
  - Implemented smooth perimeter BFS flood-fill and multi-pass orthogonal edge de-matting against the background, preserving 100% of the authentic butterfly colors, shapes, gloss reflections, and negative space between wings.

## [1.2.0] - 2026-10-03

### ✨ Features
- **Emoticons in User Nicknames & PSM**:
  - Authentic support for classic late-2000s emoticons inside user nicknames, display names, and personal status messages (PSM).
  - Comprehensive UI integration: profile editor, contact roster (online, offline, pending), chat tabs, conversation header, message sender titles, game invite banners, docked game pill, scoreboard cards, and WebRTC audio/video calls.
  - Safe, XSS-free React node parsing with zero HTML injection (`dangerouslySetInnerHTML` never used).
  - Fast-path regex optimization ensuring instant zero-allocation rendering for plain text names without emoticons.
  - Typographic `em`-based relative scaling (`1.2em`, max 16px, min 11px) with `-0.18em` vertical alignment strictly preserving line heights and retro Aero visual aesthetics.
  - Graceful text fallback for unrecognized codes and responsive ellipsis truncation for narrow mobile screens.

## [1.1.0] - 2026-10-02

### 🎮 Features
- **Puissance 4 (Connect Four) 1v1 Mini-Game**:
  - Full 7x6 board with authentic late-2000s Aero retro design (molded blue casing, glossy red and yellow discs).
  - Authoritative server-side validation: turn enforcement, gravity row calculation, column overflow rejection, win and draw detection.
  - Smooth gravity drop animations, winning 4-disc pulse glow, and hover column guides.
  - Native bilingual support (FR/EN) for turn announcements, banners, and tooltips.
  - Integrated in chat games menu, invite banners, docked pill, and bot test assistant (`/p4` or `/puissance4`).
  - Mobile responsive scaling with zero horizontal clipping.
  - Discrete inline player color indicator next to player nicknames.

## [1.0.0] - 2026-10-02

This major release consolidates the modern recreation of late-2000s instant messaging (Aero theme) with production-grade security hardening, a built-in test assistant contact ("OpenWLM"), and authoritative automated regression testing.

### 🚀 Features

- **System Assistant & Test Contact ("OpenWLM")**:
  - Dedicated virtual system contact (ID `-1`) enabling new users to immediately test the application without requiring a second account.
  - Polished central empty-state screen with interactive *"Start a test conversation"* button.
  - Discreet, collapsible *"Bot (1)"* section in the contact roster with a clean `BOT` badge.
  - Built-in test commands: Help (`aide`), Echo (`echo`), Emoticons (`emoticones`), Sounds (`sons`), Wizz/Nudge (`wizz`), Solo Tic-Tac-Toe (`morpion`).
  - 100% client-side isolation: zero network traffic, zero database writes, zero interference with real contacts.
- **End-to-End Encrypted (E2EE) Custom Emoticons**:
  - Custom shortcut management with Zero-Knowledge encryption (AES-256-GCM).
  - Support for static (PNG, WebP, JPEG) and animated (GIF) image formats.
  - Automatic dual rendering sizes (inline 19px and standard 50px).
- **Multiplayer Activities & Mini-Games**:
  - Classic Tic-Tac-Toe (Morpion) in real-time.
  - Real-time Checkers (Jeu de dames) with authoritative server validation.
  - Collapsible dock banner allowing users to minimize active games without leaving the chat.
- **E2EE File Transfer**:
  - Encrypted peer file sharing with automatic 4-hour time-to-live (TTL).
  - Instant on-the-fly image decryption with lightbox preview.
- **Authentic Late-2000s Aero Experience**:
  - Original retro sound effects (logon, message, wizz, call, nudge).
  - Full-screen animated winks, screen-shaking wizz effects.
  - Display nicknames, personal status messages (PSM), retro avatars, and scenes.
- **Full Bilingual Internationalization (EN / FR)**:
  - Reactive `I18nProvider` with seamless, live switching between English and French.
  - Comprehensive localization of authentication, contact roster, chat toolbar, top action bar, message headers, and classic options dialog.
  - Localized interactive mini-games (Checkers, Tic-Tac-Toe), voice clip player, WebRTC audio/video calls, and custom emoticons modal.
  - Zero visual clipping or layout degradation, strictly preserving the late-2000s Aero aesthetics.

---

### 🛡️ Security Hardening

#### Priority 1 — Strong Authentication & Access Control
- **Cryptographic JWT Secret**:
  - Deprecated static fallback secrets.
  - Automatic generation of a high-entropy 256-bit secret stored in `.jwt_secret` with strict file permissions (`0600`) and Git exclusion.
- **Centralized Authorization Helper `canInteract(senderId, targetId)`**:
  - Authoritative validation of mutual contact status and absence of blocks.
  - Enforced across all messages, wizz, winks, WebRTC calls, game invites, and file transfers.
- **Anti-Identity Spoofing**:
  - Immediate rejection when `socket.user.id !== senderId`.
  - Display nicknames (`senderNickname`) systematically recomputed from the SQL database (never trusting client-supplied strings).
- **Authoritative Off-The-Record (Private Mode)**:
  - Server-enforced non-persistence: if either user has enabled global private mode (`global_private = 1`), messages are never persisted to SQLite, overriding client parameters.

#### Priority 2 — Data Isolation & Session Revocation
- **File Transfer Hardening (`/api/files/upload`)**:
  - Compulsory `canInteract` check prior to accepting file uploads.
  - Strict **1 GB** storage quota per account with automatic deletion on threshold exceedance.
  - Dedicated rate limiter on uploads: maximum 5 uploads per minute per IP (HTTP 429).
  - 24-byte hexadecimal cryptographic access tokens with 4-hour expiration.
- **Instant JWT Session Revocation (`token_version`)**:
  - Database-backed `token_version` validated on every Express request and WebSocket handshake.
  - Instant invalidation upon password change.
  - Dedicated `POST /api/logout` endpoint and `manual_disconnect` event incrementing server-side version.
- **Strict Game Invite Validation (`game_accept`)**:
  - Prior active invitation required in memory with a 60-second TTL.
  - Single-use consumption upon acceptance to prevent unauthorized game session forging.
- **Custom Emoticon Cache Isolation (`CustomEmoticonsDB`)**:
  - Added `clearAll()` method purging local IndexedDB stores (AES keys and blobs) and revoking memory blob URLs upon logout.

#### Priority 3 — Defense in Depth
- **Anti-Timing Attack Protection**:
  - Constant-time password hash comparison using `crypto.timingSafeEqual` on PBKDF2 binary buffers during authentication (`/api/login`) and password updates (`/api/user/change-password`).
- **Memory Leak & RAM DoS Prevention**:
  - Automated garbage collection every 5 minutes purging expired captchas and inactive rate-limit tracking entries.

---

### 🔧 Bug Fixes

- Resolved browser caching issues with deleted custom emoticon shortcuts.
- Fixed file transfer message attribution displaying *"[Contact] sent you a file"* instead of *"[Contact] says"*.
- Fixed missing online notification sound trigger when a contact connects.
- Harmonized Content Security Policy (CSP) headers between direct production and Cloudflare Tunnel configurations.

---

### 🧪 Infrastructure & Testing

- **Authoritative Enforcement Test Suite (`tests/audit_security_enforcement.js`)**:
  - Automated headless test suite verifying that all frontend UI restrictions are strictly enforced server-side.
  - Integrated command: `npm test` / `npm run test:security`.
- **Demo Database Seeder (`scripts/seed-demo.js`)**:
  - Command `npm run db:seed` creating clean, fictitious local demonstration accounts (Alice & Bob) with zero personal data.
- **Safe Rollback Procedures**:
  - Standardized cold archive snapshot guidelines prior to sensitive migrations.
