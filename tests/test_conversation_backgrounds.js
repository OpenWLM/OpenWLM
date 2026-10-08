import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONV_BACKGROUNDS_STORAGE_KEY,
  loadConversationBackgrounds,
  saveConversationBackgrounds,
  setConversationBackground,
  removeConversationBackground
} from '../src/utils/ConversationBackgrounds.ts';

// Mock Storage simulant localStorage
function createMockStorage(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    get raw() {
      return Object.fromEntries(store.entries());
    }
  };
}

test('1. Cas sans données : retourne une carte vide par défaut', () => {
  const storage = createMockStorage();
  const result = loadConversationBackgrounds(storage);
  assert.deepEqual(result, {});
});

test('2. Résilience : gestion robuste des données corrompues ou invalides', () => {
  // Cas A: JSON mal formé
  const storageMalformed = createMockStorage({ [CONV_BACKGROUNDS_STORAGE_KEY]: '{"invalid json' });
  assert.deepEqual(loadConversationBackgrounds(storageMalformed), {});

  // Cas B: Types non-objets (tableau, primitive chaîne, nombre)
  const storageArray = createMockStorage({ [CONV_BACKGROUNDS_STORAGE_KEY]: '["car.jpg", "fish.jpg"]' });
  assert.deepEqual(loadConversationBackgrounds(storageArray), {});

  const storagePrimitive = createMockStorage({ [CONV_BACKGROUNDS_STORAGE_KEY]: '"just a string"' });
  assert.deepEqual(loadConversationBackgrounds(storagePrimitive), {});

  const storageNumber = createMockStorage({ [CONV_BACKGROUNDS_STORAGE_KEY]: '12345' });
  assert.deepEqual(loadConversationBackgrounds(storageNumber), {});

  // Cas C: Clés non numériques ou valeurs nulles / non-chaînes / chaînes vides filtrées proprement
  const storageCorruptValues = createMockStorage({
    [CONV_BACKGROUNDS_STORAGE_KEY]: JSON.stringify({
      "1": "car.jpg",
      "not_a_number": "fish.jpg",
      "2": null,
      "3": 12345,
      "4": "   ",
      "-1": "planets.jpg" // ID du bot système supporté
    })
  });
  const sanitized = loadConversationBackgrounds(storageCorruptValues);
  assert.deepEqual(sanitized, {
    1: 'car.jpg',
    '-1': 'planets.jpg'
  });
});

test('3. Enregistrement et persistance par conversation (contactId et bot système -1)', () => {
  const storage = createMockStorage();
  let map = {};

  // Définir un fond pour le contact 42
  map = setConversationBackground(map, 42, 'car.jpg', storage);
  assert.equal(map[42], 'car.jpg');
  assert.equal(JSON.parse(storage.getItem(CONV_BACKGROUNDS_STORAGE_KEY))['42'], 'car.jpg');

  // Définir un fond différent pour le contact 99
  map = setConversationBackground(map, 99, 'lavender.jpg', storage);
  assert.equal(map[42], 'car.jpg');
  assert.equal(map[99], 'lavender.jpg');

  // Définir un fond pour le bot système (-1)
  map = setConversationBackground(map, -1, 'planets.jpg', storage);
  assert.equal(map[-1], 'planets.jpg');

  // Vérifier la persistance après un nouveau chargement (simulation rechargement page)
  const reloaded = loadConversationBackgrounds(storage);
  assert.equal(reloaded[42], 'car.jpg');
  assert.equal(reloaded[99], 'lavender.jpg');
  assert.equal(reloaded[-1], 'planets.jpg');
  assert.equal(reloaded[100], undefined, 'Un contact sans préférence retourne undefined / fallback');
});

test('4. Réinitialisation vers le fond par défaut (Standard / vide)', () => {
  const storage = createMockStorage();
  let map = { 42: 'car.jpg', 99: 'fish.jpg' };
  saveConversationBackgrounds(map, storage);

  // Remettre à standard (bgFile = '')
  map = setConversationBackground(map, 42, '', storage);
  assert.equal(map[42], undefined);
  assert.equal(map[99], 'fish.jpg');

  // Vérifier dans le stockage
  const reloaded = loadConversationBackgrounds(storage);
  assert.equal(reloaded[42], undefined);
  assert.equal(reloaded[99], 'fish.jpg');
});

test('5. Suppression de conversation : purge propre sans orphelins', () => {
  const storage = createMockStorage();
  let map = { 10: 'hearts.jpg', 20: 'fish.jpg' };
  saveConversationBackgrounds(map, storage);

  map = removeConversationBackground(map, 10, storage);
  assert.deepEqual(map, { 20: 'fish.jpg' });

  const reloaded = loadConversationBackgrounds(storage);
  assert.deepEqual(reloaded, { 20: 'fish.jpg' });
});
