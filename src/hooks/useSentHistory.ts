import { useCallback, useRef } from 'react';

/**
 * RAPPEL DES MESSAGES ENVOYÉS (Ctrl+↑ / Ctrl+↓)
 *
 * Les 50 dernières saisies envoyées (messages et commandes), en mémoire seulement, pour toute
 * la session. Ctrl+↑ remonte, Ctrl+↓ redescend et, après la plus récente, rend le brouillon
 * qui était en cours de frappe.
 */

const MAX_ENTRIES = 50;

export const useSentHistory = () => {
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef<number | null>(null);
  const draftRef = useRef('');

  /** À appeler à chaque envoi (même une commande). */
  const remember = useCallback((text: string) => {
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== text) hist.push(text);
    if (hist.length > MAX_ENTRIES) hist.shift();
    indexRef.current = null;
  }, []);

  /**
   * Remonte (-1) ou redescend (+1) dans l'historique. `currentText` est la saisie en cours
   * (gardée comme brouillon au premier Ctrl+↑) ; `apply` remplit le champ.
   */
  const recall = useCallback((direction: -1 | 1, currentText: string, apply: (text: string) => void) => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    let idx = indexRef.current;
    if (idx === null) {
      if (direction === 1) return;
      draftRef.current = currentText;
      idx = hist.length - 1;
    } else {
      idx += direction;
    }
    if (idx < 0) idx = 0;
    if (idx >= hist.length) {
      indexRef.current = null;
      apply(draftRef.current);
      return;
    }
    indexRef.current = idx;
    apply(hist[idx]);
  }, []);

  return { remember, recall };
};
