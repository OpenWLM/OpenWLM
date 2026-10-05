<p align="center">
  <img src="logo.png" alt="OpenWLM Logo" width="200" />
</p>

<p align="center">
  <b>English</b> • <a href="README.fr.md">Français</a>
</p>

# OpenWLM (Modern Web Stack)

A modern, open-source, and secure recreation of the iconic late-2000s retro instant messaging experience (Aero glass UI). This project combines the nostalgic design of the 2000s with 2026 security, end-to-end encryption, and performance standards.

⚠️ **Disclaimer & Legal Notice**:  
OpenWLM is an independent educational, open-source project and a nostalgic tribute to classic 2000s instant messaging software. It is not affiliated, associated, authorized, endorsed by, or in any way officially connected with any proprietary brand, software, or corporation.

> [!WARNING]
> **AI-Assisted Development Notice**:  
> This project was developed with the assistance of Artificial Intelligence (Google Antigravity / LLM-assisted pair programming). While thorough manual reviews, end-to-end testing, and authoritative security audits (`npm run test:security`) have been implemented, unexpected bugs, edge-case regressions, or design oversights may still remain. Peer reviews, community audits, and security vulnerability reports are warmly welcomed!

---

## 🚀 Key Features

### 💬 Communication & Authenticity
- **Authentic Retro Interface**: Faithful replica of classic late-2000s instant messaging (Aero glass styling, tabs, background scenes, usertiles, retro audio sound effects).
- **Progressive Web App (PWA)**: Fully installable as a standalone desktop or mobile application with offline Service Worker asset caching, web app manifest, and retro Aero taskbar icon integration.
- **Built-in Assistant & Test Contact ("OpenWLM")**: Dedicated virtual system contact (ID `-1`) with an empty-state quickstart button, allowing new users to test chat, emoticons, sounds, Wizz/nudges, Tic-Tac-Toe, and Connect Four (`/p4`) immediately without needing a second account.
- **Secure Instant Messaging**: Rich text support, classic legacy emoticons, and custom end-to-end encrypted emoticons.
- **Display Name & Status Emoticons**: Authentic support for classic emoticons directly inside user display names and personal status messages (PSM), rendered seamlessly across contact rosters, chat tabs, conversation headers, and game scoreboards with true alpha-transparent PNG & APNG assets.
- **Audio & Video Calls (WebRTC)**: Real-time peer-to-peer voice and video calls with encrypted signaling.
- **Voice Clips**: Record and stream end-to-end encrypted audio messages.
- **Winks & Nudges**: Animated full-screen winks and screen-shaking Wizz effects.
- **1v1 Multiplayer Mini-Games**: Real-time Tic-Tac-Toe (Morpion), Checkers (Jeu de dames), and Connect Four (Puissance 4 on a classic 7x6 board) with authoritative server-side anti-cheat validation, gravity animations, and collapsible game docks.
- **Encrypted File Transfer**: Temporary peer file sharing (4-hour TTL) with on-the-fly decryption and image lightbox previews.
- **Full Bilingual Internationalization (EN / FR)**: Native English and French support with instant reactive switching, browser language autodetection, and zero UI overflow preserving the classic retro Aero layout.

---

## 🔐 Architecture & Security Hardening

OpenWLM has undergone an extensive security audit and rigorous end-to-end hardening:

1. **End-to-End Encryption (E2EE Zero-Knowledge)**:
   - Asymmetric RSA-OAEP 2048-bit encryption for session key exchange.
   - Symmetric AES-256-GCM encryption for messages, file transfers, and custom emoticons.
   - Zero-Knowledge architecture: the server never has access to plaintext messages or private decryption keys.
