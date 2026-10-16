import React, { useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Modale des paramètres de police (style Windows classique).
 *
 * Composant CONTRÔLÉ : `settings`/`onChange` portent la police courante, qui sert aussi à
 * styliser les messages sortants (conservée dans `App`). L'état d'ouverture du sélecteur de
 * couleur est local au composant.
 */

export interface FontSettings {
  family: string;
  weight: string;
  style: string;
  color: string;
  size: string;
  strikeout: boolean;
  underline: boolean;
}

const WLM_COLORS = [
  { name: 'Noir', hex: '#000000' },
  { name: 'Bordeaux', hex: '#800000' },
  { name: 'Vert', hex: '#008000' },
  { name: 'Olive', hex: '#808000' },
  { name: 'Bleu marine', hex: '#000080' },
  { name: 'Violet', hex: '#800080' },
  { name: 'Sarcelle', hex: '#008080' },
  { name: 'Gris', hex: '#808080' },
  { name: 'Argent', hex: '#C0C0C0' },
  { name: 'Rouge', hex: '#FF0000' },
  { name: 'Citron vert', hex: '#00FF00' },
  { name: 'Jaune', hex: '#FFFF00' },
  { name: 'Bleu', hex: '#0000FF' },
  { name: 'Fuchsia', hex: '#FF00FF' },
  { name: 'Aqua', hex: '#00FFFF' },
  { name: 'Blanc', hex: '#FFFFFF' }
];

interface FontModalProps {
  settings: FontSettings;
  onChange: (settings: FontSettings) => void;
  onClose: () => void;
}

export const FontModal: React.FC<FontModalProps> = ({ settings: fontSettings, onChange: setFontSettings, onClose }) => {
  const { t } = useI18n();
  const [showColorDropdown, setShowColorDropdown] = useState(false);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box font-modal win-style-modal" onClick={e => e.stopPropagation()}>
        <div className="win-modal-header"><span>{t.modals.changeFontTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="win-modal-body">
          <div className="win-font-grid">
            <div className="win-field-col">
              <label>{t.modals.fontFamily}</label>
              <input type="text" readOnly value={fontSettings.family} className="win-input-preview" />
              <div className="win-list-box">
                {['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Comic Sans MS', 'Courier New', 'Times New Roman'].map(f => (
                  <div key={f} className={`win-list-item ${fontSettings.family === f ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, family: f})}>{f}</div>
                ))}
              </div>
            </div>
            <div className="win-field-col">
              <label>{t.modals.fontStyle}</label>
              <input type="text" readOnly value={fontSettings.weight === 'bold' ? (fontSettings.style === 'italic' ? t.modals.styleBoldItalic : t.modals.styleBold) : (fontSettings.style === 'italic' ? t.modals.styleItalic : t.modals.styleNormal)} className="win-input-preview" />
              <div className="win-list-box">
                <div className={`win-list-item ${fontSettings.weight === 'normal' && fontSettings.style === 'normal' ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, weight: 'normal', style: 'normal'})}>{t.modals.styleNormal}</div>
                <div className={`win-list-item ${fontSettings.style === 'italic' && fontSettings.weight === 'normal' ? 'selected' : ''}`} style={{ fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, style: 'italic', weight: 'normal'})}>{t.modals.styleItalic}</div>
                <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'normal' ? 'selected' : ''}`} style={{ fontWeight: 'bold' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'normal'})}>{t.modals.styleBold}</div>
                <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'italic' ? 'selected' : ''}`} style={{ fontWeight: 'bold', fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'italic'})}>{t.modals.styleBoldItalic}</div>
              </div>
            </div>
            <div className="win-field-col win-field-col-size">
              <label>{t.modals.fontSize}</label>
              <input type="text" readOnly value={fontSettings.size} className="win-input-preview" />
              <div className="win-list-box">
                {['8', '9', '10', '11', '12', '14', '16', '18', '20'].map(s => (
                  <div key={s} className={`win-list-item ${fontSettings.size === s ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, size: s})}>{s}</div>
                ))}
              </div>
            </div>
          </div>
          <div className="win-lower-grid">
            <div className="win-effects-group">
              <fieldset className="win-effects-fieldset">
                <legend>{t.modals.fontEffects}</legend>
                <div className="win-font-effects-section">
                  <label className="win-checkbox"><input type="checkbox" checked={fontSettings.strikeout} onChange={e => setFontSettings({...fontSettings, strikeout: e.target.checked})} /> {t.modals.strikeout}</label>
                  <label className="win-checkbox"><input type="checkbox" checked={fontSettings.underline} onChange={e => setFontSettings({...fontSettings, underline: e.target.checked})} /> {t.modals.underline}</label>
                </div>
                <div className="win-font-color-section">
                  <label className="win-color-label">{t.modals.fontColor}</label>
                  <div className="wlm-color-picker-container" style={{ position: 'relative' }}>
                    <div
                      className="wlm-color-picker-selected"
                      onClick={() => setShowColorDropdown(!showColorDropdown)}
                      style={{ display: 'flex', alignItems: 'center', background: 'white', border: '1px solid #abadb3', cursor: 'pointer', justifyContent: 'space-between' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <div className="color-box" style={{ backgroundColor: fontSettings.color, width: '12px', height: '12px', border: '1px solid #000' }}></div>
                        <span>{WLM_COLORS.find(c => c.hex === fontSettings.color)?.name || 'Couleur'}</span>
                      </div>
                      <span className="dropdown-arrow" style={{ fontSize: '8px', paddingRight: '2px' }}>▼</span>
                    </div>
                    {showColorDropdown && (
                      <>
                        <div className="wlm-color-backdrop" onClick={() => setShowColorDropdown(false)} />
                        <div className="wlm-color-dropdown">
                          {WLM_COLORS.map(color => (
                            <div
                              key={color.hex}
                              className="wlm-color-option"
                              onClick={() => {
                                setFontSettings({...fontSettings, color: color.hex});
                                setShowColorDropdown(false);
                              }}
                              style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '5px', background: fontSettings.color === color.hex ? '#0078d7' : 'transparent', color: fontSettings.color === color.hex ? 'white' : 'black' }}
                            >
                              <div className="color-box" style={{ backgroundColor: color.hex, width: '12px', height: '12px', border: '1px solid #000' }}></div>
                              <span>{color.name}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </fieldset>
            </div>
            <div className="win-sample-group">
              <fieldset>
                <legend>{t.modals.fontPreview}</legend>
                <div className="win-sample-box">
                  <span style={{
                    fontFamily: fontSettings.family,
                    fontWeight: fontSettings.weight,
                    fontStyle: fontSettings.style,
                    color: fontSettings.color,
                    fontSize: `${fontSettings.size}pt`,
                    textDecoration: `${fontSettings.underline ? 'underline' : ''} ${fontSettings.strikeout ? 'line-through' : ''}`.trim()
                  }}>AaBbYyZz</span>
                </div>
              </fieldset>
            </div>
          </div>
          <div className="win-modal-footer">
            <button className="win-btn" onClick={onClose}>{t.common.ok}</button>
            <button className="win-btn" onClick={onClose}>{t.common.cancel}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
