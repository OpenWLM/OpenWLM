import React, { useEffect, useRef, useState } from 'react';
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

export const FormatPicker: React.FC<{ onWrap: (open: string, close: string) => void; testId?: string; align?: 'left' | 'right' }> = ({ onWrap, testId, align = 'left' }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('color');
  const [gradientStart, setGradientStart] = useState<number | null>(null);
  const [below, setBelow] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
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
          if (!open) {
            // Ouvert vers le haut par défaut ; vers le bas si la place manque au-dessus, dans la
            // zone qui le contient (Options : le pseudo est tout en haut de l'onglet) ou l'écran.
            const btn = e.currentTarget.getBoundingClientRect();
            const clip = e.currentTarget.closest('.options-content, .modal-box')?.getBoundingClientRect();
            setBelow(btn.top - Math.max(clip?.top ?? 0, 0) < PANEL_HEIGHT);
          }
          setOpen(v => !v);
        }}
      >🎨</button>
      {open && (
        <div className={`fmt-picker-panel ${align === 'right' ? 'align-right' : ''} ${below ? 'below' : ''}`} role="dialog" aria-label={t.extras.formatTool} onMouseDown={e => e.preventDefault()}>
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
        </div>
      )}
    </span>
  );
};

export default FormatPicker;
