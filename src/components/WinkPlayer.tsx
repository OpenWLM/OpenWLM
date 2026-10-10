import React, { useEffect } from 'react';
import SoundManager from '../utils/SoundManager';
import Synthesis from '../utils/Synthesis';

/**
 * Lecteur de Clins d'œil (Winks) MSN.
 * Joue les animations pré-rendues depuis les .swf ORIGINAUX de WLM 2009 (WebP animé — léger,
 * natif, sans émulateur Flash au runtime) + le son côté client (les SWF n'ont pas d'audio).
 */
interface WinkPlayerProps {
  winkId: string;
  onFinish: () => void;
}

// Taille native + durée (s) de chaque clip (parsées depuis les .swf d'origine)
const WINK_META: Record<string, { w: number; h: number; d: number }> = {
  bouncy_ball: { w: 640, h: 480, d: 7.3 },
  bow: { w: 640, h: 480, d: 11.3 },
  dancing_pig: { w: 640, h: 480, d: 11.3 },
  eyeball: { w: 550, h: 450, d: 5.7 },
  frog: { w: 640, h: 480, d: 9.8 },
  guitar_smash: { w: 150, h: 125, d: 6.8 },
  heart: { w: 125, h: 118, d: 6.2 },
  kiss: { w: 160, h: 120, d: 6.8 },
  knock: { w: 325, h: 260, d: 2.4 },
  lipstick_girl: { w: 640, h: 480, d: 9.2 },
  love_letter: { w: 190, h: 400, d: 8.0 },
  notes: { w: 400, h: 350, d: 8.7 },
  silly_face: { w: 225, h: 400, d: 7.7 },
  stars: { w: 450, h: 425, d: 6.5 },
  water_balloon: { w: 640, h: 480, d: 7.7 }
};

// Sons MSN par clin d'œil (le son vient du client, comme dans l'original)
const WINK_SOUND: Record<string, string> = {
  kiss: 'KISS',
  guitar_smash: 'GUITAR_SMASH',
  bouncy_ball: 'BOUNCY_BALL',
  knock: 'KNOCK'
};

const WinkPlayer: React.FC<WinkPlayerProps> = ({ winkId, onFinish }) => {
  const meta = WINK_META[winkId];

  useEffect(() => {
    // Son
    try {
      if (winkId === 'frog') {
        setTimeout(() => { try { Synthesis.playCatch(); } catch { /* ignore */ } }, 1800);
        setTimeout(() => { try { Synthesis.playBurp(); } catch { /* ignore */ } }, 2500);
      } else {
        SoundManager.play(WINK_SOUND[winkId] || 'ONLINE');
      }
    } catch { /* ignore */ }

    // Laisser l'animation se terminer exactement à la durée du clip (clic pour fermer avant)
    const timer = setTimeout(() => onFinish(), (meta ? meta.d : 8) * 1000 + 400);
    return () => clearTimeout(timer);
  }, [winkId, onFinish, meta]);

  return (
    <div className="wink-overlay" onClick={onFinish} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
      <div className="wink-canvas">
        <img
          src={`/assets/winks/${winkId}/${winkId}.webp`}
          alt={`Clin d'œil ${winkId}`}
          style={{ width: meta?.w ? `${meta.w}px` : undefined, height: meta?.h ? `${meta.h}px` : undefined }}
          draggable={false}
        />
      </div>
    </div>
  );
};

export default WinkPlayer;
