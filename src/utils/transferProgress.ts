/**
 * Mesure d'un transfert de fichier (envoi ou réception) : débit lissé et temps restant.
 * Le débit est calculé sur une fenêtre glissante de quelques secondes : assez court pour suivre
 * une connexion qui change, assez long pour que l'affichage ne saute pas à chaque paquet.
 */

export interface TransferProgressState {
  loaded: number;
  /** Taille totale ; 0 tant qu'elle n'est pas connue. */
  total: number;
  /** Octets par seconde ; null tant qu'il n'y a pas assez de mesures. */
  rate: number | null;
}

type Sample = { at: number; loaded: number };

/** Renvoie une fonction qui reçoit les octets transférés et rend le débit lissé (o/s). */
export const createSpeedMeter = (windowMs = 3000) => {
  const samples: Sample[] = [];
  return (loaded: number, at: number = performance.now()): number | null => {
    samples.push({ at, loaded });
    while (samples.length > 2 && at - samples[0].at > windowMs) samples.shift();
    const first = samples[0];
    const elapsed = (at - first.at) / 1000;
    if (elapsed < 0.25) return null;
    return Math.max(0, (loaded - first.loaded) / elapsed);
  };
};

export const formatBytes = (bytes: number, lang: 'fr' | 'en' = 'fr'): string => {
  const byteUnit = lang === 'en' ? 'B' : 'o';
  const kbUnit = lang === 'en' ? 'KB' : 'Ko';
  const mbUnit = lang === 'en' ? 'MB' : 'Mo';
  const fmt = (n: number) => n.toLocaleString(lang === 'en' ? 'en-US' : 'fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  if (!bytes || bytes <= 0) return `0 ${byteUnit}`;
  if (bytes < 1024) return `${Math.round(bytes)} ${byteUnit}`;
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} ${kbUnit}`;
  return `${fmt(bytes / (1024 * 1024))} ${mbUnit}`;
};

export const formatSpeed = (bytesPerSecond: number, lang: 'fr' | 'en' = 'fr'): string =>
  `${formatBytes(bytesPerSecond, lang)}/s`;

/** « 45 s », « 2 min 05 s », « 1 h 03 min ». */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
};

/** Pourcentage entier borné (0 si la taille totale est inconnue). */
export const progressPercent = ({ loaded, total }: { loaded: number; total: number }): number =>
  total > 0 ? Math.min(100, Math.max(0, Math.floor((loaded * 100) / total))) : 0;

/** Secondes restantes, ou null si le débit n'est pas encore connu. */
export const remainingSeconds = ({ loaded, total, rate }: TransferProgressState): number | null =>
  rate && rate > 0 && total > 0 ? Math.max(0, (total - loaded) / rate) : null;
