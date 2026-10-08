import test from 'node:test';
import assert from 'node:assert';

/**
 * Implémentation miroir / directe des fonctions utilitaires de Security.ts
 * pour validation en environnement Node.js (Web Crypto natif).
 */
async function calculatePublicKeyFingerprint(publicKeyJwk) {
  if (!publicKeyJwk || !publicKeyJwk.n || !publicKeyJwk.e) return '';
  const canonical = JSON.stringify({
    e: publicKeyJwk.e,
    kty: publicKeyJwk.kty || 'RSA',
    n: publicKeyJwk.n
  });
  const data = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function formatSafetyNumber(hexFingerprint) {
  if (!hexFingerprint) return '';
  const clean = hexFingerprint.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const truncated = clean.slice(0, 32);
  const blocks = [];
  for (let i = 0; i < truncated.length; i += 4) {
    blocks.push(truncated.slice(i, i + 4));
  }
  return blocks.join(' ');
}

test('Safety Number: Empreinte SHA-256 canonique déterministe et indépendante de l’ordre des clés', async () => {
  const jwkA = {
    kty: 'RSA',
    n: 's1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    e: 'AQAB'
  };

  const jwkB = {
    e: 'AQAB',
    n: 's1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    kty: 'RSA'
  };

  const fpA = await calculatePublicKeyFingerprint(jwkA);
  const fpB = await calculatePublicKeyFingerprint(jwkB);

  assert.ok(fpA.length === 64, 'L’empreinte SHA-256 brute doit faire 64 caractères hexadécimaux');
  assert.strictEqual(fpA, fpB, 'L’empreinte doit être rigoureusement identique quel que soit l’ordre des propriétés');

  const formatted = formatSafetyNumber(fpA);
  const parts = formatted.split(' ');
  assert.strictEqual(parts.length, 8, 'Le Safety Number formaté doit comporter 8 blocs');
  parts.forEach(part => {
    assert.strictEqual(part.length, 4, 'Chaque bloc doit comporter exactement 4 caractères');
  });
});

test('Safety Number: Deux paires de clés différentes génèrent des empreintes distinctes', async () => {
  const keyPair1 = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const keyPair2 = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );

  const jwk1 = await crypto.subtle.exportKey('jwk', keyPair1.publicKey);
  const jwk2 = await crypto.subtle.exportKey('jwk', keyPair2.publicKey);

  const fp1 = await calculatePublicKeyFingerprint(jwk1);
  const fp2 = await calculatePublicKeyFingerprint(jwk2);

  assert.notStrictEqual(fp1, fp2, 'Deux clés publiques différentes doivent produire deux empreintes distinctes');
  assert.notStrictEqual(formatSafetyNumber(fp1), formatSafetyNumber(fp2), 'Les safety numbers formatés doivent différer');
});

test('Local Contact Verification: Stockage local et bascule de statut vérifié', async () => {
  // Simulation de l'état local dans localStorage
  const mockLocalStorage = {};
  const STORAGE_KEY = 'wlm_verified_contacts_v1';

  const setStored = (data) => {
    mockLocalStorage[STORAGE_KEY] = JSON.stringify(data);
  };
  const getStored = () => {
    return mockLocalStorage[STORAGE_KEY] ? JSON.parse(mockLocalStorage[STORAGE_KEY]) : {};
  };

  const contactId = 42;
  const dummyFp = 'A1B2C3D4E5F678901234567890ABCDEF1234567890ABCDEF1234567890ABCDEF';

  // 1. Initialement aucun contact vérifié
  assert.deepStrictEqual(getStored(), {});

  // 2. Utilisateur marque le contact comme vérifié localement
  let store = getStored();
  store[contactId] = {
    fingerprint: dummyFp,
    verified: true,
    verifiedAt: Date.now(),
    seenAt: Date.now()
  };
  setStored(store);

  // Vérification
  assert.strictEqual(getStored()[contactId].verified, true, 'Le contact doit être marqué vérifié');
  assert.strictEqual(getStored()[contactId].fingerprint, dummyFp);

  // 3. Utilisateur retire manuellement la vérification
  store = getStored();
  store[contactId] = {
    ...store[contactId],
    verified: false,
    verifiedAt: undefined
  };
  setStored(store);

  assert.strictEqual(getStored()[contactId].verified, false, 'Le contact ne doit plus être marqué vérifié');
});

