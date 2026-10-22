import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Visionneuse d'image plein écran (images reçues ou envoyées) : lisible même pour une grande
 * capture d'écran, sur ordinateur comme sur téléphone.
 * - Zoom : molette (centrée sur le pointeur), pincement à deux doigts, double-clic /
 *   double-tap (bascule « ajusté » ↔ taille réelle, sur le point visé), boutons − Ajuster 100 % +,
 *   clavier (+, -, 0 ajuster, 1 taille réelle).
 * - Déplacement de l'image zoomée à la souris ou au doigt (Pointer Events : souris, stylet,
 *   toucher). L'image n'est jamais perdue hors de l'écran.
 * - Fermeture : ✕, Échap, ou bouton Retour (Android / navigateur) via l'historique.
 * Le pincement de la page reste désactivé ailleurs (meta viewport) : le zoom est géré ici.
 */

interface ImageViewerProps {
  src: string;
  title: string;
  onClose: () => void;
  onSave?: () => void;
}

interface View { s: number; tx: number; ty: number }

const MAX_SCALE = 8;
const DOUBLE_TAP_MS = 300;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const ImageViewer: React.FC<ImageViewerProps> = ({ src, title, onClose, onSave }) => {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Vue choisie par l'utilisateur ; null = « ajustée » (suit la taille de la zone d'affichage)
  const [userView, setUserView] = useState<View | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // Échelle « ajustée » : l'image entière visible, jamais agrandie au-delà de sa taille réelle
  const fit = natural && box.w > 0 && box.h > 0 ? Math.min(box.w / natural.w, box.h / natural.h, 1) : 1;
  const minScale = fit;
  const maxScale = Math.max(MAX_SCALE * fit, 2);

  /** Recentre / borne le déplacement : l'image reste à l'écran (centrée si plus petite). */
  const constrain = useCallback((v: View): View => {
    if (!natural) return v;
    const s = clamp(v.s, minScale, maxScale);
    const w = natural.w * s;
    const h = natural.h * s;
    const tx = w <= box.w ? (box.w - w) / 2 : clamp(v.tx, box.w - w, 0);
    const ty = h <= box.h ? (box.h - h) / 2 : clamp(v.ty, box.h - h, 0);
    return { s, tx, ty };
  }, [natural, box, minScale, maxScale]);

  const view = useMemo(() => constrain(userView ?? { s: minScale, tx: 0, ty: 0 }), [constrain, userView, minScale]);
  // Vue courante pour les gestionnaires d'événements : mise à jour aussitôt à chaque geste
  // (plusieurs pointermove peuvent arriver avant le rendu suivant)
  const viewRef = useRef(view);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  const setView = useCallback((v: View) => {
    const next = constrain(v);
    viewRef.current = next;
    setUserView(next);
  }, [constrain]);

  /** Zoom à l'échelle `s`, en gardant fixe le point (px, py) de la zone d'affichage. */
  const zoomAt = useCallback((s: number, px: number, py: number) => {
    const cur = viewRef.current;
    const next = clamp(s, minScale, maxScale);
    const ix = (px - cur.tx) / cur.s;
    const iy = (py - cur.ty) / cur.s;
    setView({ s: next, tx: px - ix * next, ty: py - iy * next });
  }, [setView, minScale, maxScale]);

  const showFit = useCallback(() => {
    viewRef.current = constrain({ s: minScale, tx: 0, ty: 0 });
    setUserView(null);
  }, [constrain, minScale]);
  const center = useCallback(() => ({ x: box.w / 2, y: box.h / 2 }), [box]);

  // Taille de la zone d'affichage (rotation, fenêtre redimensionnée, clavier…)
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Retour (Android, navigateur) : ferme la visionneuse au lieu de quitter la page
  useEffect(() => {
    window.history.pushState({ openwlmViewer: true }, '');
    const onPop = () => onCloseRef.current();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.openwlmViewer) window.history.back();
    };
  }, []);

  // Clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = center();
      if (e.key === 'Escape') onCloseRef.current();
      else if (e.key === '+' || e.key === '=') zoomAt(viewRef.current.s * 1.25, c.x, c.y);
      else if (e.key === '-') zoomAt(viewRef.current.s / 1.25, c.x, c.y);
      else if (e.key === '0') showFit();
      else if (e.key === '1') zoomAt(1, c.x, c.y);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomAt, showFit, center]);

  // Molette : zoom centré sur le pointeur (écouteur non passif pour bloquer le défilement)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(viewRef.current.s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /** Double-clic / double-tap : ajusté ↔ taille réelle (ou ×2,5 pour une petite image), sur le point visé. */
  const toggleZoomAt = (px: number, py: number) => {
    const zoomed = viewRef.current.s > minScale * 1.05;
    if (zoomed) showFit();
    else zoomAt(minScale < 0.8 ? 1 : Math.min(minScale * 2.5, maxScale), px, py);
  };

  // Déplacement (1 pointeur) et pincement (2 pointeurs)
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const lastPointerType = useRef('mouse');
  const local = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try { stageRef.current?.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    lastPointerType.current = e.pointerType;
    pointers.current.set(e.pointerId, local(e));
    moved.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.current.size === 1) {
      if (Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) > 2) moved.current = true;
      const cur = viewRef.current;
      setView({ s: cur.s, tx: cur.tx + p.x - prev.x, ty: cur.ty + p.y - prev.y });
    } else if (pointers.current.size === 2) {
      moved.current = true;
      const [a, b] = [...pointers.current.entries()].map(([id, pt]) => (id === e.pointerId ? p : pt));
      const [pa, pb] = [...pointers.current.values()];
      const before = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0) {
        const cur = viewRef.current;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const prevMid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        const s = clamp(cur.s * (after / before), minScale, maxScale);
        const ix = (prevMid.x - cur.tx) / cur.s;
        const iy = (prevMid.y - cur.ty) / cur.s;
        setView({ s, tx: mid.x - ix * s, ty: mid.y - iy * s });
      }
    }
    pointers.current.set(e.pointerId, p);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (!wasSingle || moved.current || e.pointerType === 'mouse') return;
    // Double-tap (toucher, stylet) ; la souris passe par onDoubleClick
    const p = local(e);
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(p.x - last.x, p.y - last.y) < 30) {
      lastTap.current = null;
      toggleZoomAt(p.x, p.y);
    } else {
      lastTap.current = { t: now, x: p.x, y: p.y };
    }
  };

  const zoomable = view.s > minScale * 1.01 || (natural ? natural.w * view.s > box.w || natural.h * view.s > box.h : false);
  const c = center();

  return (
    <div className="wlm-viewer" role="dialog" aria-modal="true" aria-label={title} data-testid="image-viewer">
      <div className="wlm-viewer-bar">
        <span className="wlm-viewer-title" title={title}>📷 {title}</span>
        <div className="wlm-viewer-tools">
          <button type="button" className="win-btn" onClick={() => zoomAt(view.s / 1.25, c.x, c.y)} title={t.fileTransfer.zoomOut} aria-label={t.fileTransfer.zoomOut}>−</button>
          <span className="wlm-viewer-zoom" data-testid="image-viewer-zoom">{Math.round(view.s * 100)} %</span>
          <button type="button" className="win-btn" onClick={() => zoomAt(view.s * 1.25, c.x, c.y)} title={t.fileTransfer.zoomIn} aria-label={t.fileTransfer.zoomIn}>+</button>
          <button type="button" className="win-btn" onClick={showFit} title={t.fileTransfer.zoomFit}>{t.fileTransfer.zoomFit}</button>
          <button type="button" className="win-btn" onClick={() => zoomAt(1, c.x, c.y)} title={t.fileTransfer.zoomActual}>100 %</button>
          {onSave && <button type="button" className="win-btn win-btn-primary" onClick={onSave}>{t.fileTransfer.save}</button>}
          <button type="button" className="win-close-btn" onClick={onClose} title={`${t.common.close} (Esc)`} aria-label={t.common.close}>✕</button>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`wlm-viewer-stage${zoomable ? ' zoomable' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onDoubleClick={(e) => {
          // Au toucher, le double-tap est déjà traité (le navigateur émet aussi un dblclick)
          if (lastPointerType.current !== 'mouse') return;
          const r = stageRef.current!.getBoundingClientRect(); toggleZoomAt(e.clientX - r.left, e.clientY - r.top); }}
      >
        <img
          src={src}
          alt={title}
          draggable={false}
          className="wlm-viewer-image"
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={natural ? { width: natural.w, height: natural.h, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` } : { visibility: 'hidden' }}
        />
      </div>
      <div className="wlm-viewer-hint">{t.fileTransfer.zoomHint}</div>
    </div>
  );
};

export default ImageViewer;
