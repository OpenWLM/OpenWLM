<p align="center">
  <b>English</b> • <a href="CHANGELOG.fr.md">Français</a>
</p>

# Changelog - OpenWLM

All notable changes to this project are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Calls
- **No sound in audio calls (fixed)**: since audio calls reserve a video channel (to turn on the camera later), the remote sound was played by the same `<video>` element as that empty video track. Chrome and Safari (on mobile especially) do not start playback until a first video frame arrives, so the call stayed silent until someone turned on a camera. The remote sound now plays through a dedicated `<audio>` element, independent from the video; speaker selection applies to it. If the browser blocks automatic playback, a "🔊 Turn on sound" button appears in the call window.
- The E2E call test now checks that the remote audio is actually playing in an audio-only call, on both sides (on the previous code the media element stayed at `readyState 0`).

### Unread messages
- **Tab shown even with no conversation open**: a message received while no conversation was open created a tab that stayed invisible behind the welcome screen. The tab bar now stays visible above it.
- **Unread indicator**: a conversation with unread messages has a blinking orange tab with a counter, its contact is shown in bold with a "✉ n" badge in the contact list, and the page title shows the total ("(2) OpenWLM"). Everything clears when the conversation is shown with the window in the foreground; a message received in the conversation you are looking at is never counted as unread. Blinking is disabled when the system asks for reduced motion.
- Note: the Aero toast only appears when the OpenWLM window has the focus on desktop; otherwise a system notification is used (if allowed), and on mobile the conversation opens directly.
- E2E test `e2e/unread.spec.ts`.

### Private-mode messages
- **No longer lost**: loading a conversation's history replaced the displayed list with the server history, so local-only messages vanished — a private message received in a tab that had just opened could disappear right away (the sound played, nothing showed), and private messages never survived a reload. History loading now merges the server history with what only exists on the device (private messages, system lines, messages being sent), in chronological order (`src/utils/historyMerge.ts`).
- **Kept across reloads**: private messages are now part of the encrypted local copy (Options → Messages, on by default) and are shown again after a reload. They are still never stored by the server; without the local copy they are lost on reload, as the option now says.
- Sent private messages keep their private flag once confirmed by the server.
- E2E test `e2e/private-history.spec.ts` (message received with the tab closed, reload, server never stores it, option off).

### Options: Layout, Messages, Sounds
- The **Layout**, **Messages** and **Sounds** tabs, which were empty and not clickable, now work. Settings are stored on the device (`wlm_prefs`), not on the server.
- **Layout**: show/hide offline contacts (blocked contacts always remain visible), personal messages and the "OpenWLM" test contact; sort by status then name, or by name.
- **Messages**: emoticons as pictures or text; message times; window shake on a received nudge (otherwise a plain line); automatic playback of received winks (otherwise a "Watch" button in the conversation); encrypted local copy of conversations (turning it off deletes it) and a "Delete the local copy" button.
- **Sounds**: master switch, volume (with a test button), per-event switches (message, contact sign-in, nudge, wink, call ringtone, games) and "mute while Busy" (the ringtone stays on). Every sound in the app now goes through these rules: SoundManager, game sounds, call ringtone, wink audio.
- Code: `src/utils/appPrefs.ts`; E2E test `e2e/options-prefs.spec.ts` (three accounts, each setting checked for its real effect).

### Fixes (code review of 2026-10-17)
- **Status on a second device**: a device without a stored preference no longer forces "Available" over the status chosen on another device still connected; it adopts the current status (and remembers it as its own preference). The socket handshake no longer imposes a status when the device has none.
- **Shared computer**: the sign-in screen no longer pre-selects a status inherited from another account (the global "last status" is gone); it only pre-selects the remembered account's own preference, and the choice is sent only if the selector was changed. The server's `status` field in the login response is no longer mistaken for a user choice.
- **False "has just signed in"**: the server now flags real sign-ins (`signedIn`, offline → visible) on presence broadcasts; editing a nickname, personal message or avatar no longer triggers the toast. The toast text follows a language change during the session.
- **Game moves**: every move handler (Tic-Tac-Toe, Checkers, Connect Four, Minesweeper) re-checks the contact relationship (a contact blocked or removed mid-game can no longer play) and is rate-limited (40 moves / 10 s per user).
- **Minesweeper client**: the board can no longer stay locked after a lost response (released after 5 s, on reconnect and on resync); the armed bomb is cleared on turn change, new round and error; a game error triggers a resync. Board rules (size, mines, target, bomb) come from the server state instead of duplicated constants. The bomb is documented as one per round (as on MSN), matching the behavior.
- **Sounds**: audio context resume errors are caught; Minesweeper timers are cleared on unmount.
- **Cleanup**: the legacy `identify` socket event is removed (server handler, client emit and the dead `alwaysBroadcast` path): sessions are registered by the authenticated connection itself.

