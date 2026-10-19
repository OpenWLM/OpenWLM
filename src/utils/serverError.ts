import type { Language, TranslationSchema } from '../i18n';

/**
 * Texte d'erreur à afficher pour une réponse d'erreur du serveur.
 *
 * Le serveur répond en français (`error`) et, pour les erreurs courantes, avec un code
 * (`code`) que l'app traduit (`t.errors`). Sans code connu : 429 → « trop de tentatives » ;
 * interface française → le texte du serveur ; sinon le message de repli, déjà traduit.
 */
type ErrorLike = { response?: { status?: number; data?: { error?: string; code?: string } } } | null | undefined;

export const serverErrorText = (err: unknown, t: TranslationSchema, language: Language, fallback: string): string => {
  const response = (err as ErrorLike)?.response;
  return serverErrorFromResponse(response?.status, response?.data, t, language, fallback);
};

/** Même logique pour une réponse `fetch` (statut + corps JSON déjà lus). */
export const serverErrorFromResponse = (
  status: number | undefined,
  data: { error?: string; code?: string } | undefined,
  t: TranslationSchema,
  language: Language,
  fallback: string
): string => {
  const code = data?.code;
  if (code && code in t.errors) return t.errors[code as keyof TranslationSchema['errors']];
  if (status === 429) return t.errors.rate_limited;
  if (language === 'fr' && data?.error) return data.error;
  return fallback;
};
