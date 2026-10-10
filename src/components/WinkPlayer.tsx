import React, { useEffect, useRef } from 'react';

/**
 * Lecteur de Clins d'œil (Winks) MSN.
 * Joue les fichiers .swf ORIGINAUX de WLM 2009 via Ruffle (émulateur Flash WebAssembly,
 * self-hosted dans /public/ruffle). Chargé à la demande (uniquement quand un wink est joué).
 */
interface WinkPlayerProps {
  winkId: string;
  onFinish: () => void;
}

const RUFFLE_SCRIPT = '/ruffle/ruffle.js';
const swfUrl = (id: string) => `/assets/winks/${id}/${id}.swf`;

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

    (async () => {
      try {
        await loadRuffle();
        if (cancelled || !containerRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const RufflePlayer = (window as any).RufflePlayer;
        if (!RufflePlayer || typeof RufflePlayer.newest !== 'function') return;
        const ruffle = RufflePlayer.newest();
        playerEl = ruffle.createPlayer();
        playerEl.style.width = '100%';
        playerEl.style.height = '100%';
        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(playerEl);
        playerEl.ruffle().load(swfUrl(winkId));
      } catch (e) {
        console.warn('[Wink] Ruffle indisponible:', e);
      }
    })();

    // Durée de vie de l'overlay (les winks durent quelques secondes)
    const timer = setTimeout(() => { if (!cancelled) onFinish(); }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      try { if (playerEl) playerEl.remove(); } catch { /* ignore */ }
    };
  }, [winkId, onFinish]);

  return (
    <div className="wink-overlay" onClick={onFinish}>
      <div className="wink-canvas" ref={containerRef} />
    </div>
  );
};

export default WinkPlayer;
