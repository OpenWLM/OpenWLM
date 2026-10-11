import React, { useEffect, useRef, useState } from 'react';

/**
 * Lecteur de Clins d'œil (Winks) MSN.
 * Joue l'animation pré-rendue depuis les .swf ORIGINAUX de WLM 2009 (WebP animé) + le SON
 * ORIGINAL (extrait du SWF via Ruffle, capturé en WebM) — synchronisés.
 */
interface WinkPlayerProps {
  winkId: string;
  onFinish: () => void;
}

// Taille native + décalage audio (ms) + durée totale de l'anim WebP (ms), mesurés au pré-rendu.
// `a` = offset entre le début d'enregistrement du son et le début de capture des frames : on
// saute ce silence initial pour que le son tombe pile sur l'animation.
// `t` = durée exacte du WebP → on ferme l'overlay pile à la fin (pas de redémarrage visible).
const WINK_META: Record<string, { w: number; h: number; a: number; t: number }> = {
  bouncy_ball: { w: 640, h: 480, a: 129, t: 7221 },
  bow: { w: 640, h: 480, a: 29, t: 11288 },
  dancing_pig: { w: 640, h: 480, a: 26, t: 11205 },
  eyeball: { w: 550, h: 450, a: 32, t: 5712 },
  frog: { w: 640, h: 480, a: 33, t: 9711 },
  guitar_smash: { w: 150, h: 125, a: 17, t: 6723 },
  heart: { w: 125, h: 118, a: 36, t: 6237 },
  kiss: { w: 160, h: 120, a: 25, t: 6723 },
  knock: { w: 325, h: 260, a: 32, t: 2436 },
  lipstick_girl: { w: 640, h: 480, a: 19, t: 9130 },
  love_letter: { w: 190, h: 400, a: 26, t: 8000 },
  notes: { w: 400, h: 350, a: 27, t: 8736 },
  silly_face: { w: 225, h: 400, a: 22, t: 7784 },
  stars: { w: 450, h: 425, a: 24, t: 6474 },
  water_balloon: { w: 640, h: 480, a: 31, t: 7636 }
};

// Contexte audio partagé (sert uniquement à mesurer la latence de sortie du device).
let sharedCtx: AudioContext | null = null;
function outputLatencySec(): number {
  try {
    const AC: typeof AudioContext | undefined = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return 0.06;
    if (!sharedCtx) sharedCtx = new AC();
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => { /* geste requis */ });
    const l = (sharedCtx as AudioContext & { outputLatency?: number }).outputLatency || sharedCtx.baseLatency || 0.06;
    return Math.min(0.5, Math.max(0, l));
  } catch { return 0.06; }
}

const WinkPlayer: React.FC<WinkPlayerProps> = ({ winkId, onFinish }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const meta = WINK_META[winkId];
  // L'anim ne démarre qu'après la latence de sortie audio → son et image tombent ensemble
  // quel que soit l'appareil (la latence est bien plus élevée sur mobile).
  const [started, setStarted] = useState(false);
  // Nonce unique par montage : force le navigateur à (re)démarrer l'animation WebP
  // depuis la frame 0 à chaque lancement (sinon la phase dérive vs le son).
  const [nonce] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const latency = outputLatencySec();
    // Son ORIGINAL (extrait du SWF) : on saute le silence initial (décal) pour caler le son
    // exactement sur l'animation, puis on démarre tout de suite.
    const a = audioRef.current;
    if (a) {
      try {
        a.currentTime = (meta?.a ?? 0) / 1000;
        a.play().catch(() => { /* autoplay bloqué */ });
      } catch { /* ignore */ }
    }
    // Démarre l'animation quand le son atteint réellement les haut-parleurs.
    const t = setTimeout(() => setStarted(true), Math.round(latency * 1000));
    // Fermer pile à la fin de l'anim WebP (qui démarre après `latency`) — clic pour fermer avant
    const timer = setTimeout(() => onFinish(), (meta?.t ?? 8000) + Math.round(latency * 1000) + 80);
    return () => { clearTimeout(t); clearTimeout(timer); };
  }, [winkId, onFinish, meta]);

  return (
    <div className="wink-overlay" onClick={onFinish} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
      <div className="wink-canvas">
        {started && (
          <img
            src={`/assets/winks/${winkId}/${winkId}.webp?n=${nonce}`}
            alt={`Clin d'œil ${winkId}`}
            style={{ width: meta?.w ? `${meta.w}px` : undefined, height: meta?.h ? `${meta.h}px` : undefined }}
            draggable={false}
          />
        )}
        <audio ref={audioRef} src={`/assets/winks/${winkId}/${winkId}.webm`} preload="auto" />
      </div>
    </div>
  );
};

export default WinkPlayer;
