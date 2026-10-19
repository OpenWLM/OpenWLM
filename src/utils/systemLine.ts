import type { Message } from '../types';

/**
 * Ligne système locale (mode privé activé, Wizz, clin d'œil…). Repérée par le drapeau
 * `system` — et non plus par l'expéditeur « Système », qui restait en français dans
 * l'interface anglaise. Le texte est déjà traduit par l'appelant.
 */
export const systemLine = (text: string, extra: Partial<Message> = {}): Message => ({
  sender: '',
  text,
  system: true,
  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  ...extra
});

/** Une ligne est-elle une ligne système ? (« Système » : anciennes lignes encore en mémoire) */
export const isSystemLine = (m: Pick<Message, 'system' | 'sender'>): boolean => m.system === true || m.sender === 'Système';
