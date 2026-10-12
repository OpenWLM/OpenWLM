import crypto from 'crypto';
import { leadingZeroBits } from '../../server/utils/signupGuard.js';

/** Résout un défi PoW renvoyé par GET /api/captcha (côté tests, Node natif). */
export const solvePow = (pow) => {
  if (!pow || !(pow.difficulty > 0)) return '0';
  for (let n = 0; ; n++) {
    const d = crypto.createHash('sha256').update(`${pow.salt}:${n}`).digest();
    if (leadingZeroBits(d) >= pow.difficulty) return String(n);
  }
};
