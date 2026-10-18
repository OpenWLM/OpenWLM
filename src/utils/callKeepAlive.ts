/**
 * MAINTIEN D'UN APPEL ÉCRAN ÉTEINT (Android)
 *
 * Sur Android, Chromium (Chrome, Brave…) ne garde une page active écran éteint que si elle
 * joue un « vrai » média : c'est ce qui permet à YouTube de continuer en arrière-plan (lecteur
 * + notification multimédia, adossée à un service de premier plan). L'audio d'un appel WebRTC
 * (élément <audio> alimenté par un MediaStream) n'en bénéficie pas : quelques secondes après
 * l'extinction de l'écran, la page est suspendue et l'appel devient muet.
 *
 * Même principe ici : pendant l'appel, un élément <audio> joue en boucle un fichier quasi
 * silencieux (bruit de ±1 sur 16 bits, environ -90 dB, inaudible) et la Media Session affiche
 * « Conversation audio avec X » dans la notification multimédia. Le bouton pause de cette
 * notification est ignoré (il ne doit pas couper l'appel) ; « raccrocher » est proposé quand
 * le navigateur le gère. Limité à Android : sur iPhone, iOS coupe le micro des pages web écran
 * verrouillé quoi qu'il arrive, et jouer un média pendant l'appel risque d'y perturber le son.
 */

export const callKeepAliveSupported = (): boolean =>
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

// Fichier WAV généré à la volée (8 kHz, 16 bits, mono) : aucun fichier à servir
const makeQuietWav = (seconds: number): Blob => {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  // Pas un silence parfait (zéros) : certains lecteurs le traitent comme « pas de son »
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, (i & 1) ? 1 : -1, true);
  return new Blob([buf], { type: 'audio/wav' });
};

type Handler = MediaSessionActionHandler | null;
const setAction = (action: string, handler: Handler) => {
  try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler); } catch { /* action non gérée */ }
};

/**
 * Démarre le maintien (à appeler une fois l'appel établi ou en cours d'établissement).
 * Renvoie la fonction d'arrêt. Sans effet hors Android.
 */
export const startCallKeepAlive = (opts: { title: string; onHangUp: () => void }): (() => void) => {
  if (!callKeepAliveSupported()) return () => { /* rien à arrêter */ };
  const url = URL.createObjectURL(makeQuietWav(10)); // > 5 s : traité comme un média « durable »
  const audio = new Audio(url);
  audio.loop = true;
  audio.setAttribute('data-testid', 'call-keepalive');
  const play = () => { audio.play().catch(() => { /* lecture refusée : rien de plus à faire */ }); };
  play();

  const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
  if (session) {
    try {
      session.metadata = new MediaMetadata({
        title: opts.title,
        artist: 'OpenWLM',
        artwork: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }]
      });
      session.playbackState = 'playing';
    } catch { /* Media Session indisponible */ }
    setAction('pause', play);
    setAction('play', play);
    setAction('stop', play);
    setAction('hangup', () => opts.onHangUp());
  }

  return () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
    if (session) {
      ['pause', 'play', 'stop', 'hangup'].forEach((a) => setAction(a, null));
      try { session.metadata = null; session.playbackState = 'none'; } catch { /* ignore */ }
    }
  };
};

/**
 * ÉCRAN ALLUMÉ PENDANT LA VIDÉO (API Screen Wake Lock, tous appareils)
 *
 * Écran éteint, la caméra se coupe : tant que de la vidéo circule (la mienne ou celle du
 * correspondant), on demande au système de ne pas mettre l'écran en veille. Le verrou est
 * relâché par le système quand la page passe en arrière-plan : il est redemandé au retour.
 * L'utilisateur peut toujours éteindre l'écran avec le bouton (l'audio continue alors sur
 * Android, cf. ci-dessus). Sans l'API (navigateur ancien), rien ne change.
 */
export const keepScreenOn = (): (() => void) => {
  const wl = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock : undefined;
  if (!wl) return () => { /* API absente */ };
  let stopped = false;
  let sentinel: { release(): Promise<void> } | null = null;
  let pending = false;
  const acquire = () => {
    if (stopped || sentinel || pending || document.visibilityState !== 'visible') return;
    pending = true;
    wl.request('screen').finally(() => { pending = false; }).then((s) => {
      if (stopped) { s.release().catch(() => { /* ignore */ }); return; }
      sentinel = s;
      (s as unknown as EventTarget).addEventListener?.('release', () => { if (sentinel === s) sentinel = null; });
    }).catch(() => { /* refusé (batterie faible…) : l'écran suivra le délai du système */ });
  };
  const onVisible = () => acquire();
  document.addEventListener('visibilitychange', onVisible);
  acquire();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    sentinel?.release().catch(() => { /* ignore */ });
    sentinel = null;
  };
};
