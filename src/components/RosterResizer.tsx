import React, { useRef } from 'react';
import { useI18n } from '../i18n';
import { clampRosterWidth, getAppPrefs, updateAppPrefs, ROSTER_WIDTH_DEFAULT, ROSTER_WIDTH_MAX, ROSTER_WIDTH_MIN } from '../utils/appPrefs';

/**
 * Poignée de redimensionnement de la liste de contacts (ordinateur uniquement : masquée par
 * CSS sur mobile, où la liste occupe tout l'écran).
 *
 * Glisser : la largeur suit la souris (variable CSS `--roster-width` posée directement sur
 * `.wlm-desktop`, sans re-rendu de l'app), puis est enregistrée au relâchement dans les
 * préférences de l'appareil. Double-clic : retour à la taille d'origine. Clavier : ←/→ par
 * pas de 16 px, Origine pour la taille d'origine. La conversation garde au moins 420 px.
 */

const MIN_CHAT_WIDTH = 420;
const KEY_STEP = 16;

const maxForWindow = () => Math.max(ROSTER_WIDTH_MIN, Math.min(ROSTER_WIDTH_MAX, window.innerWidth - MIN_CHAT_WIDTH));
const fit = (w: number) => Math.min(clampRosterWidth(w), maxForWindow());

export const RosterResizer: React.FC<{ width: number }> = ({ width }) => {
  const { t } = useI18n();
  const drag = useRef<{ startX: number; startWidth: number; current: number } | null>(null);

  const desktopEl = (el: Element) => el.closest('.wlm-desktop') as HTMLElement | null;
  const save = (w: number) => updateAppPrefs('layout', { rosterWidth: fit(w) });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: getAppPrefs().layout.rosterWidth, current: getAppPrefs().layout.rosterWidth };
    document.body.classList.add('wlm-resizing');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.current = fit(d.startWidth + e.clientX - d.startX);
    desktopEl(e.currentTarget)?.style.setProperty('--roster-width', `${d.current}px`);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove('wlm-resizing');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    save(d.current);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') save(width - KEY_STEP);
    else if (e.key === 'ArrowRight') save(width + KEY_STEP);
    else if (e.key === 'Home') save(ROSTER_WIDTH_DEFAULT);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="wlm-roster-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.settings.rosterResizeLabel}
      aria-valuemin={ROSTER_WIDTH_MIN}
      aria-valuemax={ROSTER_WIDTH_MAX}
      aria-valuenow={width}
      title={t.settings.rosterResizeHint}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => save(ROSTER_WIDTH_DEFAULT)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
};

export default RosterResizer;
