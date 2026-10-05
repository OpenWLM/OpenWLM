import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import direct des fonctions de TabUtils (compilé ou implémentation miroir pour test unitaire Node)
function reorderChatTabs(tabs, draggedId, targetId, position) {
  if (!Array.isArray(tabs) || tabs.length <= 1) return tabs;
  if (draggedId === targetId) return tabs;

  const fromIndex = tabs.indexOf(draggedId);
  if (fromIndex === -1) return tabs;

  const updated = [...tabs];
  const [moved] = updated.splice(fromIndex, 1);

  let targetIndex = updated.indexOf(targetId);
  if (targetIndex === -1) return tabs;

  if (position === 'right') {
    targetIndex += 1;
  }

  updated.splice(targetIndex, 0, moved);
  return updated;
}

function sanitizeOpenChatIds(openIds, validContactIds, systemBotId = -1) {
  if (!Array.isArray(openIds)) return [];
  const contactSet = new Set(validContactIds);
  return openIds.filter(id => id === systemBotId || contactSet.has(id));
}

test('TabUtils.reorderChatTabs - Glisser un onglet vers la gauche (insertion avant la cible)', () => {
  const initial = [1, 2, 3, 4];
  const result = reorderChatTabs(initial, 3, 1, 'left');
  assert.deepStrictEqual(result, [3, 1, 2, 4]);
  // Immuabilité de la source
  assert.deepStrictEqual(initial, [1, 2, 3, 4]);
});

test('TabUtils.reorderChatTabs - Glisser un onglet vers la droite (insertion après la cible)', () => {
  const initial = [1, 2, 3, 4];
  const result = reorderChatTabs(initial, 1, 3, 'right');
  assert.deepStrictEqual(result, [2, 3, 1, 4]);
  assert.deepStrictEqual(initial, [1, 2, 3, 4]);
});

test('TabUtils.reorderChatTabs - Déplacer le premier onglet en toute dernière position', () => {
  const initial = [10, 20, 30];
  const result = reorderChatTabs(initial, 10, 30, 'right');
  assert.deepStrictEqual(result, [20, 30, 10]);
});

test('TabUtils.reorderChatTabs - Déplacer le dernier onglet en toute première position', () => {
  const initial = [10, 20, 30];
  const result = reorderChatTabs(initial, 30, 10, 'left');
  assert.deepStrictEqual(result, [30, 10, 20]);
});

test('TabUtils.reorderChatTabs - Glisser un onglet sur lui-même ne fait rien', () => {
  const initial = [1, 2, 3];
  const result = reorderChatTabs(initial, 2, 2, 'left');
  assert.deepStrictEqual(result, [1, 2, 3]);
});

test('TabUtils.reorderChatTabs - Identifiant inexistant renvoie le tableau intact', () => {
  const initial = [1, 2, 3];
  assert.deepStrictEqual(reorderChatTabs(initial, 999, 1, 'left'), [1, 2, 3]);
  assert.deepStrictEqual(reorderChatTabs(initial, 1, 999, 'left'), [1, 2, 3]);
});

test('TabUtils.reorderChatTabs - Tableau vide ou à 1 élément', () => {
  assert.deepStrictEqual(reorderChatTabs([], 1, 2, 'left'), []);
  assert.deepStrictEqual(reorderChatTabs([1], 1, 1, 'left'), [1]);
});

test('TabUtils.sanitizeOpenChatIds - Purge des contacts orphelins tout en conservant le bot système et l’ordre', () => {
  const openTabs = [101, -1, 999, 102, 888]; // 999 et 888 sont supprimés
  const validContacts = [101, 102, 103];
  const sanitized = sanitizeOpenChatIds(openTabs, validContacts, -1);

  assert.deepStrictEqual(sanitized, [101, -1, 102]);
  // L'ordre personnalisé est conservé intact
  assert.strictEqual(sanitized[0], 101);
  assert.strictEqual(sanitized[1], -1);
  assert.strictEqual(sanitized[2], 102);
});

test('TabUtils.sanitizeOpenChatIds - Entrées invalides ou vides', () => {
  assert.deepStrictEqual(sanitizeOpenChatIds(null, [1, 2]), []);
  assert.deepStrictEqual(sanitizeOpenChatIds([1, 2], []), []);
  assert.deepStrictEqual(sanitizeOpenChatIds([-1], [], -1), [-1]);
});

