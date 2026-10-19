<p align="center">
  <b>English</b> • <a href="CHANGELOG.fr.md">Français</a>
</p>

# Changelog - OpenWLM

All notable changes to this project are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### New
- **Formatting** of nicknames, personal messages and messages: bold, italic, underline, strikethrough, 16 classic colors or any `#RRGGBB`, background colors, text and background gradients (`[c=4]red[/c]`, `[c=4]gradient[/c=12]`, `·$4` short codes). 🎨 button next to the conversation input and the nickname / personal message fields (with preview). Rendered by React without any injected HTML; tags are removed wherever they cannot be shown (notifications, titles, tooltips). Option to show everything as plain text (Options → Messages). Nicknames and personal messages keep their limits of 50 and 150 **visible** characters (checked by the server too).
- **`/` commands** in conversations: `/me`, `/clear`, `/online`, `/busy`, `/away`, `/offline`, `/nick`, `/psm`, `/all`, `/signout`, `/help`, with a suggestion list (Tab to complete); `//` sends a message starting with `/`.
- **Quick texts** (Options → Messages): `/shortcut` sends a ready-made message, `(!N)` is replaced by the contact's name. Saved on the device.
- **Recall your messages** with Ctrl+↑ / Ctrl+↓.
- **Search a conversation** with Ctrl+F (highlighted matches, counter, previous / next).
- **Help window**: main menu → Help, **Help** link on the sign-in screen, `/help`. Documentation: [docs/FORMATTING_AND_COMMANDS.md](docs/FORMATTING_AND_COMMANDS.md).

### Fixes
- An input field emptied with Ctrl+A then Delete kept an invisible line break, which was added at the start of the next message.
- **Mobile**: the 🎨 color panel of the conversation was cut off by the toolbar (only its edge showed behind the input field); it is now shown above the whole page. In the help window, the left menu can be folded (☰ button, folded automatically after choosing a topic) to leave the whole width to the text, and wide tables scroll.
- **Right-click on the "OpenWLM" test contact** now opens its menu: send a message, clear the history (on the device only), hide the test contact (shown again from Options → Layout). Delete and Block, meaningless for this virtual contact, are not offered.

### Cleanup
- Removed unused resources.
- **Fix**: the test contact's scene pointed to a file that never existed (`0002.png` instead of `0002.jpg`).

### Tests
- **New E2E tests for file transfer and voice messages** (`e2e/files-voice.spec.ts`), which had no end-to-end test so far (their end-to-end encryption was already in place). File: sent by A, stored encrypted on the server (the plaintext does not appear in the stored file), downloaded by B with exactly the same content. Voice message: recorded with Chromium's fake microphone, received by B, encrypted in the server history (no audio in clear), and actually played (timer moving).

## [1.6.2] - 2026-10-19

### Fixes
- **Demo accounts (`npm run db:seed`) could not sign in**: the script stored a hash of SHA-256(password), while the app sends a key derived with PBKDF2-SHA256 (600,000 iterations) then HKDF. It now reproduces the app's derivation and the server's storage, uses the server's real schema (`server/db.js`) and no longer inserts a plaintext welcome message (the app only displays signed, encrypted messages). The E2E server now runs the script and `e2e/auth.spec.ts` signs in with the demo account through the interface.
- **Password change with a session revoked meanwhile**: a 401 `session_revoked` was shown as "Current password is incorrect"; the app now goes back to the sign-in screen.
- The password window's automatic close timer is cancelled if the window disappears first.
- Docs: a revoked device deletes its remembered keys and session data; the encrypted local copy is kept (unreadable until the next sign-in), so that a password change or a sign-out on another of your devices does not wipe your private messages.

