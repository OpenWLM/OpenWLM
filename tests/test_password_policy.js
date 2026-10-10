import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Helper import dynamically from built module or replicate pure function
import { evaluatePassword } from '../src/utils/PasswordStrength.ts';

test('Password Policy: Rejects passwords shorter than 12 characters as non-conformant', () => {
  const short1 = evaluatePassword('');
  assert.equal(short1.isConformant, false);
  assert.equal(short1.length, 0);
  assert.equal(short1.score, 0);

  const short2 = evaluatePassword('password');
  assert.equal(short2.isConformant, false);
  assert.equal(short2.length, 8);
  assert.equal(short2.score, 1);
  assert.equal(short2.strengthLevel, 'weak');

  const short3 = evaluatePassword('SoleilBleu1'); // 11 chars
  assert.equal(short3.isConformant, false);
  assert.equal(short3.length, 11);
});

test('Password Policy: Accepts passwords >= 12 characters as conformant', () => {
  const exact12 = evaluatePassword('SoleilBleu12');
  assert.equal(exact12.isConformant, true);
  assert.equal(exact12.length, 12);
  assert.ok(exact12.score >= 1);
});

test('Password Policy: Flags conformant but predictable passwords as weak', () => {
  // 12 chars of identical char
  const repeated = evaluatePassword('aaaaaaaaaaaa');
  assert.equal(repeated.isConformant, true, 'Should be conformant by length');
  assert.equal(repeated.score, 1, 'Score must be weak due to zero diversity');
  assert.equal(repeated.strengthLevel, 'weak');

  // 12 chars sequential numbers
  const sequential = evaluatePassword('123456789012');
  assert.equal(sequential.isConformant, true, 'Should be conformant by length');
  assert.equal(sequential.score, 1, 'Score must be weak due to obvious sequence');
  assert.equal(sequential.strengthLevel, 'weak');
});

test('Password Policy: Natural multi-word passphrases with spaces achieve top scores without symbols/digits', () => {
  // Pure lowercase words with spaces, no numbers, no special symbols!
  const passphrase4Words = evaluatePassword('soleil bleu matin d hiver');
  assert.equal(passphrase4Words.isConformant, true);
  assert.equal(passphrase4Words.hasSpaces, true);
  assert.ok(passphrase4Words.wordCount >= 4);
  assert.equal(passphrase4Words.strengthLevel, 'excellent');
  assert.equal(passphrase4Words.score, 4);

  const passphrase3Words = evaluatePassword('soleil bleu matin');
  assert.equal(passphrase3Words.isConformant, true);
  assert.equal(passphrase3Words.hasSpaces, true);
  assert.ok(passphrase3Words.wordCount >= 3);
  assert.ok(['good', 'excellent'].includes(passphrase3Words.strengthLevel));
});

test('UI Logic: Auth.tsx enforces length >= 12 and removes rigid legacy regex', () => {
  const authTsx = fs.readFileSync(path.join(rootDir, 'src/components/Auth.tsx'), 'utf8');

  // Ensure legacy regex is gone
  assert.ok(
    !authTsx.includes('(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[\\W_])'),
    'Legacy artificial complexity regex should not exist in Auth.tsx'
  );

  // Ensure minimal length rule exists
  assert.ok(
    authTsx.includes('password.length < 12'),
    'Auth.tsx should block submission when password.length < 12'
  );

  // Ensure dynamic feedback is rendered
  assert.ok(authTsx.includes('auth-password-guidance'), 'Guidance container should exist in Auth.tsx');
  assert.ok(authTsx.includes('auth-compliance-status'), 'Compliance status element should exist in Auth.tsx');
  assert.ok(authTsx.includes('auth-strength-bar'), 'Strength progress bar should exist in Auth.tsx');
});

