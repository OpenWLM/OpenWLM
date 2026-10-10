import React, { useEffect, useRef } from 'react';

/**
 * Lecteur de Clins d'œil (Winks) MSN.
 * Joue l'animation pré-rendue depuis les .swf ORIGINAUX de WLM 2009 (WebP animé) + le SON
 * ORIGINAL (extrait du SWF via Ruffle, capturé en WebM) — synchronisés.
 */
interface WinkPlayerProps {
  winkId: string;
  onFinish: () => void;
}

// Taille native + durée (s) + décalage audio (ms) de chaque clip (parsés depuis les .swf d'origine).
// `a` = offset entre le début d'enregistrement du son et le début de capture des frames : on
// saute ce silence initial pour que le son tombe pile sur l'animation.
const WINK_META: Record<string, { w: number; h: number; d: number; a: number }> = {
  bouncy_ball: { w: 640, h: 480, d: 7.3, a: 261 },
  bow: { w: 640, h: 480, d: 11.3, a: 182 },
  dancing_pig: { w: 640, h: 480, d: 11.3, a: 170 },
  eyeball: { w: 550, h: 450, d: 5.7, a: 174 },
  frog: { w: 640, h: 480, d: 9.8, a: 175 },
  guitar_smash: { w: 150, h: 125, d: 6.8, a: 167 },
  heart: { w: 125, h: 118, d: 6.2, a: 165 },
  kiss: { w: 160, h: 120, d: 6.8, a: 165 },
  knock: { w: 325, h: 260, d: 2.4, a: 174 },
  lipstick_girl: { w: 640, h: 480, d: 9.2, a: 166 },
  love_letter: { w: 190, h: 400, d: 8.0, a: 167 },
  notes: { w: 400, h: 350, d: 8.7, a: 173 },
  silly_face: { w: 225, h: 400, d: 7.7, a: 181 },
  stars: { w: 450, h: 425, d: 6.5, a: 166 },
  water_balloon: { w: 640, h: 480, d: 7.7, a: 191 }
};

const WinkPlayer: React.FC<WinkPlayerProps> = ({ winkId, onFinish }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const meta = WINK_META[winkId];
  // Nonce unique par montage : force le navigateur à (re)démarrer l'animation WebP
  // depuis la frame 0 à chaque lancement (sinon la phase dérive vs le son).
  const nonce = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    // Son ORIGINAL (extrait du SWF) : on saute le silence initial (décal) pour caler le son
    // exactement sur l'animation, puis on démarre.
    const a = audioRef.current;
    if (a) {
      try {
        a.currentTime = (meta?.a ?? 0) / 1000;
        a.play().catch(() => { /* autoplay bloqué */ });
      } catch { /* ignore */ }
    }
    // Laisser l'animation se terminer exactement à la durée du clip (clic pour fermer avant)
    const timer = setTimeout(() => onFinish(), (meta ? meta.d : 8) * 1000 + 400);
    return () => clearTimeout(timer);
  }, [winkId, onFinish, meta]);

  return (
    <div className="wink-overlay" onClick={onFinish} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
      <div className="wink-canvas">
        <img
          src={`/assets/winks/${winkId}/${winkId}.webp?n=${nonce.current}`}
          alt={`Clin d'œil ${winkId}`}
          style={{ width: meta?.w ? `${meta.w}px` : undefined, height: meta?.h ? `${meta.h}px` : undefined }}
          draggable={false}
        />
        <audio ref={audioRef} src={`/assets/winks/${winkId}/${winkId}.webm`} preload="auto" />
      </div>
    </div>
  );
};

export default WinkPlayer;