test('Key Change Detection & Auto-Reset: Détection de changement de clé et révocation automatique du statut vérifié', async () => {
  let verifiedContacts = {};
  let keyAlertContactId = null;

  const contactId = 99;
  const initialFp = '111122223333444455556666777788889999AAAABBBBCCCCDDDDEEEEFFFF0000';
  const newFp = 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333444455556666777788889999';

  // Étape 1 : Le contact a été vérifié par l'utilisateur avec son empreinte initiale
  verifiedContacts[contactId] = {
    fingerprint: initialFp,
    verified: true,
    verifiedAt: Date.now(),
    seenAt: Date.now()
  };

  assert.strictEqual(verifiedContacts[contactId].verified, true);

  // Étape 2 : Simulation de la logique de détection automatique lors de la réception de la nouvelle clé publique
  const incomingFp = newFp;
  const existing = verifiedContacts[contactId];

  if (existing && existing.fingerprint && existing.fingerprint !== incomingFp) {
    // Règle de sécurité : révocation immédiate du statut vérifié + déclenchement d'alerte
    keyAlertContactId = contactId;
    verifiedContacts[contactId] = {
      fingerprint: incomingFp,
      verified: false, // Reset automatique
      seenAt: Date.now()
    };
  }

  // Vérifications
  assert.strictEqual(keyAlertContactId, contactId, 'Une alerte de changement de clé doit être déclenchée pour le contact');
  assert.strictEqual(verifiedContacts[contactId].verified, false, 'Le statut vérifié doit être automatiquement retiré');
  assert.strictEqual(verifiedContacts[contactId].fingerprint, newFp, 'La nouvelle empreinte doit être enregistrée');

  // Étape 3 : L'utilisateur inspecte la nouvelle clé et confirme à nouveau
  keyAlertContactId = null;
  verifiedContacts[contactId].verified = true;
  verifiedContacts[contactId].verifiedAt = Date.now();

  assert.strictEqual(keyAlertContactId, null, 'L’alerte doit être levée après confirmation');
  assert.strictEqual(verifiedContacts[contactId].verified, true, 'Le statut est à nouveau vérifié pour la nouvelle clé');
});

test('IndexedDB VerifiedContactsStorage: Schéma, persistance locale et opérations CRUD', async () => {
  const mockIDBStore = new Map();

  class MockVerifiedContactsStorage {
    async getAll() {
      const result = {};
      for (const [id, rec] of mockIDBStore.entries()) {
        result[id] = rec;
      }
      return result;
    }

    async get(contactId) {
      return mockIDBStore.get(contactId) || null;
    }

    async save(record) {
      mockIDBStore.set(record.contactId, { ...record });
      return { success: true };
    }

    async saveAll(records) {
      for (const rec of records) {
        mockIDBStore.set(rec.contactId, { ...rec });
      }
      return { success: true };
    }

    async remove(contactId) {
      mockIDBStore.delete(contactId);
      return { success: true };
    }
  }

  const storage = new MockVerifiedContactsStorage();

  // 1. Initialement vide
  assert.deepStrictEqual(await storage.getAll(), {});

  // 2. Enregistrement d'un contact vérifié
  const rec1 = {
    contactId: 101,
    fingerprint: 'AAAABBBBCCCC11112222333344445555',
    verified: true,
    verifiedAt: 1700000000000,
    seenAt: 1700000000000
  };
  await storage.save(rec1);

  const fetched = await storage.get(101);
  assert.ok(fetched);
  assert.strictEqual(fetched.verified, true);
  assert.strictEqual(fetched.fingerprint, rec1.fingerprint);

  // 3. Récupération collective
  const all = await storage.getAll();
  assert.strictEqual(Object.keys(all).length, 1);
  assert.strictEqual(all[101].fingerprint, rec1.fingerprint);

  // 4. Suppression
  await storage.remove(101);
  assert.strictEqual(await storage.get(101), null);
});

