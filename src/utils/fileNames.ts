/**
 * Nom de fichier reçu, affichable sans tromperie : les caractères de contrôle, invisibles et
 * bidirectionnels (U+202E…) sont remplacés par « _ ». Sans cela, « facture » + U+202E +
 * « gnp.exe » s'afficherait « factureexe.png ». Même règle que l'app Android à
 * l'enregistrement (FileNames.java).
 */
export const safeFileName = (name: string | undefined | null): string =>
  (name || '').replace(/[\p{Cc}\p{Cf}]/gu, '_').trim();
