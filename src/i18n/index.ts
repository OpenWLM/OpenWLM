/**
 * OpenWLM - Module d'internationalisation (i18n)
 * Fournit une base typée pour supporter l'anglais et le français.
 */
import fr from './fr.json';
import en from './en.json';

export type Language = 'fr' | 'en';
export type TranslationSchema = typeof fr;

export const translations: Record<Language, TranslationSchema> = {
  fr,
  en
};

/**
 * Détecte la langue préférée de l'utilisateur (navigateur ou stockage local)
 */
export function getInitialLanguage(): Language {
  const saved = localStorage.getItem('wlm_lang') as Language;
  if (saved === 'fr' || saved === 'en') return saved;
  const navLang = navigator.language.slice(0, 2);
  return navLang === 'fr' ? 'fr' : 'en';
}

/**
 * Helper d'accès aux traductions
 */
export function useTranslation(lang: Language = 'fr'): TranslationSchema {
  return translations[lang] || translations.fr;
}

export default translations;
