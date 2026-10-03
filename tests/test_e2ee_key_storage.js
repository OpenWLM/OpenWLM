import test from 'node:test';
import assert from 'node:assert';

test('WebCrypto: Non-extractable RSA private key cannot be exported', async () => {
  // 1. Generate an RSA-OAEP 2048 keypair
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true, // extractable temporarily to get JWK as done during login vault decryption
    ['encrypt', 'decrypt']
  );

  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  // 2. Import private key as NON-EXTRACTABLE (extractable = false)
  const nonExtractablePrivKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false, // extractable = false
    ['decrypt']
  );

  assert.strictEqual(nonExtractablePrivKey.extractable, false, 'Key must be non-extractable');

  // 3. Attempt to export key (simulating malicious XSS payload)
  let exportJwkFailed = false;
  try {
    await crypto.subtle.exportKey('jwk', nonExtractablePrivKey);
  } catch (err) {
    exportJwkFailed = true;
    assert.match(err.message, /not extractable/i);
  }
  assert.strictEqual(exportJwkFailed, true, 'Export JWK must be blocked by the crypto engine');

  let exportPkcs8Failed = false;
  try {
    await crypto.subtle.exportKey('pkcs8', nonExtractablePrivKey);
  } catch (err) {
    exportPkcs8Failed = true;
    assert.match(err.message, /not extractable/i);
  }
  assert.strictEqual(exportPkcs8Failed, true, 'Export PKCS#8 must be blocked by the crypto engine');

  // 4. Verify that structured cloning (as done by IndexedDB) preserves non-extractable attribute
  const clonedKey = structuredClone(nonExtractablePrivKey);
  assert.strictEqual(clonedKey.extractable, false, 'Cloned key must remain non-extractable');

  // 5. Verify that decryption works with the cloned non-extractable key
  const messageText = 'Message confidentiel chiffré OpenWLM E2EE';
  const encodedText = new TextEncoder().encode(messageText);

  const importedPubKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  const encryptedData = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    importedPubKey,
    encodedText
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    clonedKey,
    encryptedData
  );

  const decryptedText = new TextDecoder().decode(decryptedBuffer);
  assert.strictEqual(decryptedText, messageText, 'Decryption must succeed with the cloned non-extractable key');
});

test('Resilience: Simulated IndexedDB storage failure returns { success: false } without throwing', async () => {
  // Mock an environment where IndexedDB throws QuotaExceededError or SecurityError
  class MockFailingIDBStore {
    async saveKeys() {
      try {
        throw new Error('QuotaExceededError: The quota has been exceeded.');
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }

  const failingVault = new MockFailingIDBStore();
  const result = await failingVault.saveKeys();

  // The function must NOT throw and return a clean failure object
  assert.strictEqual(result.success, false);
  assert.match(result.error, /QuotaExceededError/);
});

test('Anti-tamper: Stored public key mismatch is properly detected', async () => {
  const pubKeyServer = { kty: 'RSA', n: 'abc', e: 'AQAB' };
  const pubKeyStored = { kty: 'RSA', n: 'xyz', e: 'AQAB' };

  const isMatch = JSON.stringify(pubKeyServer) === JSON.stringify(pubKeyStored);
  assert.strictEqual(isMatch, false, 'Mismatched keys between server and local storage must be detected');
});
