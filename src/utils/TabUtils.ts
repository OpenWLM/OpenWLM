/**
 * TabUtils.ts - OpenWLM
 * Logique pure et immuable de réorganisation et de validation des onglets de conversation.
 */

/**
 * Réorganise un tableau d'identifiants d'onglets de discussion lors d'un glisser-déposer.
 * 
 * @param tabs - Tableau actuel des identifiants d'onglets ouverts
 * @param draggedId - Identifiant de l'onglet déplacé
 * @param targetId - Identifiant de l'onglet cible sous le curseur
 * @param position - 'left' pour insérer avant la cible, 'right' pour insérer après
 * @returns Nouveau tableau réordonné sans mutation de l'original
 */
export function reorderChatTabs(
  tabs: number[],
  draggedId: number,
  targetId: number,
  position: 'left' | 'right'
): number[] {
  if (!Array.isArray(tabs) || tabs.length <= 1) return tabs;
  if (draggedId === targetId) return tabs;

  const fromIndex = tabs.indexOf(draggedId);
  if (fromIndex === -1) return tabs;

  // Création d'une copie immuable et extraction de l'élément déplacé
  const updated = [...tabs];
  const [moved] = updated.splice(fromIndex, 1);

  // Recherche de l'index cible dans le tableau réduit
  let targetIndex = updated.indexOf(targetId);
  if (targetIndex === -1) return tabs;

  if (position === 'right') {
    targetIndex += 1;
  }

  updated.splice(targetIndex, 0, moved);
  return updated;
}

/**
 * Assainit la liste des onglets ouverts en supprimant les identifiants orphelins
 * (contacts supprimés ou inexistants), tout en préservant le bot système et l'ordre établi.
 * 
 * @param openIds - Tableau des identifiants stockés dans localStorage
 * @param validContactIds - Tableau des identifiants des contacts actuellement valides
 * @param systemBotId - Identifiant réservé pour le bot de test WLM (défaut : -1)
 * @returns Tableau assaini ne contenant que des conversations valides
 */
export function sanitizeOpenChatIds(
  openIds: number[],
  validContactIds: number[],
  systemBotId: number = -1
): number[] {
  if (!Array.isArray(openIds)) return [];
  const contactSet = new Set(validContactIds);
  return openIds.filter(id => id === systemBotId || contactSet.has(id));
}