### Translation (English interface)
- **No more French in the English interface**: 39 browser alerts and 1 confirmation, the system lines in conversations (private mode, nudges, winks), the test contact "OpenWLM" (welcome, echo, help, solo games, its personal message), notification previews ("[File]", "[Voice message]", "[Wink]"), conversation background names, the push test result and the default personal message ("Disponible" is now empty, showing the translated "Enter your personal message") were hard-coded in French. They now go through the translation files (new `notices` and `errors` groups).
- **System lines flagged with `system`** instead of the sender name "Système", which showed up in French in the English interface.
- **Server errors translated**: sign-in, sign-up and invitation errors now carry a code (`invalid_credentials`, `username_taken`, `captcha_wrong`, `invite_self`…) translated by the app; a 429 shows "Too many attempts". Other server errors are still written in French by the server: the French interface shows them as is, the English interface shows its own translated message.
- E2E test `e2e/i18n-en.spec.ts` (English interface: wrong password, test contact, invitation error, private-mode and nudge lines on both sides).

### Main menu and Options window
- **Language**: chosen only in Options → Personal (removed from the contact-list menu).
- **Sessions in the menu**: "Sign out" becomes **Sign out everywhere**, followed by **Sign out my other devices** (with a confirmation; same action as in Options → Security, renamed there too). "Forget this device" becomes **Remove my keys from this device**, which says what it does.
- **Options window**: no more OK / Cancel / Apply, since every setting is saved as soon as it changes; the nickname and personal message are saved when leaving the field (or Enter) and when closing. Closes with ✕, Escape or a click outside. Aero look (gradient title bar, rounded corners, blue tab column) like the other dialogs, with a "Changes are saved automatically" note.
- E2E test: no language in the menu, sign out my other devices from the menu, nickname saved on close, personal message saved when leaving the field.
- **Resizable contact list (computer)**: drag the right edge of the contact list to widen it (260 to 640 px, always leaving at least 420 px to the conversation); the width is remembered on the device (`wlm_prefs`), double-click goes back to the original size, ←/→ keys also work on the focused handle. Not on mobile, where the list takes the whole screen. E2E test.

### Aero dialogs instead of browser pop-ups
- **No more browser pop-ups**: the 41 `alert()` and 2 `window.confirm()` (remove a contact, delete a custom emoticon) are replaced with small Aero windows like the rest of the app (`notify()` / `askConfirm()` in `src/utils/dialogs.ts`, shown by `<DialogHost />` mounted once at the root, so they also work on the sign-in screen). Messages are queued and shown one at a time; Enter confirms, Escape closes or cancels; errors use a ⚠️ icon, destructive confirmations a red button.
- **Sign-up success** is now shown in the form (green message) instead of a pop-up, since you go straight on to signing in.
- E2E: the English-interface test reads the Aero windows, checks the confirmation (Cancel, Escape, Delete) and fails if any native browser pop-up opens.

### Fixes
- **Conversation tabs**: the normal arrow cursor is back on the tabs (they showed an open hand since tabs became draggable); the closed hand only appears while moving a tab, the ✕ keeps its pointer.

## [1.6.1] - 2026-10-19

### Fixes (review of 1.6.0)
- **Private messages received while a conversation loads**: a private message received (or sent) between reading the local copy and the server's answer could be missing from the rewritten copy, and lost at the next reload. Local-only messages saved since the last full rewrite are now kept aside and included in the next one.
- **Local copy deletion**: records are deleted from the list of their keys read first (`getAllKeys`) instead of while iterating an index cursor (account deletion and conversation rewrite).
- **Push after "Sign out my other sessions"**: if this device's push subscription could not be read in time, it was deleted with the others; the app now registers it again afterwards (only when notifications are already allowed).
- **No stale token after a revocation**: after "Sign out my other sessions" or a password change, any token kept in memory is dropped so only the renewed cookie is used (the server does not expose a token to the page today; this prevents a device from revoking itself if that ever changes).
- **`diag_ping` rate-limited** (20 per 10 s per connection), like the other real-time events. Server test added.

## [1.6.0] - 2026-10-18

Calls that reach a sleeping phone and keep going with the screen off, the Options window completed (Layout, Messages, Sounds, Security, Connection), unread indicators, private messages kept across reloads, Minesweeper Flags, and a series of fixes from two code reviews.