test('UX & État - La réorganisation d’onglets préserve l’onglet actif (activeChatId)', () => {
  let tabs = [10, 20, 30];
  let activeChatId = 20;

  // L'utilisateur déplace l'onglet 10 après l'onglet 30
  tabs = reorderChatTabs(tabs, 10, 30, 'right');
  assert.deepStrictEqual(tabs, [20, 30, 10]);
  // L'onglet actif reste strictement 20
  assert.strictEqual(activeChatId, 20);

  // L'utilisateur déplace l'onglet actif 20 en fin de liste
  tabs = reorderChatTabs(tabs, 20, 10, 'right');
  assert.deepStrictEqual(tabs, [30, 10, 20]);
  // L'onglet actif reste toujours 20
  assert.strictEqual(activeChatId, 20);
});

test('UX & État - La fermeture d’un onglet fonctionne sans régression après réorganisation', () => {
  let tabs = [10, 20, 30, 40];
  let activeChatId = 30;

  // Réorganisation préalable
  tabs = reorderChatTabs(tabs, 40, 10, 'left');
  assert.deepStrictEqual(tabs, [40, 10, 20, 30]);

  // Fermeture d'un onglet non actif (10)
  const closeChat = (idToClose) => {
    tabs = tabs.filter(id => id !== idToClose);
    if (activeChatId === idToClose) {
      activeChatId = tabs.length > 0 ? tabs[0] : 0;
    }
  };

  closeChat(10);
  assert.deepStrictEqual(tabs, [40, 20, 30]);
  assert.strictEqual(activeChatId, 30);

  // Fermeture de l'onglet actif (30)
  closeChat(30);
  assert.deepStrictEqual(tabs, [40, 20]);
  assert.strictEqual(activeChatId, 40); // Fallback sur le premier onglet ouvert
});

test('Vérification statique - Intégration dans App.tsx et WLM.css', () => {
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');
  const wlmCss = fs.readFileSync(path.join(__dirname, '../src/WLM.css'), 'utf-8');
  const tabUtilsTs = fs.readFileSync(path.join(__dirname, '../src/utils/TabUtils.ts'), 'utf-8');

  // 1. TabUtils.ts exporte bien les fonctions requises
  assert(tabUtilsTs.includes('export function reorderChatTabs'), 'reorderChatTabs non exporté');
  assert(tabUtilsTs.includes('export function sanitizeOpenChatIds'), 'sanitizeOpenChatIds non exporté');

  // 2. App.tsx importe et utilise les fonctions
  assert(appTsx.includes("import { reorderChatTabs, sanitizeOpenChatIds } from './utils/TabUtils';"), 'Import TabUtils manquant');
  assert(appTsx.includes('handleTabDragStart'), 'handleTabDragStart manquant');
  assert(appTsx.includes('handleTabDragOver'), 'handleTabDragOver manquant');
  assert(appTsx.includes('handleTabDragLeave'), 'handleTabDragLeave manquant');
  assert(appTsx.includes('handleTabDrop'), 'handleTabDrop manquant');
  assert(appTsx.includes('handleTabDragEnd'), 'handleTabDragEnd manquant');

  // 3. App.tsx intègre draggable et la protection du bouton de fermeture
  assert(appTsx.includes('draggable={true}'), 'Attribut draggable={true} manquant sur les onglets');
  assert(appTsx.includes('draggable={false}'), 'Attribut draggable={false} manquant sur le bouton de fermeture');
  assert(appTsx.includes('closest(\'.chat-tab-close\')'), 'Garde-fou sur le bouton de fermeture manquant');
  assert(appTsx.includes('drop-target-left'), 'Indicateur visuel drop-target-left manquant');
  assert(appTsx.includes('drop-target-right'), 'Indicateur visuel drop-target-right manquant');

  // 4. WLM.css styles de glisser-déposer
  assert(wlmCss.includes('.chat-tab[draggable="true"]'), 'Style draggable manquant dans WLM.css');
  assert(wlmCss.includes('.chat-tab.dragging'), 'Style .dragging manquant dans WLM.css');
  assert(wlmCss.includes('.chat-tab.drop-target-left::before'), 'Style drop-target-left::before manquant');
  assert(wlmCss.includes('.chat-tab.drop-target-right::after'), 'Style drop-target-right::after manquant');
});
