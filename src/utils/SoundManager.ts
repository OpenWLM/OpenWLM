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
  private audioCache: Map<string, HTMLAudioElement> = new Map();

  private constructor() {}

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
      // On tente de réutiliser l'élément Audio s'il est déjà en cache
      let audio = this.audioCache.get(path);
      
      if (!audio) {
        audio = new Audio(path);
        this.audioCache.set(path, audio);
      }
      
      // Réinitialiser le curseur de lecture pour permettre une répétition immédiate
      audio.currentTime = 0;
      
      const playPromise = audio.play();
      
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          // Les navigateurs bloquent souvent la lecture automatique sans interaction utilisateur préalable
          console.warn(`[SoundManager] Lecture bloquée ou échec :`, error);
        });
      }
    } catch (e) {
      console.error(`[SoundManager] Erreur critique lors de la lecture du son :`, e);
    }
  }
}

export default SoundManager.getInstance();