### Games
- **Minesweeper Flags look**: the board now mirrors the MSN original — sky-blue cloud tiles, golden revealed tiles with bold colored numbers, blue/red pennant flags, navy frame, BLUE and RED player panels (avatar, flag count, bomb button crossed out when unavailable, "It's your turn! Make a move."), star-framed mine counter, dashed outline of the last move in the player's color, and a RESIGN button. Drawn in CSS and inline SVG (no copied assets).
- **Toolbar**: the "Activities" button, which only opened a Checkers invitation, is removed (all games are in the Games menu).
- **Game sounds**: Tic-Tac-Toe, Connect Four and Checkers get their own synthesized move sounds (chalk mark, disc drop, wooden piece, capture) — their moves were silent, the requested sound file did not exist. All games share a festive win jingle, a short loss sound and a neutral draw sound (Checkers had none), played once per round; message sounds are no longer used in games.
- **Minesweeper Flags (two-player Minesweeper)**: the MSN version where you have to FIND the mines. 16×16 board, 51 mines, first to 26 wins (no draw possible). A mine gives 1 point and you play again; a number or an empty area (flood fill) passes the turn. One 5×5 bomb per round, usable when at least 3 mines behind; you keep the turn if it finds a mine. Central mine counter, rounds score, dedicated sound effects synthesized with the Web Audio API (reveal, cascade, mine found, opponent's mine, bomb, win, loss — no audio files, distinct from messaging sounds), Aero styling, available from the Games menu, invitations, docked bar and game resume.
- **Anti-cheat**: the board is generated server-side (`crypto.randomInt`) and the mine positions never leave the server — clients only receive revealed cells, including on resync; remaining mines are shown only once the round is over.
- **Hardening**: the Tic-Tac-Toe move handler now checks the game type (it could be sent against another game). Game panels no longer show a broken image for a contact without an avatar.
- Tests: `tests/test_minesweeper_logic.js` (rules), `tests/test_minesweeper_server.js` (full game over sockets, no leak before the end), `e2e/minesweeper.spec.ts` (two browsers, synchronized boards, WebSocket frames inspected).

### Presence status
- **Options**: removed the "Let other users know I have a webcam" checkbox, which was never saved nor used.
- **Whole-computer inactivity (Idle Detection API)**: new opt-in option *Detect inactivity of the whole computer*. Instead of activity inside the OpenWLM window, the automatic "Away" follows keyboard/mouse use in any application, and a locked screen switches to "Away" immediately; activity brings back "Available". A status chosen by hand is never changed.
  - Availability: Chromium-based desktop browsers (Chrome, Edge, Opera) and the Electron client; not Firefox or Safari. HTTPS required.
  - Permission: `idle-detection`, requested when the option is ticked; resumed automatically at startup if already granted. Refused or withdrawn → automatic fallback to in-window inactivity, explained in Options.
  - Privacy: the page only gets *active/idle* and *locked/unlocked*; only the resulting status reaches the server.
  - Server sends `Permissions-Policy: idle-detection=(self)`; the Electron client allows the `idle-detection` permission.
  - Fix found while testing: the detector was restarted on every profile update, and the restarted detector first reported "active", cancelling the "Away" it had just set. The detection effects no longer depend on callback identity.
  - Code: `src/utils/systemIdle.ts`, `src/hooks/useProfile.ts`, `src/components/OptionsModal.tsx`; E2E test simulating idle, active and locked screen through the Chromium DevTools protocol.
- **Auto-away setting**: the inactivity delay field can be cleared and retyped (it used to snap to 1, giving "15" or "110"), is bounded to 1–120 minutes (a negative value used to switch to Away almost at once) and is disabled when the option is unchecked. Touch, wheel and scrolling inside the conversation or contact list now count as activity (mobile). Activity tracking no longer re-renders the whole app on every mouse move.
- **Status restored on restart**: the status you picked by hand (menu or sign-in screen) is remembered on the device and restored when the app restarts. Inactivity auto-away is never remembered, so the app comes back "Available"; an intentional "Away", "Busy" or "Appear offline" is kept. The sign-in screen preselects your last status.
- **Server**: on the first connection of an account, the client sends the wanted status in the socket handshake and the server applies it, instead of forcing "online" — "Appear offline" no longer shows you online to your contacts on reconnection.
- **Fix**: profile updates (nickname, personal message, avatar, scene) no longer resend a stale status, which could set you "offline" or flap your status right after signing in.

### Notifications
- **Contact sign-in notification**: when a contact signs in, an Aero toast "<name> has just signed in" is shown (desktop, app in the foreground), or a system notification when the app is in the background and notifications are allowed — same rules as message notifications. Clicking it opens the conversation. Silent for 10 s after your own (re)connection, so a server restart does not trigger a burst.

## [1.5.1] - 2026-10-16

### Message signatures
- **Unverifiable messages rejected before decryption**: when the sender's public key is unavailable, the message is now rejected right after the signature step, without using the private key (it was previously decrypted, checked, then rejected; its content was never exposed). Its unauthenticated `mid` is no longer returned, so a forged message cannot feed the replay protection. Visible behavior unchanged ("Message rejected" banner).

## [1.5.0] - 2026-10-16

### Interface
- **Version on the sign-in page**: "OpenWLM v1.5.0 · GitHub" footer, with a link to the repository. The version is read from `package.json` at build time (`__APP_VERSION__`).

### Private mode per conversation (server-side)
- **Persisted state**: new `conversation_privacy` table (one row per direction). `toggle_private_mode` writes only the authenticated user's own row (`socket.user.id`), never one named in the payload; the contact and the user's other sessions are notified (`private_mode_changed`, `private_mode_self_sync`).
- **Server decides**: `send_message` ignores the client's `isPrivate` flag and computes privacy from both users' global flag and both conversation rows; either side can impose privacy, nobody can remove the other's.
- **Resync**: `/api/contacts/:userId` returns `my_private` / `their_private`, so the state is correct after a reconnection without toggling again. The toggle is refused with an explanation when the contact has enabled it.

### Server hardening & anti-abuse
- **Bearer fallback**: an `Authorization: Bearer undefined` / `null` header is ignored and the `HttpOnly` cookie is used instead (fixes intermittent "invalid token" errors when sending a file or a custom emoticon).
- **Asynchronous hashing**: `crypto.pbkdf2` (libuv pool) instead of `pbkdf2Sync` — every login attempt blocked the whole event loop (~113 ms); PBKDF2 parameters are unchanged (existing hashes stay valid).
- **Constant-time login**: a full PBKDF2 is computed even for a non-existent account (anti account-enumeration).
- **Signup**: hashcash proof-of-work bound to the captcha and single-use (`POW_DIFFICULTY`, default 17) + per-IP cap on successful signups over a sliding 24 h (`SIGNUP_IP_DAILY_LIMIT`, default 10).
- **E2EE keys**: the password proof (`authKeyHex`) is now required for every key write, including the first install (prevents installing an attacker-controlled identity on a stolen session).
- **Calls**: `call_accept` / `call_reject` are honored only for an actually pending call (anti "busy" DoS).
- **Crash handling**: clean exit (code 1) on an unhandled error so a supervisor restarts it; exceptions inside Socket.IO handlers are confined to the event. A supervisor (systemd/pm2/Docker) is now mandatory in production — see `docs/DEPLOYMENT.md`.
- **`.env` loading fixed**: moved into a module imported first (`server/loadEnv.js`), so a `JWT_SECRET` (or `VAPID_*`) provided in `.env` is honored before modules initialize. Previously `.env` was loaded in the body of `index.js`, i.e. after `middleware/auth.js` evaluated (`SECRET = getJwtSecret()`), which then fell back to a generated `.jwt_secret`.
- Removed the unused `sqlite3` dependency (−18 packages).

### Calls (WebRTC) — reliability & end-to-end
- **Camera or screen share during an audio call**: audio calls reserve a video transceiver in the offer, so either side can turn on their camera or share their screen with `replaceTrack` (no renegotiation; fallback to renegotiation with an older peer). A camera opened mid-call is released when turned off. An encrypted `media-state` signal tells the peer when video starts or stops ("X turned their camera off").
- **Call setup fixes**: the "connected" state set when the peer's tracks arrive was overwritten by a later "connecting" (call stuck on "Connecting..."), and ICE candidates received before the answer were never applied on the caller side.
- **E2EE**: signaling (SDP/ICE) is encrypted with the existing E2EE (the server becomes a blind relay), and the DTLS fingerprint is signed (RSA-PSS) and verified on receipt (anti-MITM).
- **Network**: configurable ICE servers via `GET /api/rtc-config` (STUN/TURN — static or ephemeral TURN credentials); ICE restart on `disconnected`/`failed` and on socket reconnect; bounded bitrate budgets.
- **UI**: mic/camera on-off, timer, quality indicator, mic/camera/speaker pickers, fullscreen/PiP, screen sharing, responsive layout; looping ring and system notification on incoming call.
- **Non-blocking call window**: a call is no longer a full-viewport overlay that swallowed every click. It is a small window you can drag (clamped to the viewport), minimize/expand without unmounting the WebRTC streams, so the contact list and other conversations stay usable during the call (WLM 2009 style). Only the incoming-call accept/reject decision keeps the centered, dimmed modal; on mobile the window starts minimized (bar above the composer) and the ringing dialog keeps accept/reject fully visible (fixed a truncation caused by the video stage collapsing to zero height).
- **Dynamic adaptation** of bitrate/resolution (`getStats`) and *perfect negotiation*.

### Messaging
- **Catch-up after a disconnection**: open conversations resync incrementally on socket reconnect and when the app returns to the foreground; messages received while offline from a contact whose tab is closed reopen that tab (new `GET /api/conversations/pending`). Local-only messages (private mode, system lines) are kept.
- **Drafts per conversation**: unsent text stays with its tab instead of following you into every conversation.
- **History auto-load**: opening a tab only loads that tab (it used to reload every open tab and drop their local-only messages).
- **Rich input**: typed emoticons (`:)`, `:D`, `(L)`, custom) render as inline images while typing and push the text (no more overlap).
- **Rate limiting**: Wizz and Winks counters are now separate (independent 3/min and 7/min); cleanup window aligned with the handlers.
- **"Not sent" + Resend**: sending (text, file, voice) now waits for the server ack (15 s timeout). On refusal, timeout or disconnection the message is marked "⚠ Not sent" (reason as tooltip) with a Resend button instead of staying "pending" forever. Resending re-signs the message with the original `mid` and the current private-mode setting; the plaintext is kept in memory only.
- **Private mode + offline contact**: nothing is stored server-side, so the message is now explicitly refused (`RECIPIENT_OFFLINE_PRIVATE`) instead of being silently lost while the sender saw "sent". Normal messages are unchanged (stored, delivered on reconnection). Winks follow the same rule (an ack now drives the sender's feedback).
- **Voice clips**: encoded at 32 kbit/s with an automatic 90 s stop (system line), keeping the clip under the 1 MB socket frame limit; oversized payloads are marked "too large" without a resend button.
- **Remaining loss window (known limit)**: in private mode, presence is checked at send time; if the contact disconnects right after, the message can still be lost (no queue). Use normal mode for guaranteed delivery. See `docs/SECURITY_E2E.md`.
- **Idempotent resend (no duplicate)**: the 15 s ack timeout is client-side only, so a late ack means the message was actually accepted. The resend now reuses the original `mid` and the server deduplicates by `(sender_id, mid)` (partial unique index), answering "success" with the existing id without re-delivering or re-notifying — a resend no longer produces a second copy. Private mode has nothing to compare (not persisted); there, the recipient's replay protection (unique `mid`) drops any second live copy. See `docs/SECURITY_E2E.md`.

### Message signatures (authenticated E2EE)
- **Unsigned or unverifiable messages rejected**: only signed and verified messages are displayed. Legacy unsigned (v1) messages are rejected without being decrypted, and signed messages whose sender key is unavailable are rejected too (shown with the "Message rejected" banner). The "contacts who sign" anti-downgrade list is removed.
- Messages are now **signed (RSA-PSS)** in addition to being encrypted: the server can no longer forge a message "from" a contact. New v2 envelope (encrypt-then-sign): signature over a domain-separated canonical string (`openwlm-msg-v2`), `from`/`to`/`mid` duplicated inside the ciphertext (anti-stripping), verification before decryption, content-field allowlist.
- **Display**: valid signature = normal; legacy format / sender key unavailable = "⚠ unverified"; invalid signature or plaintext = "⛔ rejected". Replay protection by message id, anti-downgrade.
- **Calls**: the DTLS fingerprint signature is now mandatory (the cases previously tolerated now reject the signaling).

### Winks
- **Pre-render**: the trailing SWF loop (restart) is removed; audio re-aligned (recomputed offsets); added the missing `bow` thumbnail.

### Documentation
- Tone and formatting cleanup of the README, changelog and docs; docs updated for this release.
- New docs: `docs/SECURITY_E2E.md` (real E2E scope and limits), `docs/CALLS.md`, `docs/DEPLOYMENT.md`, `docs/CLOUDFLARE_WAF.md`.
- **WAF rule generator** (`npm run waf:gen` / `waf:check`) driven by route auditing, with a "don't open wide" self-check and a CI guard.

### Internal
- `src/App.tsx` split into components (`ChatWindow`, `ChatMessageLog`, `ChatToolbar`, `ChatTabsBar`, `ContactRoster`, modals) and hooks (`useMessageCrypto`, `useContacts`, `useGames`, `useCalls`, `useWinksAndNudge`, `useProfile`, `useNotifications`); no functional change.
- npm package renamed `openwlm`.
- Tests: isolated suites `tests/test_conversation_privacy.js` and `tests/test_pending_conversations.js`; Playwright E2E `e2e/calls.spec.ts` (two browsers, audio call → camera → screen share) and `e2e/messages.spec.ts`.

### Desktop client (Electron) renderer hardening
- **Renderer isolation**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` and `webSecurity: true` (previously `nodeIntegration: true` / `contextIsolation: false`, which let any injected or remotely loaded content execute arbitrary Node code on the host machine).
- Disabled `nodeIntegrationInWorker`, `allowRunningInsecureContent`, `experimentalFeatures` and `webviewTag`.
- External top-level navigation (`will-navigate`) and new windows (`window.open`, `target=_blank`) are blocked inside the app and delegated to the system browser instead.
- Session permissions restricted to the required `media` (WebRTC calls) and `notifications` (push); every other permission request is denied.

### Security & local contact verification (Safety Number / IndexedDB)
- **Public key fingerprint verification (Safety Number)**:
  - Deterministic canonical SHA-256 fingerprint computed from the contact's public key RSA components (`e`, `kty`, `n`).
  - Formatted into 8 blocks of 4 characters for out-of-band verification (e.g. `A1B2 C3D4 ...`).
  - Key change detection, with revocation of the verified status and an alert banner.
  - Aero SVG shield badge in the conversation header (green with `✓` if verified, red with `?` if unverified).
  - Aero dialog to inspect safety numbers and toggle the verification state.
- **Device vault storage in IndexedDB (`WLM_DeviceVault_v1`)**:
  - Local storage migrated from `localStorage['wlm_verified_contacts_v1']` to IndexedDB's `verified_contacts` object store.
  - Automatic, idempotent migration: the legacy key and flags are removed from `localStorage`.
  - Failure handling: legacy data is kept on store write errors, with a fallback if IndexedDB is disabled.

## [1.4.0] - 2026-10-05

### Notifications & PWA Web Push (desktop & mobile)
- **VAPID Web Push configuration (RFC 8291 / RFC 8292)**:
  - Configuration parameters: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
  - `web-push` library with RFC 8291 payload encryption (`aes128gcm`) and RFC 8292 VAPID JWT signatures (`ES256`).
  - Startup validation: environment first, with fallback to the local file `.vapid_keys.json` (chmod `0600`, excluded from git); push is disabled without crashing if keys are missing.
  - `VAPID_PRIVATE_KEY` is never exposed in API payloads, responses, or client bundles.
  - Health check endpoint `GET /api/push/status` reports `available`, `hasVapid`, and `publicKey`.
  - Authenticated test route `POST /api/push/test` sends a test push to registered devices.
  - Automatic pruning of expired or unregistered subscriptions (`HTTP 404 / 410 Gone`) in SQLite `push_subscriptions`.
  - Added key generation utility `scripts/generate_vapid_keys.js`, which refuses to overwrite existing keys unintentionally.
- **Android PWA & background support**:
  - Background notification delivery via Service Worker (`push` and `notificationclick`).
  - Clicking a notification opens and focuses the chat window (`OPEN_CHAT`).
  - Added PWA maskable icons (`pwa-maskable-192x192.png` and `pwa-maskable-512x512.png`) with a `#d5e9f8` solid background and 80% safe zone, to avoid white borders on Android.
- **Desktop notifications & in-app toasts**:
  - Arbitration: Aero in-app toast when the app is in the foreground on PC, native OS notification when in the background, no notification for your own messages or for the focused conversation.
  - Guided permission activation for Microsoft Edge and Windows PWAs, which handle notification requests quietly.

### Real-time multi-session sync
- **Messages delivered to every active session of an account**:
  - Server-side multi-socket tracking (`userId → Set<socketId>`) replacing the former single-socket mapping, which overwrote the previous session on each new connection.
  - Per-user Socket.IO rooms (`user:<id>`) joined on handshake authentication and on `identify`.
  - New messages are delivered to **all** recipient sessions and to the sender's other sessions (no duplicate on the originating session).
  - Nudges, winks, private mode, WebRTC calls, games and status updates migrated to user rooms.
  - Offline status is only broadcast when the account's last session closes.
  - Client-side, messages synced from one of your own other sessions are filed under the correct conversation (the recipient's), with no sound, no notification and no replayed nudge/wink. E2EE unchanged (`keySender` already present).
  - Integration test `tests/test_multi_session_sync.js` (real server on an isolated database, 2 sessions × 2 accounts).

### Conversation tabs
- **Drag-and-drop tab reordering**: horizontal dragging with an insertion indicator, order committed on drop, without affecting opening, closing, the active tab or new-message indicators (`src/utils/TabUtils.ts`, `tests/test_tabs_drag_and_drop.js`).

### Secrets provisioning
- Provisioning script `scripts/provision_vapid.sh` and documented `.env.example`; real keys are never written to a Git-tracked file.
- Secret scanner `scripts/check_secrets.js` (run by `npm test`) and an installable Git pre-commit hook via `scripts/install_git_hooks.sh`.

## [1.3.0] - 2026-10-03

### Security & client persistence
- **Client storage**:
  - JWT tokens, raw RSA private keys, JWKs, encrypted key vaults, and cryptographic blobs removed from browser `localStorage` and `sessionStorage`.
  - `wlm_user` in `localStorage` restricted to an explicit whitelist of non-sensitive display fields: `{ id, username, nickname, avatar, scene, status, rememberMe }`.
  - Startup cleanup that removes residual tokens, legacy private keys, and unauthorized storage keys left over from previous versions.
- **E2EE key storage (`IndexedDB + Web Crypto`)**:
  - Device vault `WLM_DeviceVault_v1` using IndexedDB structured clones to persist private RSA keys as non-extractable `CryptoKey` objects (`extractable: false`).
  - Private key material is not exportable through standard Web Crypto APIs (direct calls to `crypto.subtle.exportKey()` are rejected by browser engines), which significantly reduces exfiltration risk and helps contain sensitive material outside Web Storage.
- **Server-side sessions in `HttpOnly; SameSite=Strict` cookies**:
  - The login endpoint (`/api/login`) issues session tokens as `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h` cookies.
  - Authentication fallback across all Express endpoints and Socket.IO handshakes (`io.use`), accepting both cookie headers and in-memory authorization headers.
  - Session revocation and cookie purge on logout (`/api/logout`).
- **"Remember keys on this device"**:
  - New wording, shorter on mobile: *"Remember my E2EE keys on this device"* / *"Mémoriser mes clés E2EE sur cet appareil"*.
  - Non-blocking: if local persistence fails (e.g. storage quota, private browsing), login continues in memory and a toast explains it.
  - *"Forget this device"* (`Oublier cet appareil`): removes cryptographic keys from IndexedDB, purges local markers, and switches the active session to memory-only without logging out.
- **Padlock indicator**:
  - Replaced the textual topbar badge with a 12px SVG padlock icon next to the status selector, with hover tooltips; works on mobile.
- **Service Worker cache upgrade**:
  - Cache bumped to `openwlm-v4` to force browsers to evict the old cache and load the new bundle.

## [1.2.1] - 2026-10-03

### Visual & assets
- **Alpha transparency for all emoticons (PNG & APNG)**:
  - Removed the white rectangular halos, opaque borders, and matte fringes around emoticons on colored (Aero blue `#3B84D1`) or dark backgrounds.
  - Converted all 59 static emoticon assets from 8-bit GIF89a to 32-bit RGBA PNG files with anti-aliased alpha transparency and edge de-matting.
  - Converted all 10 animated emoticon assets (`cry_smile`, `wink_smile`, `party`, `Sleepy`, `thinking`, `eye-rolling`, `idk`, `Lightning`, `bat`, `cake`) to Animated PNG (APNG) with 8-bit per-frame alpha transparency, keeping the original frame counts and millisecond animation timings.
  - Updated the Add Contact modal placeholder from legacy hotmail to `pseudo@openwlm.dev`.
- **Alpha transparency for the OpenWLM butterfly logo**:
  - Removed the opaque off-white rectangular box around `openwlm_logo.png` visible on dark mode and colored backgrounds.
  - Perimeter BFS flood-fill and multi-pass orthogonal edge de-matting against the background, keeping the butterfly's original colors, shapes, gloss reflections, and the negative space between wings.

## [1.2.0] - 2026-10-03

### Features
- **Emoticons in user nicknames & PSM**:
  - Classic late-2000s emoticons supported inside user nicknames, display names, and personal status messages (PSM).
  - Rendered in the profile editor, contact roster (online, offline, pending), chat tabs, conversation header, message sender titles, game invite banners, docked game pill, scoreboard cards, and WebRTC audio/video calls.
  - Parsed into React nodes with no HTML injection (`dangerouslySetInnerHTML` never used).
  - Fast path for plain-text names without emoticons (regex check, no allocation).
  - `em`-based relative scaling (`1.2em`, max 16px, min 11px) with `-0.18em` vertical alignment, so line heights are unchanged.
  - Text fallback for unrecognized codes and ellipsis truncation on narrow mobile screens.

## [1.1.0] - 2026-10-02

### Features
- **Puissance 4 (Connect Four) 1v1 mini-game**:
  - 7x6 board in late-2000s Aero style (molded blue casing, glossy red and yellow discs).
  - Server-side validation: turn enforcement, gravity row calculation, column overflow rejection, win and draw detection.
  - Gravity drop animations, glow on the winning 4 discs, and hover column guides.
  - Bilingual (FR/EN) turn announcements, banners, and tooltips.
  - Available in the chat games menu, invite banners, docked pill, and the bot test assistant (`/p4` or `/puissance4`).
  - Scales on mobile without horizontal clipping.
  - Inline player color indicator next to player nicknames.

## [1.0.0] - 2026-10-02

This release consolidates the recreation of late-2000s instant messaging (Aero theme) with security hardening, a built-in test assistant contact ("OpenWLM"), and automated regression testing.

### Features

- **System assistant & test contact ("OpenWLM")**:
  - Virtual system contact (ID `-1`) so new users can test the application without a second account.
  - Central empty-state screen with a *"Start a test conversation"* button.
  - Collapsible *"Bot (1)"* section in the contact roster with a `BOT` badge.
  - Built-in test commands: Help (`aide`), Echo (`echo`), Emoticons (`emoticones`), Sounds (`sons`), Wizz/Nudge (`wizz`), Solo Tic-Tac-Toe (`morpion`).
  - Runs entirely client-side: no network traffic, no database writes, no interference with real contacts.
- **End-to-end encrypted (E2EE) custom emoticons**:
  - Custom shortcut management with Zero-Knowledge encryption (AES-256-GCM).
  - Static (PNG, WebP, JPEG) and animated (GIF) image formats.
  - Two rendering sizes generated automatically (inline 19px and standard 50px).
- **Multiplayer activities & mini-games**:
  - Tic-Tac-Toe (Morpion) in real time.
  - Real-time Checkers (Jeu de dames) with server-side validation.
  - Collapsible dock banner to minimize active games without leaving the chat.
- **E2EE file transfer**:
  - Encrypted file sharing between contacts with an automatic 4-hour time-to-live (TTL).
  - Images decrypted in the browser, with lightbox preview.
- **Late-2000s Aero look**:
  - Retro sound effects (logon, message, wizz, call, nudge).
  - Full-screen animated winks, screen-shaking wizz.
  - Display nicknames, personal status messages (PSM), retro avatars, and scenes.
- **Bilingual interface (EN / FR)**:
  - `I18nProvider` with live switching between English and French.
  - Localized authentication, contact roster, chat toolbar, top action bar, message headers, and options dialog.
  - Localized mini-games (Checkers, Tic-Tac-Toe), voice clip player, WebRTC audio/video calls, and custom emoticons modal.
  - No clipping or layout breakage in either language.

---

### Security hardening

#### Priority 1 — Authentication & access control
- **Cryptographic JWT secret**:
  - Static fallback secrets removed.
  - Automatic generation of a 256-bit secret stored in `.jwt_secret` with `0600` file permissions and excluded from Git.
- **Centralized authorization helper `canInteract(senderId, targetId)`**:
  - Server-side check of mutual contact status and absence of blocks.
  - Applied to messages, wizz, winks, WebRTC calls, game invites, and file transfers.
- **Anti identity spoofing**:
  - Immediate rejection when `socket.user.id !== senderId`.
  - Display nicknames (`senderNickname`) recomputed from the SQL database (client-supplied strings are never trusted).
- **Server-enforced Off-The-Record (private mode)**:
  - Non-persistence enforced server-side: if either user has enabled global private mode (`global_private = 1`), messages are never persisted to SQLite, regardless of client parameters.

#### Priority 2 — Data isolation & session revocation
- **File transfer hardening (`/api/files/upload`)**:
  - `canInteract` check before accepting file uploads.
  - **1 GB** storage quota per account with automatic deletion when exceeded.
  - Dedicated rate limiter on uploads: at most 5 uploads per minute per IP (HTTP 429).
  - 24-byte hexadecimal cryptographic access tokens with 4-hour expiration.
- **JWT session revocation (`token_version`)**:
  - Database-backed `token_version` validated on every Express request and WebSocket handshake.
  - Invalidated on password change.
  - `POST /api/logout` endpoint and `manual_disconnect` event incrementing the server-side version.
- **Game invite validation (`game_accept`)**:
  - Requires a prior active invitation in memory, with a 60-second TTL.
  - Single-use on acceptance, so a game session cannot be forged.
- **Custom emoticon cache isolation (`CustomEmoticonsDB`)**:
  - Added a `clearAll()` method that purges local IndexedDB stores (AES keys and blobs) and revokes in-memory blob URLs on logout.

#### Priority 3 — Defense in depth
- **Timing attack protection**:
  - Constant-time password hash comparison using `crypto.timingSafeEqual` on PBKDF2 binary buffers during authentication (`/api/login`) and password updates (`/api/user/change-password`).
- **Memory leak & RAM DoS prevention**:
  - Cleanup every 5 minutes of expired captchas and inactive rate-limit entries.

---

### Bug fixes

- Fixed browser caching of deleted custom emoticon shortcuts.
- Fixed file transfer message attribution displaying *"[Contact] sent you a file"* instead of *"[Contact] says"*.
- Fixed missing online notification sound when a contact connects.
- Aligned Content Security Policy (CSP) headers between direct production and Cloudflare Tunnel configurations.

---

### Infrastructure & testing

- **Automated security-test suite (`tests/audit_security_enforcement.js`)**:
  - Headless test suite issuing direct requests to check that the main client-side restrictions are also enforced server-side.
  - Command: `npm test` / `npm run test:security`.
- **Demo database seeder (`scripts/seed-demo.js`)**:
  - `npm run db:seed` creates fictitious local demonstration accounts (Alice & Bob) with no personal data.
- **Rollback procedures**:
  - Documented cold archive snapshot guidelines before sensitive migrations.