**Highlights**
- **Calls**: "ringing" only once a device of the contact confirms; a sleeping phone is woken by a call notification (Answer / Decline) in the app's language; calls keep going with the screen off on Android; screen kept on during video; sound fixed in audio calls.
- **Options**: Layout, Messages and Sounds settings per device; a Security tab (blocked contacts, sign out my other sessions, redesigned password change — which had been broken since 1.4.0…); a Connection tab with a diagnostic and a copyable report.
- **Messages**: unread tab, badge and page title; private messages no longer lost and kept in the encrypted local copy.
- **Presence**: optional whole-computer inactivity (Idle Detection), status restored on restart, contact sign-in notification.
- **Games**: Minesweeper Flags (two-player Minesweeper, mines kept server-side) and sounds for every game.

### Upgrading from 1.5.x
- No database migration, no new environment variable.
- Two new HTTP routes: `POST /api/calls/decline` and `POST /api/sessions/revoke-others`. If you use the Cloudflare WAF rules, re-import `docs/cloudflare-waf.generated.json` (or add both routes), otherwise Cloudflare blocks them.
- New service worker (cache `openwlm-v7`): users must reload the app (on mobile, fully close the installed app) to get the new call notifications.
- Server tests now require a server started with `NODE_ENV=test` from the repository root (see README).

