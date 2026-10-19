import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { PLUS_COLORS, renderPlusText } from '../utils/plusFormat';

/**
 * Bouton 🎨 + petit panneau de mise en forme : gras, italique, souligné, barré, couleur du
 * texte, couleur de fond, dégradé. `onWrap(open, close)` entoure la sélection (ou insère au
 * curseur) avec les balises choisies : l'appelant sait comment modifier son champ.
 */

type Mode = 'color' | 'background' | 'gradient';

/** Hauteur approximative du panneau (avec l'indication du mode dégradé et l'aperçu). */
const PANEL_HEIGHT = 250;
const PANEL_WIDTH = 236;
const MARGIN = 8;

/**
 * Position du panneau, en coordonnées de l'écran : il est affiché par-dessus toute la page
 * (portail dans <body>), pour qu'aucun conteneur qui défile (barre d'outils sur mobile, contenu
 * des Options) ne le coupe. Au-dessus du bouton par défaut, en dessous si la place manque.
 */
const panelPosition = (btn: DOMRect, align: 'left' | 'right'): React.CSSProperties => {
  const vw = window.innerWidth;
  const width = Math.min(PANEL_WIDTH, vw - 2 * MARGIN);
  const wanted = align === 'right' ? btn.right - width : btn.left;
  const left = Math.max(MARGIN, Math.min(wanted, vw - width - MARGIN));
  return btn.top < PANEL_HEIGHT + MARGIN
    ? { left, width, top: btn.bottom + 6 }
    : { left, width, bottom: window.innerHeight - btn.top + 6 };
};

export const FormatPicker: React.FC<{ onWrap: (open: string, close: string) => void; testId?: string; align?: 'left' | 'right' }> = ({ onWrap, testId, align = 'left' }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('color');
  const [gradientStart, setGradientStart] = useState<number | null>(null);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      !!target && (rootRef.current?.contains(target as Node) || panelRef.current?.contains(target as Node));
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Le panneau est positionné une fois pour toutes : on le ferme si la page bouge
    const onMove = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const wrap = (o: string, c: string) => { onWrap(o, c); setOpen(false); setGradientStart(null); };
  const pickColor = (i: number) => {
    if (mode === 'color') wrap(`[c=${i}]`, '[/c]');
    else if (mode === 'background') wrap(`[a=${i}]`, '[/a]');
    else if (gradientStart === null) setGradientStart(i);
    else wrap(`[c=${gradientStart}]`, `[/c=${i}]`);
  };

  return (
    <span className="fmt-picker" ref={rootRef}>
      <button
        type="button"
        className="fmt-picker-btn"
        title={t.extras.formatTool}
        aria-label={t.extras.formatTool}
        aria-expanded={open}
        data-testid={testId}
        // Ne pas voler le focus : la sélection du champ doit rester intacte
        onMouseDown={e => e.preventDefault()}
        onClick={e => {
          if (!open) setPosition(panelPosition(e.currentTarget.getBoundingClientRect(), align));
          setOpen(v => !v);
        }}
      >🎨</button>
      {open && createPortal(
        <div ref={panelRef} className="fmt-picker-panel" style={position} role="dialog" aria-label={t.extras.formatTool} onMouseDown={e => e.preventDefault()}>
          <div className="fmt-picker-styles">
            <button type="button" title={t.extras.formatBold} onClick={() => wrap('[b]', '[/b]')}><b>G</b></button>
            <button type="button" title={t.extras.formatItalic} onClick={() => wrap('[i]', '[/i]')}><i>I</i></button>
            <button type="button" title={t.extras.formatUnderline} onClick={() => wrap('[u]', '[/u]')}><u>S</u></button>
            <button type="button" title={t.extras.formatStrike} onClick={() => wrap('[s]', '[/s]')}><s>B</s></button>
          </div>
          <div className="fmt-picker-modes" role="tablist">
            {(['color', 'background', 'gradient'] as Mode[]).map(m => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''}
                onClick={() => { setMode(m); setGradientStart(null); }}>
                {m === 'color' ? t.extras.formatColor : m === 'background' ? t.extras.formatBackground : t.extras.formatGradient}
              </button>
            ))}
          </div>
          {mode === 'gradient' && <div className="fmt-picker-hint">{t.extras.formatGradientHint}</div>}
          <div className="fmt-picker-swatches">
            {PLUS_COLORS.map((color, i) => (
              <button
                key={i}
                type="button"
                className={`fmt-swatch ${gradientStart === i ? 'selected' : ''}`}
                style={{ background: color }}
                title={`${i} — ${color}`}
                aria-label={`${i} ${color}`}
                onClick={() => pickColor(i)}
              />
            ))}
          </div>
          <div className="fmt-picker-preview">
            {t.extras.formatPreview} : {renderPlusText('[c=4]Open[/c][c=12]WLM[/c] [b]·[/b] [c=3]Messenger[/c=10]', s => s)}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
};

export default FormatPicker;
