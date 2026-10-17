/**
 * INACTIVITÉ DE TOUT L'ORDINATEUR — API Idle Detection
 * (https://developer.mozilla.org/docs/Web/API/Idle_Detection_API)
 *
 * Sans cette API, OpenWLM ne voit que l'activité dans sa propre page : quelqu'un qui travaille
 * dans une autre application passe « Absent » au bout du délai. Avec elle (opt-in), comme sur
 * MSN, c'est l'inactivité du système (clavier/souris dans n'importe quelle application) et le
 * verrouillage de l'écran qui comptent.
 *
 * Disponibilité : navigateurs Chromium de bureau (Chrome, Edge, Opera, Electron) ; ni Firefox
 * ni Safari. Contexte sécurisé (HTTPS) requis, et une permission explicite de l'utilisateur
 * (`idle-detection`), demandée uniquement lors d'un clic. Seuls deux états sont exposés au site
 * (actif / inactif, écran verrouillé ou non) : aucune information sur les autres applications.
 */

export type SystemIdleSupport = 'unsupported' | 'insecure' | 'available';
export type SystemIdlePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

interface IdleDetectorLike extends EventTarget {
  userState: 'active' | 'idle' | null;
  screenState: 'locked' | 'unlocked' | null;
  start(options: { threshold: number; signal?: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<'granted' | 'denied'>;
}

/** Seuil minimal imposé par l'API (60 s). */
export const SYSTEM_IDLE_MIN_THRESHOLD_MS = 60_000;

const getCtor = (): IdleDetectorCtor | null =>
  (typeof window !== 'undefined' && (window as unknown as { IdleDetector?: IdleDetectorCtor }).IdleDetector) || null;

export const getSystemIdleSupport = (): SystemIdleSupport => {
  if (!getCtor()) return 'unsupported';
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
  return 'available';
};

/** État de la permission sans rien demander (permet de reprendre la détection au démarrage). */
export const querySystemIdlePermission = async (): Promise<SystemIdlePermission> => {
  try {
    const status = await navigator.permissions.query({ name: 'idle-detection' as PermissionName });
    return status.state as SystemIdlePermission;
  } catch {
    return 'unknown';
  }
};

/** Demande la permission. DOIT être appelé depuis un geste de l'utilisateur (clic). */
export const requestSystemIdlePermission = async (): Promise<SystemIdlePermission> => {
  const Ctor = getCtor();
  if (!Ctor) return 'denied';
  try {
    return await Ctor.requestPermission();
  } catch {
    return 'denied';
  }
};

/**
 * Démarre la surveillance. `onChange(idle)` reçoit true quand l'utilisateur est inactif depuis
 * `thresholdMs` OU que l'écran est verrouillé, false dès qu'il redevient actif.
 * Renvoie une fonction d'arrêt, ou null si la détection n'a pas pu démarrer.
 */
export const startSystemIdleDetection = async (
  thresholdMs: number,
  onChange: (idle: boolean) => void
): Promise<(() => void) | null> => {
  const Ctor = getCtor();
  if (!Ctor) return null;
  const controller = new AbortController();
  try {
    const detector = new Ctor();
    detector.addEventListener('change', () => {
      onChange(detector.userState === 'idle' || detector.screenState === 'locked');
    });
    await detector.start({ threshold: Math.max(SYSTEM_IDLE_MIN_THRESHOLD_MS, thresholdMs), signal: controller.signal });
    return () => controller.abort();
  } catch {
    controller.abort();
    return null;
  }
};
