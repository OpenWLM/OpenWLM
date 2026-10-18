<p align="center">
  <img src="logo.png" alt="OpenWLM Logo" width="200" />
</p>

<p align="center">
  <b>English</b> • <a href="README.fr.md">Français</a>
</p>

# OpenWLM (Modern Web Stack)

An open-source recreation of a late-2000s instant messenger (Aero glass UI), with end-to-end encryption of message content and current web security practices. The actual E2E scope — what is protected, what is not, and the limits — is documented below.

**Disclaimer & Legal Notice**:  
OpenWLM is an independent educational, open-source project and a tribute to 2000s instant messaging software. It is not affiliated, associated, authorized, endorsed by, or in any way officially connected with any proprietary brand, software, or corporation.

> [!WARNING]
> **AI-Assisted Development Notice**:  
> This project was developed with the assistance of Artificial Intelligence (Google Antigravity / LLM-assisted pair programming). It is reviewed manually and covered by end-to-end tests plus an automated security-test suite (`npm run test:security`). This is **not** an independent third-party audit, so unexpected bugs, edge-case regressions, or design oversights may still remain. Peer reviews, community testing, and vulnerability reports are welcome.

---

## Key Features

### Communication
- **Interface**: recreation of a late-2000s instant messenger — Aero styling, tabs, background scenes, usertiles, sound effects.
- **Progressive Web App (PWA)**: installable as a standalone desktop or mobile app, with offline asset caching through a Service Worker, a web app manifest and an Aero taskbar icon.
- **Built-in test contact ("OpenWLM")**: virtual system contact (ID `-1`) with a quickstart button in the empty state, so new users can try chat, emoticons, sounds, Wizz/nudges, Tic-Tac-Toe and Connect Four (`/p4`) without a second account.
- **Messaging**: rich text, classic emoticons, and custom end-to-end encrypted emoticons.
- **Emoticons in names and status messages**: classic emoticons can be used in display names and personal status messages (PSM); they are rendered in the contact list, chat tabs, conversation headers and game scoreboards, using alpha-transparent PNG and APNG assets.
- **Audio & video calls (WebRTC)**: peer-to-peer voice and video calls with encrypted signaling; during an audio call, either side can turn on their camera or share their screen. The caller only sees "ringing" once a device of the contact has confirmed the call; a sleeping phone is woken by a call push notification (Answer / Decline), see [docs/CALLS.md](docs/CALLS.md).
- **Voice clips**: record and stream end-to-end encrypted audio messages.
- **Winks & nudges**: animated full-screen winks and the screen-shaking Wizz.
- **Presence**: Available, Busy, Away and Appear offline; the status you pick is restored when the app restarts; automatic "Away" after a configurable inactivity delay, optionally based on the inactivity of the whole computer (see [Automatic "Away" status](#automatic-away-status)).
- **1v1 mini-games**: real-time Tic-Tac-Toe (Morpion), Checkers (Jeu de dames), Connect Four (Puissance 4, 7x6 board) and Minesweeper Flags (find the mines: 16x16, 51 mines, first to 26, one 5x5 bomb per round), with server-side move validation against cheating — the mine positions never leave the server — and collapsible game panels.
- **Encrypted file transfer**: temporary file sharing between contacts (4-hour TTL), decrypted in the browser, with image previews in a lightbox.
- **English / French interface**: the language can be switched without reloading and is detected from the browser; both languages fit the Aero layout without overflow.

### Automatic "Away" status

Options → *Show status "Away" after N minutes of inactivity* (1 to 120 minutes, 5 by default, stored per device). Only an "Available" status is switched automatically; it comes back to "Available" as soon as you are active again. A status chosen by hand (Busy, Away, Appear offline) is never changed. Unchecking the option keeps you "Available" until you change your status yourself.

Two ways of measuring inactivity:

| Mode | What counts as activity | Where it works |
|---|---|---|
| **OpenWLM window** (default) | Mouse, keyboard, touch, wheel and scrolling inside OpenWLM | Every browser, PWA, mobile |
| **Whole computer** (opt-in: *Detect inactivity of the whole computer*) | Any keyboard or mouse use on the computer, in any application. A **locked screen** switches to "Away" right away | Chromium-based desktop browsers (Chrome, Edge, Opera) and the Electron client; **not** Firefox or Safari |

The whole-computer mode relies on the [Idle Detection API](https://developer.mozilla.org/docs/Web/API/Idle_Detection_API):

- **Permission**: the browser asks for the `idle-detection` permission when you tick the option. If it is refused, or later withdrawn in the site settings, OpenWLM falls back to the OpenWLM-window mode and the Options page says so.
- **Privacy**: the page only learns two states, *active / idle* and *screen locked / unlocked*. It never sees which application you use or what you type. Nothing is sent to the server except the resulting status (Away / Available), exactly like the default mode.
- **Requirements**: HTTPS (or `localhost`); the server sends `Permissions-Policy: idle-detection=(self)`. The API's minimum threshold is 1 minute, which matches the shortest delay of the option.
- **Code**: `src/utils/systemIdle.ts` (API access), `src/hooks/useProfile.ts` (both modes, never active at the same time).

### Options stored on the device

Options → **Layout**, **Messages** and **Sounds** are saved in the browser (`wlm_prefs`), per device, never on the server:

- **Layout**: show offline contacts (blocked contacts always stay visible, to unblock them), show personal messages, show the "OpenWLM" test contact, sort by status then name, or by name.
- **Messages**: emoticons as pictures or as text, message times, window shake on a received nudge (otherwise a simple line), automatic playback of received winks (otherwise a "Watch" button), encrypted copy of conversations on this device, private-mode messages included (they are never on the server, so without this copy they are lost when the app reloads; turning it off deletes the copy).
- **Sounds**: on/off, volume, one switch per event (message, contact sign-in, nudge, wink, call ringtone, games), mute while "Busy" (the call ringtone stays on).

Code: `src/utils/appPrefs.ts` (storage, React hook, sound rules), used by `SoundManager`, `GameSfx`, the contact list and the conversation.

Options → **Security** groups the account and device security settings: change password, keys remembered on this device (Forget this device), global private mode, your safety number, reset your keys, the list of blocked contacts (Unblock), and **Sign out my other sessions** (every other device goes back to the sign-in screen and stops receiving notifications; this one stays signed in). Signing out on one device still signs out all of them.

Options → **Connection** is a read-only diagnostic: real-time connection (state, transport, server response time, Reconnect), notifications (permission, push on the server and on this device, service worker), a network test for calls (TURN relay, Internet reachability, without calling anyone) and the browser features in use. **Copy report** gives a text to paste when asking for help, without secrets.

---

## Architecture & Security Hardening

OpenWLM applies the security measures below. They are checked by an automated test suite and code review — not by an independent external audit:

> **E2E scope — what is really end-to-end, what is not, and the limits:**
> see **[docs/SECURITY_E2E.md](docs/SECURITY_E2E.md)**.

1. **End-to-End Encryption (E2EE Zero-Knowledge)**:
   - Asymmetric RSA-OAEP 2048-bit encryption for session key exchange.
   - Symmetric AES-256-GCM encryption for messages, file transfers, and custom emoticons.
   - Zero-Knowledge architecture: the server never has access to plaintext messages or private decryption keys.
   - Messages are signed (RSA-PSS) by the sender; only signed and verified messages are displayed (unsigned or unverifiable messages are rejected).
2. **Client storage and non-extractable CryptoKey vault (`IndexedDB + Web Crypto`)**:
   - No JWT, raw RSA private key, JWK or crypto blob is kept in `localStorage` or `sessionStorage`.
   - The device vault (`WLM_DeviceVault_v1`) stores the private key as a native `CryptoKey` with `extractable: false` via IndexedDB structured cloning. Private key material is designed to prevent direct browser-side export through standard Web Crypto APIs (`crypto.subtle.exportKey()`), which significantly reduces exfiltration risk and helps contain sensitive material outside Web Storage.
   - `wlm_user` in `localStorage` is limited to an explicit whitelist of non-sensitive display fields (`id`, `username`, `nickname`, `avatar`, `scene`, `status`, `rememberMe`).
3. **Server-side sessions in `HttpOnly; SameSite=Strict` cookies**:
   - JWT tokens are issued as secure `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h` cookies (`Secure` in HTTPS/Cloudflare production).
   - The same authentication fallback (header, then cookie) on Express endpoints and Socket.IO handshakes (`io.use`).
   - Server-side token version revocation (`token_version`) and cookie purging on `/api/logout`.
4. **Centralized Access Authorization (`canInteract`)**:
   - Mutual contact check and block check in both directions before any interaction (messages, nudges, calls, files, games).
5. **Identity Spoofing Prevention**:
   - Sender identity is checked against the verified JWT (`socket.user.id === senderId`).
   - Display nicknames are recomputed server-side from the SQL database (client-provided names are never trusted).
6. **Server-Enforced Off-The-Record (Private Mode)**:
   - Nothing is persisted: if either user enables private mode — globally (`global_private = 1`) or for that conversation (`conversation_privacy`) — messages are never written to disk. The server decides from this persisted state and ignores the client's `isPrivate` flag; each user can only change their own setting.
7. **Rate Limiting & Abuse Prevention**:
   - **1 GB** storage quota per account for active shared files.
   - Tiered rate limiters: authentication (10 req/min), file uploads (5 req/min), nudges (3/min), winks (7/min), messages (20 / 10s), game moves (40 / 10s).
   - In-memory cleanup every 5 minutes removes expired captchas and inactive client IPs.
8. **Timing-Safe Cryptography**:
   - Password hashes are compared in constant time with `crypto.timingSafeEqual`, to prevent timing attacks.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Vanilla CSS (Aero retro theme).
- **Client Platforms**: Web browser, Progressive Web App (PWA) with Service Worker & Web App Manifest, Desktop (Optional Electron wrapper).
- **Backend**: Node.js, Express, Socket.IO.
- **Database**: SQLite (via `better-sqlite3`).
- **Cryptography**: Web Crypto API (`SubtleCrypto`), Node.js `crypto` (PBKDF2 SHA-512, AES-GCM, RSA-OAEP).

---

<p align="center">
  <img src="Screen1.png" width="48%" />
  <img src="Screen2.png" width="48%" />
</p>

---

## Installation & Quickstart

### Prerequisites
- **Node.js**: v20 or higher recommended (tested on v22 LTS).
- **npm**: v10 or higher.

### 1. Clone the repository
```bash
git clone https://github.com/OpenWLM/OpenWLM.git
cd OpenWLM
npm install
```

### 2. Seed the development database (Optional)
To test the application immediately with two pre-configured demonstration accounts:
```bash
npm run db:seed
```
This initializes two fictitious accounts with zero personal data:
- `alice@openwlm.local` (Password: `DemoPassword123!`)
- `bob@openwlm.local` (Password: `DemoPassword123!`)

> *Note: If you do not run `npm run db:seed`, the server automatically creates a fresh, empty database on first launch.*

### 3. Web Push & VAPID Provisioning (Recommended for PWA & Android)
To enable reliable background notifications without committing secrets:
```bash
node scripts/generate_vapid_keys.js
```
See [docs/VAPID_SETUP.md](docs/VAPID_SETUP.md).

### 4. Run the application

#### Development Mode (Vite frontend with hot-reload + Backend):
```bash
npm run dev
```

#### Production Mode:
```bash
# Build the React frontend
npm run build

# Start the Node.js production server
npm run server
# or directly:
NODE_ENV=production node server/index.js
```

> ⚠️ **In production, run the server under a supervisor** (systemd, pm2, Docker restart policy). It deliberately exits with code 1 after an unhandled error so it can be restarted in a clean state. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

The application will be accessible at: **http://localhost:3001**

---

## Security & Regression Testing

An automated security-test suite checks that the key client-side restrictions are also enforced server-side:

```bash
npm test
# or:
npm run test:security
```

It issues direct API and WebSocket requests (bypassing the UI) and checks the server rejects them:
- Sender ID spoofing (rejected)
- Unauthorized message history reading or deletion (HTTP 403)
- Forced persistence in private mode (overridden by server)
- Self-invitation or duplicate contact invitations (HTTP 400)
- Stealing third-party contact invitations (HTTP 404)
- WebRTC call requests to non-contacts or virtual bots (blocked)
- Game cheating attempts (out-of-turn moves, already occupied cells)
- File download attempts without valid secret tokens (HTTP 401/403)
- Directory traversal attacks on avatars or scenes (HTTP 400)

Browser end-to-end tests (Playwright, temporary database) cover sign-up/login, an encrypted message between two accounts, and an audio call switching to camera and screen sharing:

```bash
npm run test:e2e
```

> These tests catch regressions on known cases; they are a safety net, not a proof of security.

---

## Rollback & Backup

Before architectural or database changes:

```bash
# 1. Create a timestamped cold archive (server stopped recommended)
tar czf OpenWLM_backup_$(date +%Y%m%d_%H%M%S).tar.gz --exclude='node_modules' --exclude='.git' .

# 2. Tag your local Git state
git tag pre-feature-$(date +%Y%m%d)
```

---

## Version & References

- **Current Version**: `v1.5.1`
- **Git Reference Tag**: `v1.5.1`
- **Changelog**: See [CHANGELOG.md](CHANGELOG.md) (or [French version](CHANGELOG.fr.md)).

---

## License

This project is open-source under the MIT License. See the [LICENSE](LICENSE) file for details.