### Calls
- **"Ringing" only when the callee's device confirms**: the server used to tell the caller "ringing" right after forwarding the call, even when the callee's phone was asleep with a stale connection. The call is now delivered with an acknowledgement (4 s); "ringing" is shown only once a device confirms. Otherwise the caller sees "X doesn't seem reachable on their devices" (`call_waking`).
- **Wake-up by call push**: with no acknowledgement (or no connection but a push subscription), the server sends a high-urgency call push notification (TTL 45 s). The service worker shows it with Answer / Decline and re-shows it every 4 s for up to 30 s (system sound and vibration) to mimic a ringtone. Decline calls the new `POST /api/calls/decline` without opening the app; Answer opens the conversation.
- **Call handed over to the device that wakes up**: the pending call (encrypted offer kept for 60 s) is presented to any device of the callee that connects, or that comes back to the foreground without having been disconnected (suspended page whose connection survived: the app sends `call_resync`). That device then rings for real, and the app closes the ringing notification.
- **End of the call notification**: "Missed call" when the caller hangs up, "Answered on another device" / "Declined" when the call is taken or declined elsewhere (nothing shown on the device where the app is open), and "Missed call" on its own when the call expires without an answer (it used to stay displayed).
- **One incoming call at a time**: a second caller gets "busy" while a call is already ringing for the contact.
- **Notifications in the app's language**: the server does not know the app's language (a per-device setting). It sends a key with a French fallback text; the page stores its language in the `openwlm-prefs` cache and the service worker shows the texts, Answer / Decline included, in that language.
- **Calls keep going with the screen off (Android)**: Chromium (Chrome, Brave…) suspended the page a few seconds after the screen turned off, and the call went silent. Like YouTube, the app now plays a near-silent looping track during the call and shows "Conversation audio with X" in the media notification, which keeps the page alive. The notification's pause button is ignored. Not on iPhone (iOS mutes the microphone of web pages when locked).
- **Screen kept on during video**: while video is flowing (my camera, my screen share or the contact's video), the app asks the system to keep the screen on (Screen Wake Lock API), re-requested when returning to the app and released as soon as the video stops. Audio-only calls let the screen turn off.
- **No sound in audio calls (fixed)**: since audio calls reserve a video channel (to turn on the camera later), the remote sound was played by the same `<video>` element as that empty video track. Chrome and Safari (on mobile especially) do not start playback until a first video frame arrives, so the call stayed silent until someone turned on a camera. The remote sound now plays through a dedicated `<audio>` element, independent from the video; speaker selection applies to it. If the browser blocks automatic playback, a "🔊 Turn on sound" button appears in the call window.
- **Limits**: the ringing uses the system notification sound (no looping ringtone on a sleeping phone without a native app); on iPhone, push only works for the app installed on the home screen (iOS 16.4+) and the repetition is unreliable.
- Tests: `tests/test_call_delivery.js` (ringing after acknowledgement, stale device, handover on reconnect and on return to foreground, decline route, hang-up during wake-up, unreachable callee, second caller busy); E2E: remote audio actually playing in an audio-only call on both sides, keep-alive and media notification with an Android user agent, screen kept on only while video flows.

### Messages
- **Unread indicator**: a conversation with unread messages has a blinking orange tab with a counter, its contact is shown in bold with a "✉ n" badge in the contact list, and the page title shows the total ("(2) OpenWLM"). Everything clears when the conversation is shown with the window in the foreground; a message received in the conversation you are looking at is never counted as unread. Blinking is disabled when the system asks for reduced motion.
- **Tab shown even with no conversation open**: a message received while no conversation was open created a tab that stayed invisible behind the welcome screen. The tab bar now stays visible above it.
- Note: the Aero toast only appears when the OpenWLM window has the focus on desktop; otherwise a system notification is used (if allowed), and on mobile the conversation opens directly.
- **Private messages no longer lost**: loading a conversation's history replaced the displayed list with the server history, so local-only messages vanished — a private message received in a tab that had just opened could disappear right away (the sound played, nothing showed), and private messages never survived a reload. History loading now merges the server history with what only exists on the device (private messages, system lines, messages being sent), in chronological order (`src/utils/historyMerge.ts`).
- **Private messages kept across reloads**: they are now part of the encrypted local copy (Options → Messages, on by default). They are still never stored by the server; without the local copy they are lost on reload, as the option says. Sent private messages keep their private flag once confirmed by the server.
- **Local copy written from what is displayed**: it was rebuilt from a list that might not yet include the messages just read from the copy (no render in between), so private messages could disappear from it at the next reload. It is now written from the same merged list as the display.
- **Local copy deleted for this account only, after confirmation**: unchecking the option or "Delete the local copy" emptied the copy of every account used in the browser, immediately. Only this account's copy is now deleted, after a confirmation inside the tab (private messages only exist there).
- Tests: E2E `e2e/unread.spec.ts`, `e2e/private-history.spec.ts` (message received with the tab closed, reload, never stored by the server, option off with confirmation).

### Options
- **Layout, Messages, Sounds**: these tabs, empty and not clickable until now, work. Settings are stored on the device (`wlm_prefs`), not on the server.
  - **Layout**: show/hide offline contacts (blocked contacts always remain visible), personal messages and the "OpenWLM" test contact; sort by status then name, or by name.
  - **Messages**: emoticons as pictures or text; message times; window shake on a received nudge (otherwise a plain line); automatic playback of received winks (otherwise a "Watch" button in the conversation); encrypted local copy of conversations and a "Delete the local copy" button.
  - **Sounds**: master switch, volume with a Test button (it plays even if its category is off or the status is Busy), per-event switches (message, contact sign-in, nudge, wink, call ringtone, games) and "mute while Busy" (the ringtone stays on). Every sound in the app goes through these rules: SoundManager, game sounds, call ringtone, wink audio.
- **Security**: groups what was scattered across the main menu and the right-click menu — change password, the keys remembered on this device ("Forget this device"), global private mode, my safety number, "Reset my keys" — and adds a **list of blocked contacts** with an Unblock button. The main-menu entries stay where they were.
- **Sign out my other sessions** (Security tab): new `POST /api/sessions/revoke-others` (signed in, rate-limited to 10 per 15 min per account). Same mechanism as a password change: the account's session counter goes up, which invalidates every open session, and this device immediately gets a new valid cookie. The other devices' real-time connections receive `session_revoked` and are closed; their push subscriptions are deleted (a lost phone no longer gets notifications), except this device's. Confirmation inside the tab, no password asked. Signing out on one device still signs out all of them.
- **Revoked devices go back to the sign-in screen**: a device whose session had been revoked (password change, sign-out on another device) stayed on a dead screen. The server now returns a `session_revoked` code (HTTP 401 and real-time connection error); the app checks its session: still valid (another tab of the same browser, whose cookie was just renewed) → it reconnects; revoked → local sign-out (remembered keys and session data deleted; the encrypted local copy of conversations is kept but stays unreadable until the next sign-in with the password; without calling `/api/logout`, which would revoke the requesting device too), with an explanation on the sign-in screen.
- **Reset my keys** now deletes only this account's remembered keys and local copy; the other accounts used in the same browser keep theirs.
- **Change password (fixed and redesigned)**: changing the password had failed since 1.4.0 ("invalid key vault"): the app tried to re-encrypt the session's private key, which is non-extractable, and produced an empty vault. The key is now obtained by decrypting the vault with the current password (which also checks that password on the device). The window is redesigned in the Aero style with the current password, the new password with the same rules and strength meter as sign-up (12 characters minimum), a confirmation field, a check that the new password differs from the current one, and errors shown in the window instead of browser alerts. This device stays connected (its real-time connection is kept), the other devices go back to the sign-in screen.
- **Devices disconnected by the server return to the sign-in screen**: after a password change or a sign-out on another device, the server closes the other devices' real-time connections, and Socket.IO does not reconnect on its own in that case; those devices stayed on a dead screen. The app now checks its session whenever the server closes the connection (valid → reconnect, revoked → sign-in screen), with a second check 1.5 s later so that another tab of the same browser has time to receive a renewed cookie.
- **Connection (diagnostics)**: real-time connection (state, WebSocket or HTTP fallback, server response time, **Reconnect** button), notifications (browser permission, push configured on the server, push enabled on this device, service worker version), calls (on demand, a network test with the server's call settings, without calling anyone: TURN relay configured or not, and whether calls should work over the Internet) and browser (app version, HTTPS, local storage, idle detection, screen kept on, call kept alive with the screen off). **Copy report** gives a text to paste when asking for help, without secrets (no TURN credentials, push address or IP address). The response time goes through the existing real-time connection (`diag_ping`): no new HTTP route.
- The Options window can no longer be taller than the screen (the tab content scrolls, OK / Cancel stay visible), and its tab column is narrower on small screens. The "webcam" checkbox, never saved nor used, is removed.
- Code: `src/utils/appPrefs.ts`, `src/components/OptionsModal.tsx`, `src/components/ConnectionDiagnostics.tsx`. Tests: `tests/test_revoke_sessions.js`; E2E `e2e/options-prefs.spec.ts` (each setting checked for its real effect, blocked list, "phone" and "PC" with two tabs, diagnostic, key reset with another account's data on the device).

### Presence status
- **Whole-computer inactivity (Idle Detection API)**: new opt-in option *Detect inactivity of the whole computer*. Instead of activity inside the OpenWLM window, the automatic "Away" follows keyboard/mouse use in any application, and a locked screen switches to "Away" immediately; activity brings back "Available". A status chosen by hand is never changed.
  - Availability: Chromium-based desktop browsers (Chrome, Edge, Opera) and the Electron client; not Firefox or Safari. HTTPS required.
  - Permission: `idle-detection`, requested when the option is ticked; resumed automatically at startup if already granted. Refused or withdrawn — even during the session — → automatic fallback to in-window inactivity, explained in Options; detection resumes on its own if the permission is granted again.
  - Privacy: the page only gets *active/idle* and *locked/unlocked*; only the resulting status reaches the server. The server sends `Permissions-Policy: idle-detection=(self)`; the Electron client allows the `idle-detection` permission.
  - Fix found while testing: the detector was restarted on every profile update, and the restarted detector first reported "active", cancelling the "Away" it had just set.
  - Code: `src/utils/systemIdle.ts`, `src/hooks/useProfile.ts`; E2E test simulating idle, active, locked screen and a withdrawn then restored permission through the Chromium DevTools protocol.
- **Auto-away setting**: the inactivity delay field can be cleared and retyped (it used to snap to 1, giving "15" or "110"), is bounded to 1–120 minutes (a negative value used to switch to Away almost at once) and is disabled when the option is unchecked. Touch, wheel and scrolling inside the conversation or contact list count as activity (mobile). Activity tracking no longer re-renders the whole app on every mouse move.
- **Status restored on restart**: the status you picked by hand (menu or sign-in screen) is remembered on the device and restored when the app restarts. Inactivity auto-away is never remembered, so the app comes back "Available"; an intentional "Away", "Busy" or "Appear offline" is kept.
- **Server**: the client sends the wanted status in the socket handshake and the server applies it, instead of forcing "online" — "Appear offline" no longer shows you online to your contacts on reconnection. Profile updates (nickname, personal message, avatar, scene) no longer resend a stale status.
- **Second device**: a device without a stored preference no longer forces "Available" over the status chosen on another device still connected; it adopts the current status.
- **Shared computer**: the sign-in screen only preselects the remembered account's own status (no global "last status" inherited from another account), and sends it only if the selector was changed. The server's `status` field in the login response is no longer mistaken for a user choice.

### Notifications
- **Contact sign-in notification**: when a contact signs in, an Aero toast "<name> has just signed in" is shown (desktop, app in the foreground), or a system notification when the app is in the background and notifications are allowed — same rules as message notifications. Clicking it opens the conversation. Silent for 10 s after your own (re)connection, so a server restart does not trigger a burst. Only real sign-ins trigger it (`signedIn` flag): editing a nickname, personal message or avatar no longer does. The text follows a language change during the session.
- **Push notifications in the app's language**: message, nudge and push-test notifications follow the app's language, like the call notifications.

### Games
- **Minesweeper Flags (two-player Minesweeper)**: the MSN version where you have to FIND the mines. 16×16 board, 51 mines, first to 26 wins (no draw possible). A mine gives 1 point and you play again; a number or an empty area (flood fill) passes the turn. One 5×5 bomb per round, usable when at least 3 mines behind; you keep the turn if it finds a mine. Central mine counter, rounds score, Aero styling, available from the Games menu, invitations, docked bar and game resume.
- **Minesweeper Flags look**: the board mirrors the MSN original — sky-blue cloud tiles, golden revealed tiles with bold colored numbers, blue/red pennant flags, navy frame, BLUE and RED player panels (avatar, flag count, bomb button crossed out when unavailable, "It's your turn! Make a move."), star-framed mine counter, dashed outline of the last move in the player's color, and a RESIGN button. Drawn in CSS and inline SVG (no copied assets).
- **Anti-cheat**: the board is generated server-side (`crypto.randomInt`) and the mine positions never leave the server — clients only receive revealed cells, including on resync; remaining mines are shown only once the round is over.
- **Sounds**: dedicated Minesweeper sound effects synthesized with the Web Audio API (reveal, cascade, mine found, opponent's mine, bomb — no audio files). Tic-Tac-Toe, Connect Four and Checkers get their own move sounds (chalk mark, disc drop, wooden piece, capture) — their moves were silent, the requested sound file did not exist. All games share a win jingle, a short loss sound and a neutral draw sound, played once per round; message sounds are no longer used in games.
- **Robustness**: every move handler re-checks the contact relationship (a contact blocked or removed mid-game can no longer play) and is rate-limited (40 moves / 10 s per user); the Tic-Tac-Toe handler checks the game type. The Minesweeper board can no longer stay locked after a lost response; the armed bomb is cleared on turn change, new round and error; board rules come from the server state. Game panels no longer show a broken image for a contact without an avatar.
- **Toolbar**: the "Activities" button, which only opened a Checkers invitation, is removed (all games are in the Games menu).
- Tests: `tests/test_minesweeper_logic.js` (rules), `tests/test_minesweeper_server.js` (full game over sockets, no leak before the end), `e2e/minesweeper.spec.ts` (two browsers, synchronized boards, WebSocket frames inspected).

### Internal & tests
- **Tests can no longer write into a production database**: tests that talk to `localhost:3001` used that port even when it was the production server of the same machine, and their sign-ups created real accounts there. A server started with `NODE_ENV=test` now sends a fingerprint of its database (`X-OpenWLM-Test-Db`, test mode only); `scripts/live_server_guard.mjs` (loaded in every test file and by the preflight) stops the tests if the server on :3001 is not the test server of this checkout.
- Two server tests shared the same user id and could interfere when run in parallel; the logout / `manual_disconnect` test has its own id and a complete cleanup.
- E2E: random failures traced to the sign-up proof of work (random duration, sometimes beyond the specs' sign-up delay under load); the E2E server uses difficulty 10 instead of 17, the real difficulty stays covered by `tests/test_signup_guard.js`.
- The legacy `identify` socket event is removed (server handler, client emit and the dead `alwaysBroadcast` path): sessions are registered by the authenticated connection itself. Audio context resume errors are caught; Minesweeper timers are cleared on unmount.
- WAF rules regenerated (two new routes); `npm audit`: no known vulnerability.

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
