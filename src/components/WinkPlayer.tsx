import React, { useEffect, useRef } from 'react';

/**
 * Lecteur de Clins d'œil (Winks) MSN — joue les .swf ORIGINAUX de WLM 2009 via Ruffle
 * (émulateur Flash WebAssembly, self-hosted dans /public/ruffle, chargé à la demande).
 *
 * WINK_META = taille native (px) + durée (s) de chaque SWF (parsés depuis les fichiers d'origine),
 * pour : dimensionner le player à la taille du clip (pas plein écran) et laisser l'animation
 * se terminer (pas de coupure).
 */
interface WinkPlayerProps {
  winkId: string;
  onFinish: () => void;
}

const RUFFLE_SCRIPT = '/ruffle/ruffle.js';
const swfUrl = (id: string) => `/assets/winks/${id}/${id}.swf`;

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

const loadRuffle = () => new Promise<void>((resolve, reject) => {
  const w = window as unknown as { RufflePlayer?: unknown };
  if (w.RufflePlayer) return resolve();
  const existing = document.querySelector('script[data-ruffle]');
  if (existing) {
    existing.addEventListener('load', () => resolve());
    existing.addEventListener('error', () => reject(new Error('Ruffle load error')));
    return;
  }
  const s = document.createElement('script');
  s.src = RUFFLE_SCRIPT;
  s.async = true;
  s.setAttribute('data-ruffle', '1');
  s.onload = () => resolve();
  s.onerror = () => reject(new Error('Ruffle load error'));
  document.head.appendChild(s);
});

const WinkPlayer: React.FC<WinkPlayerProps> = ({ winkId, onFinish }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let playerEl: any = null;
    const meta = WINK_META[winkId];

    (async () => {
      try {
        await loadRuffle();
        if (cancelled || !containerRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const RufflePlayer = (window as any).RufflePlayer;
        if (!RufflePlayer || typeof RufflePlayer.newest !== 'function') return;
        const ruffle = RufflePlayer.newest();
        playerEl = ruffle.createPlayer();
        // Taille native du clip (pas plein écran) + fond transparent
        if (meta) {
          playerEl.style.width = `${meta.w}px`;
          playerEl.style.height = `${meta.h}px`;
        }
        playerEl.style.background = 'transparent';
        try { playerEl.setAttribute('wmode', 'transparent'); } catch { /* ignore */ }
        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(playerEl);
        playerEl.ruffle().load(swfUrl(winkId));
      } catch (e) {
        console.warn('[Wink] Ruffle indisponible:', e);
      }
    })();

    // Laisser l'animation se TERMINER (durée du SWF + marge) ; clic pour fermer avant.
    const durationMs = (meta ? meta.d : 8) * 1000 + 600;
    const timer = setTimeout(() => { if (!cancelled) onFinish(); }, durationMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      try { if (playerEl) playerEl.remove(); } catch { /* ignore */ }
    };
  }, [winkId, onFinish]);

  return (
    <div className="wink-overlay" onClick={onFinish} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
      <div className="wink-canvas" ref={containerRef} />
    </div>
  );
};

export default WinkPlayer;
