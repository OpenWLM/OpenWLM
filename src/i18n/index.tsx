/**
 * OpenWLM - Module d'internationalisation (i18n)
 * Fournit une base réactive et typée pour le support bilingue (Français / Anglais).
 */
import React, { createContext, useContext, useState, useEffect } from 'react';
import fr from './fr.json';
import en from './en.json';

export type Language = 'fr' | 'en';
export type TranslationSchema = typeof fr;

export const translations: Record<Language, TranslationSchema> = {
  fr,
  en
};

/**
 * Détecte la langue préférée de l'utilisateur (stockage local ou navigateur)
 */
export function getInitialLanguage(): Language {
  try {
    const saved = localStorage.getItem('wlm_lang') as Language;
    if (saved === 'fr' || saved === 'en') return saved;
    const navLang = (navigator.language || 'fr').slice(0, 2);
    return navLang === 'fr' ? 'fr' : 'en';
  } catch {
    return 'fr';
  }
}

export interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TranslationSchema;
}

const I18nContext = createContext<I18nContextType>({
  language: 'fr',
  setLanguage: () => {},
  t: fr
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem('wlm_lang', lang);
    } catch {}
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  };

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
    }
  }, [language]);

  const value: I18nContextType = {
    language,
    setLanguage,
    t: translations[language] || translations.fr
  };

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
};

/**
 * Hook principal pour accéder aux traductions et changer la langue
 */
export function useI18n(): I18nContextType {
  return useContext(I18nContext);
}

/**
 * Helper d'accès direct statique
 */
export function useTranslation(lang: Language = 'fr'): TranslationSchema {
  return translations[lang] || translations.fr;
}

export default translations;
