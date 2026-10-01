/**
 * Gestionnaire de sons pour l'application
 * Centralise le chargement et la reproduction des effets sonores MSN/WLM.
 */

const SOUND_PATHS: Record<string, string> = {
  ONLINE: '/assets/sounds/online.mp3',
  NUDGE: '/assets/sounds/nudge.mp3',
  NEW_MESSAGE: '/assets/sounds/type.mp3',
  OUTGOING: '/assets/sounds/outgoing.mp3',
  TYPING: '/assets/sounds/type.mp3',
  KISS: '/assets/sounds/Kiss.mp3',
  ALIEN: '/assets/sounds/alien.mp3',
  GONG: '/assets/sounds/gong.mp3',
  GUITAR_SMASH: '/assets/sounds/electric_guitar.mp3',
  BOUNCY_BALL: '/assets/sounds/nudge.mp3',
  KNOCK: '/assets/sounds/nudge.mp3',
};

class SoundManager {
  private static instance: SoundManager;
  private audioUnlocked = false;

  private constructor() {
    // Débloque l'audio sur la première interaction de l'utilisateur (Autoplay Policy)
    if (typeof window !== 'undefined') {
      const unlock = () => {
        if (this.audioUnlocked) return;
        this.audioUnlocked = true;
        try {
          const silentAudio = new Audio();
          silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          silentAudio.play().catch(() => {});
        } catch {}
        window.removeEventListener('click', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('touchstart', unlock);
      };
      window.addEventListener('click', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
      window.addEventListener('touchstart', unlock, { once: true });
    }
  }

  /**
   * Récupère l'instance unique (Singleton) du SoundManager
   */
  public static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  /**
   * Joue un son à partir d'une clé ou d'un nom de fichier
   * @param soundKey La clé du son (ex: 'ONLINE') ou le nom du fichier sans extension
   */
  public play(soundKey: string) {
    const key = soundKey.toUpperCase();
    const path = SOUND_PATHS[key] || `/assets/sounds/${soundKey}.mp3`;
    
    console.log(`[SoundManager] Reproduction : ${key} (${path})`);

    try {
      // Instancier un nouvel objet Audio pour éviter les conflits d'état ou coupures
      const audio = new Audio(path);
      audio.volume = 1.0;
      
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn(`[SoundManager] Lecture bloquée ou échec (${key}) :`, error);
        });
      }
    } catch (e) {
      console.error(`[SoundManager] Erreur critique lors de la lecture du son :`, e);
    }
  }
}

export default SoundManager.getInstance();
