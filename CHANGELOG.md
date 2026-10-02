<p align="center">
  <b>English</b> • <a href="CHANGELOG.fr.md">Français</a>
</p>

# Changelog - OpenWLM

All notable changes to this project are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] - 2026-10-02

This major release consolidates the modern recreation of Windows Live Messenger 2009 (Wave 3 / Aero) with production-grade security hardening, a built-in test assistant contact ("OpenWLM"), and authoritative automated regression testing.

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
  - Classic MSN Tic-Tac-Toe (Morpion) in real-time.
  - Real-time Checkers (Jeu de dames) with authoritative server validation.
  - Collapsible dock banner allowing users to minimize active games without leaving the chat.
- **E2EE File Transfer**:
  - Encrypted peer file sharing with automatic 4-hour time-to-live (TTL).
  - Instant on-the-fly image decryption with lightbox preview.
- **Authentic MSN / Windows Live Messenger Experience**:
  - Original sound effects (logon, message, wizz, call, nudge).
  - Full-screen animated winks, screen-shaking wizz effects.
  - Display nicknames, personal status messages (PSM), retro avatars, and scenes.

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
