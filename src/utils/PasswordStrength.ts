/**
 * Module d'évaluation de robustesse et de conformité des mots de passe / passphrases pour OpenWLM.
 * 
 * Politique de sécurité OpenWLM :
 * - Règle dure (Conformité) : longueur >= 12 caractères (bloquant pour la soumission).
 * - Recommandation : 15 caractères ou plus.
 * - Passphrases multi-mots avec espaces expressément encouragées.
 * - Aucune obligation artificielle de caractères spéciaux / majuscules / chiffres.
 * - Calcul 100% local, immédiat et sans dépendance externe lourde.
 */

export type PasswordStrengthLevel = 'weak' | 'fair' | 'good' | 'excellent';

export interface PasswordEvaluation {
  length: number;
  isConformant: boolean;
  isRecommendedLength: boolean;
  hasSpaces: boolean;
  wordCount: number;
  score: number; // 0 (non conforme / vide) à 4 (très robuste / excellent)
  strengthLevel: PasswordStrengthLevel;
}

export function evaluatePassword(password: string): PasswordEvaluation {
  const len = password.length;
  const isConformant = len >= 12;
  const isRecommendedLength = len >= 15;
  const hasSpaces = /\s/.test(password);

  // Comptage des mots significatifs (au moins 2 lettres) pour les passphrases
  const words = password.trim().split(/\s+/).filter(w => w.length >= 2);
  const wordCount = words.length;

  if (len === 0) {
    return {
      length: 0,
      isConformant: false,
      isRecommendedLength: false,
      hasSpaces: false,
      wordCount: 0,
      score: 0,
      strengthLevel: 'weak'
    };
  }

  // En dessous du seuil dur de 12 caractères
  if (!isConformant) {
    return {
      length: len,
      isConformant: false,
      isRecommendedLength: false,
      hasSpaces,
      wordCount,
      score: len >= 8 ? 1 : 0,
      strengthLevel: 'weak'
    };
  }

  // Calcul du score pour les mots de passe conformes (>= 12 caractères)
  let points = 1; // Base de départ pour conformité atteinte

  // 1. Bonus de longueur
  if (len >= 20) {
    points += 2;
  } else if (len >= 15) {
    points += 1;
  }

  // 2. Bonus passphrase (mots séparés par espaces)
  if (wordCount >= 4 && len >= 16) {
    points += 2;
  } else if (wordCount >= 3 && len >= 14) {
    points += 1;
  }

  // 3. Diversité des jeux de caractères (valorisée, mais non obligatoire)
  let variety = 0;
  if (/[a-z]/.test(password)) variety++;
  if (/[A-Z]/.test(password)) variety++;
  if (/\d/.test(password)) variety++;
  if (/[^a-zA-Z0-9\s]/.test(password)) variety++;

  if (variety >= 3) points += 1;
  if (variety >= 4) points += 1;

  // 4. Pénalités de faible entropie
  // Répétitions directes de 3+ fois le même caractère (ex: "aaa")
  if (/(.)\1{2,}/.test(password)) {
    points -= 1;
  }

  // Diversité globale très pauvre (ex: "111111111111" ou "abababababab")
  const uniqueChars = new Set(password.toLowerCase()).size;
  if (uniqueChars <= 3) {
    points = 1; // Plafonné à Faible
  } else if (uniqueChars / len < 0.35) {
    points -= 1;
  }

  // Séquences ou mots évidents
  const lower = password.toLowerCase();
  const obviousPatterns = [
    '123456', '234567', '345678', '456789', '567890',
    'abcdef', 'qwerty', 'azerty', 'password', 'motdepasse', 'admin123'
  ];
  for (const pat of obviousPatterns) {
    if (lower.includes(pat)) {
      points -= 1;
      break;
    }
  }

  const finalScore = Math.max(1, Math.min(4, points));
  let strengthLevel: PasswordStrengthLevel = 'weak';
  if (finalScore === 2) strengthLevel = 'fair';
  else if (finalScore === 3) strengthLevel = 'good';
  else if (finalScore === 4) strengthLevel = 'excellent';

  return {
    length: len,
    isConformant: true,
    isRecommendedLength,
    hasSpaces,
    wordCount,
    score: finalScore,
    strengthLevel
  };
}
