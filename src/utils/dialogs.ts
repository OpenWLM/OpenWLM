import { useSyncExternalStore } from 'react';

/**
 * BOÎTES DE DIALOGUE AERO (remplacent alert() / window.confirm() du navigateur)
 *
 * `notify(message)` affiche une petite fenêtre Aero avec OK ; `askConfirm(message)` une
 * fenêtre avec confirmation et Annuler, et renvoie la réponse. Utilisables depuis n'importe
 * quel module (hooks, handlers socket…) : les demandes sont mises en file et affichées une à
 * une par <DialogHost /> (monté une seule fois à la racine, cf. main.tsx).
 */

export interface DialogOptions {
  title?: string;
  icon?: string;
  /** Libellé du bouton principal (par défaut : OK). */
  confirmLabel?: string;
  /** Bouton principal rouge (action destructrice). */
  danger?: boolean;
}

export interface DialogRequest extends DialogOptions {
  id: number;
  kind: 'alert' | 'confirm';
  message: string;
  resolve: (answer: boolean) => void;
}

let queue: DialogRequest[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const push = (request: Omit<DialogRequest, 'id'>) => {
  queue = [...queue, { ...request, id: nextId++ }];
  emit();
};

/** Message d'information ou d'erreur (remplace alert). Se résout à la fermeture. */
export const notify = (message: string, options: DialogOptions = {}): Promise<void> =>
  new Promise((resolve) => push({ kind: 'alert', message, ...options, resolve: () => resolve() }));

/** Demande de confirmation (remplace window.confirm) : true si l'utilisateur confirme. */
export const askConfirm = (message: string, options: DialogOptions = {}): Promise<boolean> =>
  new Promise((resolve) => push({ kind: 'confirm', message, ...options, resolve }));

/** Ferme la boîte affichée avec la réponse donnée et passe à la suivante. */
export const answerDialog = (id: number, answer: boolean) => {
  const current = queue[0];
  if (!current || current.id !== id) return;
  queue = queue.slice(1);
  emit();
  current.resolve(answer);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getCurrent = () => queue[0] ?? null;

/** Boîte à afficher maintenant (la première de la file), ou null. */
export const useCurrentDialog = (): DialogRequest | null => useSyncExternalStore(subscribe, getCurrent, getCurrent);