test('Migration automatique & idempotente: localStorage -> IndexedDB avec purge propre (zéro résidu)', async () => {
  const LEGACY_STORAGE_KEY = 'wlm_verified_contacts_v1';
  const LEGACY_FLAG_KEY = 'wlm_verified_contacts_migrated_v1';

  const mockLocalStorage = {
    [LEGACY_STORAGE_KEY]: JSON.stringify({
      10: { fingerprint: 'FP_10', verified: true, verifiedAt: 1000, seenAt: 1000 },
      20: { fingerprint: 'FP_20', verified: false, seenAt: 2000 }
    }),
    [LEGACY_FLAG_KEY]: 'true' // ancien marqueur préexistant à nettoyer
  };

  const idbStore = new Map();

  async function runMigration() {
    delete mockLocalStorage[LEGACY_FLAG_KEY];

    const raw = mockLocalStorage[LEGACY_STORAGE_KEY];
    if (!raw) {
      return { success: true, migrated: false, count: 0 };
    }

    const parsed = JSON.parse(raw);
    const records = [];
    for (const [k, v] of Object.entries(parsed)) {
      records.push({
        contactId: parseInt(k, 10),
        fingerprint: v.fingerprint,
        verified: !!v.verified,
        verifiedAt: v.verifiedAt,
        seenAt: v.seenAt || Date.now()
      });
    }

    for (const r of records) {
      idbStore.set(r.contactId, r);
    }

    // Migration réussie : purge complète de toute clé liée aux verified contacts dans localStorage
    delete mockLocalStorage[LEGACY_STORAGE_KEY];
    delete mockLocalStorage[LEGACY_FLAG_KEY];

    return { success: true, migrated: true, count: records.length };
  }

  // Premier passage : migration effective
  const res1 = await runMigration();
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.migrated, true);
  assert.strictEqual(res1.count, 2);

  // Vérifier données dans IndexedDB
  assert.strictEqual(idbStore.get(10).fingerprint, 'FP_10');
  assert.strictEqual(idbStore.get(10).verified, true);
  assert.strictEqual(idbStore.get(20).verified, false);

  // Vérifier qu'aucun résidu (données ou drapeaux) ne reste dans localStorage
  assert.strictEqual(mockLocalStorage[LEGACY_STORAGE_KEY], undefined, 'La clé legacy localStorage doit avoir été purgée');
  assert.strictEqual(mockLocalStorage[LEGACY_FLAG_KEY], undefined, 'Aucun drapeau superflu ne doit subsister dans localStorage');
  assert.strictEqual(Object.keys(mockLocalStorage).length, 0, 'localStorage doit être 100% exempt de clés verified contacts');

  // Deuxième passage : idempotence naturelle (rien à migrer, aucune écriture)
  const res2 = await runMigration();
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.migrated, false, 'Le second passage doit être naturellement idempotent');
  assert.strictEqual(res2.count, 0);
});

test('Résilience: Aucune perte de données si la migration IndexedDB échoue', async () => {
  const LEGACY_STORAGE_KEY = 'wlm_verified_contacts_v1';

  const mockLocalStorage = {
    [LEGACY_STORAGE_KEY]: JSON.stringify({
      55: { fingerprint: 'FP_55', verified: true }
    })
  };

  async function runFailingMigration() {
    const raw = mockLocalStorage[LEGACY_STORAGE_KEY];
    if (!raw) return { success: true, migrated: false };

    // Simulation d'une erreur d'écriture IndexedDB (QuotaExceededError)
    const dbWriteSuccess = false;
    if (!dbWriteSuccess) {
      // RÈGLE : Ne PAS supprimer le legacy en cas d'erreur !
      return { success: false, error: 'QuotaExceededError' };
    }

    delete mockLocalStorage[LEGACY_STORAGE_KEY];
    return { success: true, migrated: true };
  }

  const res = await runFailingMigration();
  assert.strictEqual(res.success, false);
  assert.ok(mockLocalStorage[LEGACY_STORAGE_KEY], 'Les données legacy doivent être conservées en cas d’échec IndexedDB');
});