test('i18n: FR and EN translation files contain all required guidance and strength keys', () => {
  const fr = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/en.json'), 'utf8'));

  const requiredKeys = [
    'passwordPolicy',
    'passwordLabelSignup',
    'passwordHelp',
    'passwordLengthRequired',
    'passwordLengthMet',
    'passwordStrengthLabel',
    'passwordStrengthWeak',
    'passwordStrengthFair',
    'passwordStrengthGood',
    'passwordStrengthExcellent',
    'passwordFeedbackWeak',
    'passwordFeedbackFair',
    'passwordFeedbackGood',
    'passwordFeedbackExcellent'
  ];

  for (const k of requiredKeys) {
    assert.ok(fr.auth[k], `fr.json missing auth.${k}`);
    assert.ok(en.auth[k], `en.json missing auth.${k}`);
  }

  // Vérifications de wording spécifiques
  assert.equal(fr.auth.nicknameLabel, 'Pseudo :', 'nicknameLabel in FR must be Pseudo :');
  assert.equal(fr.auth.emailAddressLabel, 'Adresse de connexion :', 'emailAddressLabel in FR must be Adresse de connexion :');
  assert.equal(fr.auth.passwordLabelSignup, 'Mot de passe ou phrase de passe :', 'passwordLabelSignup in FR must be Mot de passe ou phrase de passe :');
  assert.match(fr.auth.passwordHelp, /Ce mot de passe protège votre compte et vos clés de chiffrement locales/, 'passwordHelp must explain local encryption');
  assert.doesNotMatch(fr.auth.passwordHelp, /phrases de passe avec espaces/, 'passwordHelp must not have unnatural phrase mention');
  assert.doesNotMatch(fr.auth.passwordFeedbackExcellent, /Protection optimale/, 'Must avoid Protection optimale');
  assert.match(fr.auth.passwordFeedbackExcellent, /Très bonne protection/, 'Must use softened wording');
  assert.equal(fr.auth.emailPlaceholderSignup, 'exemple@openwlm.dev', 'Placeholder must be exemple@openwlm.dev');
});

test('Auth UI: Identifier input has placeholder exemple@openwlm.dev without auto-filling value', () => {
  const authTsx = fs.readFileSync(path.join(rootDir, 'src/components/Auth.tsx'), 'utf8');

  // Verify placeholder logic
  assert.match(authTsx, /placeholder=\{!isLogin\s*\?\s*\(t\.auth\.emailPlaceholderSignup\s*\|\|\s*['"]exemple@openwlm\.dev['"]\)/);

  // Ensure value is untouched (bound purely to value={username}, no default '@openwlm.dev' string injected)
  assert.match(authTsx, /value=\{username\}/);
  assert.doesNotMatch(authTsx, /setUsername\(.*@openwlm\.dev.*\)/);
});

test('Captcha i18n: Question, label, and placeholder are fully localized in FR and EN', () => {
  const fr = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/en.json'), 'utf8'));

  // Question localization
  assert.equal(fr.auth.captchaQuestion, 'Combien font {num1} + {num2} ?');
  assert.equal(en.auth.captchaQuestion, 'How much is {num1} + {num2}?');

  // Label localization
  assert.equal(fr.auth.captchaLabel, 'Validation Anti-Robot :');
  assert.equal(en.auth.captchaLabel, 'Anti-Robot Verification:');

  // Placeholder localization
  assert.equal(fr.auth.captchaPlaceholder, 'Votre réponse');
  assert.equal(en.auth.captchaPlaceholder, 'Your answer');

  // Client formatCaptchaQuestion function in Auth.tsx
  const authTsx = fs.readFileSync(path.join(rootDir, 'src/components/Auth.tsx'), 'utf8');
  assert.ok(authTsx.includes('formatCaptchaQuestion(captchaData)'), 'Auth.tsx calls formatCaptchaQuestion');
  assert.ok(authTsx.includes('params: { lang: language }'), 'Auth.tsx passes lang param to /api/captcha');

  // Server support in server/index.js
  const serverJs = fs.readdirSync(path.join(rootDir, 'server'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(rootDir, 'server', f), 'utf8'))
    .join('\n');
  assert.ok(serverJs.includes("How much is ${num1} + ${num2}?"), 'server/index.js supports EN captcha question');
  assert.ok(serverJs.includes("Combien font ${num1} + ${num2} ?"), 'server/index.js supports FR captcha question');
});