2. **Hardened Client Storage & Non-Extractable CryptoKey Vault (`IndexedDB + Web Crypto`)**:
   - Eliminates JWT tokens, raw RSA private keys, JWKs, and crypto blobs from `localStorage` and `sessionStorage`.
   - The device vault (`WLM_DeviceVault_v1`) stores the private key as a native `CryptoKey` with `extractable: false` via IndexedDB structured cloning. Private key material is designed to prevent direct browser-side export through standard Web Crypto APIs (`crypto.subtle.exportKey()`), which significantly reduces exfiltration risk and helps contain sensitive material outside Web Storage.
   - `wlm_user` in `localStorage` is strictly restricted to an explicit whitelist of non-sensitive display fields (`id`, `username`, `nickname`, `avatar`, `scene`, `status`, `rememberMe`).
3. **Server-Side Session Hardening with `HttpOnly; SameSite=Strict` Cookies**:
   - JWT tokens are issued as secure `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h` cookies (`Secure` in HTTPS/Cloudflare production).
   - Unified dual authentication fallback on Express endpoints and Socket.IO handshakes (`io.use`).
   - Server-side token version revocation (`token_version`) and cookie purging on `/api/logout`.
4. **Centralized Access Authorization (`canInteract`)**:
   - Strict mutual contact verification and bidirectional block checking before any interaction (messages, nudges, calls, files, games).
5. **Identity Spoofing Prevention**:
   - Strict validation of sender identity via verified JWT tokens (`socket.user.id === senderId`).
   - Display nicknames are systematically recalculated server-side from the SQL database (client-provided names are never trusted).
6. **Authoritative Off-The-Record (Private Mode)**:
   - Server-enforced non-persistence: if either user in a conversation enables global private mode (`global_private = 1`), messages are never persisted to disk, overriding any client manipulation.
7. **Rate Limiting & Abuse Prevention**:
   - Strict **1 GB** storage quota per account for active shared files.
   - Tiered rate limiters: authentication (10 req/min), file uploads (5 req/min), nudges (3/min), winks (7/min), messages (20 / 10s).
   - Automated in-memory garbage collection every 5 minutes purging expired captchas and inactive client IPs.
8. **Timing-Safe Cryptography**:
   - Password hashes verified in constant time using `crypto.timingSafeEqual` to neutralize timing attack vulnerabilities.

---

## 🛠 Tech Stack

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

## 📦 Installation & Quickstart

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
See the complete documentation: [docs/VAPID_SETUP.md](docs/VAPID_SETUP.md).

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
The application will be accessible at: **http://localhost:3001**

---

## 🧪 Security & Regression Testing

An authoritative security enforcement test suite is included in the project to verify that all frontend restrictions are strictly enforced server-side:

```bash
npm test
# or:
npm run test:security
```

This automated suite tests direct API and WebSocket bypass attempts:
- Sender ID spoofing (rejected)
- Unauthorized message history reading or deletion (HTTP 403)
- Forced persistence in private mode (overridden by server)
- Self-invitation or duplicate contact invitations (HTTP 400)
- Stealing third-party contact invitations (HTTP 404)
- WebRTC call requests to non-contacts or virtual bots (blocked)
- Game cheating attempts (out-of-turn moves, already occupied cells)
- File download attempts without valid secret tokens (HTTP 401/403)
- Directory traversal attacks on avatars or scenes (HTTP 400)

---

## 🛡️ Safe Rollback & Backup Procedures

Before making any sensitive architectural or database changes:

```bash
# 1. Create a timestamped cold archive (server stopped recommended)
tar czf OpenWLM_backup_$(date +%Y%m%d_%H%M%S).tar.gz --exclude='node_modules' --exclude='.git' .

# 2. Tag your local Git state
git tag pre-feature-$(date +%Y%m%d)
```

---

## 🏷️ Version & References

- **Current Version**: `v1.0.0`
- **Git Reference Tag**: `v1.0.0`
- **Changelog**: See [CHANGELOG.md](CHANGELOG.md) (or [French version](CHANGELOG.fr.md)).

---

## 📄 License

This project is open-source under the MIT License. See the [LICENSE](LICENSE) file for details.
