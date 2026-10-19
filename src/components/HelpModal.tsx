import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { PLUS_COLORS, renderPlusText } from '../utils/plusFormat';
import { BUILTIN_COMMANDS } from '../utils/chatCommands';

/**
 * Fenêtre d'aide (menu principal → Aide, écran de connexion → Aide, commande /help).
 * Même habillage que les Options : onglets à gauche, contenu à droite. Accessible sans être
 * connecté : aucune donnée de compte n'y est utilisée.
 */

type Tab = 'basics' | 'formatting' | 'commands' | 'quickTexts' | 'shortcuts';

/** Même seuil que le CSS (.help-nav-toggle). */
const NARROW_SCREEN = '(max-width: 600px)';

const DOCS_URL = 'https://github.com/OpenWLM/OpenWLM/blob/main/docs/FORMATTING_AND_COMMANDS.md';
const DOCS_URL_FR = 'https://github.com/OpenWLM/OpenWLM/blob/main/docs/FORMATTING_AND_COMMANDS.fr.md';

const FORMAT_EXAMPLES = [
  '[b]gras[/b]',
  '[i]italique[/i]',
  '[u]souligné[/u]',
  '[s]barré[/s]',
  '[c=4]rouge[/c]',
  '[c=#1E90FF]bleu[/c]',
  '[a=8]fond jaune[/a]',
  '[c=4]dégradé[/c=12]',
  '[c=3][b]Vert gras[/b][/c]',
  '·$12bleu·0 normal'
];
const FORMAT_EXAMPLES_EN = [
  '[b]bold[/b]',
  '[i]italic[/i]',
  '[u]underlined[/u]',
  '[s]struck[/s]',
  '[c=4]red[/c]',
  '[c=#1E90FF]blue[/c]',
  '[a=8]yellow background[/a]',
  '[c=4]gradient[/c=12]',
  '[c=3][b]Bold green[/b][/c]',
  '·$12blue·0 normal'
];

export const HelpModal: React.FC<{ onClose: () => void; initialTab?: Tab }> = ({ onClose, initialTab = 'basics' }) => {
  const { t, language } = useI18n();
  const h = t.help;
  const [tab, setTab] = useState<Tab>(initialTab);
  // Petit écran : le menu de gauche se replie (bouton ☰, ou automatiquement après un choix)
  // pour laisser toute la largeur au texte
  const [navCollapsed, setNavCollapsed] = useState(false);
  const pickTab = (id: Tab) => {
    setTab(id);
    if (window.matchMedia(NARROW_SCREEN).matches) setNavCollapsed(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: [Tab, string][] = [
    ['basics', h.tabBasics],
    ['formatting', h.tabFormatting],
    ['commands', h.tabCommands],
    ['quickTexts', h.tabQuickTexts],
    ['shortcuts', h.tabShortcuts]
  ];
  const examples = language === 'fr' ? FORMAT_EXAMPLES : FORMAT_EXAMPLES_EN;
  const keys: [string, string][] = [
    ['Entrée / Enter', h.keyEnter],
    ['Maj+Entrée / Shift+Enter', h.keyShiftEnter],
    ['Ctrl+↑', h.keyCtrlUp],
    ['Ctrl+F', h.keyCtrlF],
    ['Tab', h.keyTab],
    ['Échap / Esc', h.keyEscape]
  ];

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal-box wlm-options-modal wlm-help-modal ${navCollapsed ? 'help-nav-collapsed' : ''}`} role="dialog" aria-modal="true" aria-label={h.title} onClick={e => e.stopPropagation()} data-testid="help-modal">
        <div className="wlm-aero-dialog-titlebar wlm-options-titlebar">
          <span className="wlm-aero-dialog-icon" aria-hidden="true">❓</span>
          <span className="wlm-aero-dialog-title">{h.title}</span>
          <button type="button" className="win-close-btn" onClick={onClose} aria-label={t.common.close} title={t.common.close}>✕</button>
        </div>
        <div className="options-body">
          <div className="options-sidebar">
            <button
              type="button"
              className="help-nav-toggle"
              aria-expanded={!navCollapsed}
              aria-label={navCollapsed ? h.showMenu : h.hideMenu}
              title={navCollapsed ? h.showMenu : h.hideMenu}
              data-testid="help-nav-toggle"
              onClick={() => setNavCollapsed(v => !v)}
            >{navCollapsed ? '☰' : '◀'}</button>
            <div className="help-nav-tabs" role="tablist">
              {tabs.map(([id, label]) => (
                <div key={id} role="tab" aria-selected={tab === id} className={`options-nav-item ${tab === id ? 'active' : ''}`} onClick={() => pickTab(id)}>{label}</div>
              ))}
            </div>
          </div>
          <div className="options-content help-content">
            {tab === 'basics' && (
              <div className="options-section">
                <div className="options-title">{h.tabBasics}</div>
                <p>{h.intro}</p>
                <ul className="help-list">
                  <li>{h.basicsTestContact}</li>
                  <li>{h.basicsNudge}</li>
                  <li>{h.basicsWinks}</li>
                  <li>{h.basicsCalls}</li>
                  <li>{h.basicsPrivate}</li>
                  <li>{h.basicsEncryption}</li>
                </ul>
              </div>
            )}
            {tab === 'formatting' && (
              <div className="options-section">
                <div className="options-title">{h.tabFormatting}</div>
                <p>{h.formattingIntro}</p>
                <div className="help-table-wrap"><table className="help-table">
                  <thead><tr><th>{h.colExample}</th><th>{h.colResult}</th></tr></thead>
                  <tbody>
                    {examples.map(ex => (
                      <tr key={ex}><td><code>{ex}</code></td><td>{renderPlusText(ex, s => s, 'help')}</td></tr>
                    ))}
                  </tbody>
                </table></div>
                <p>{h.formattingColors}</p>
                <div className="help-palette">
                  {PLUS_COLORS.map((c, i) => (
                    <span key={i} className="help-palette-item"><span className="help-swatch" style={{ background: c }} /> {i}</span>
                  ))}
                </div>
                <p>{h.formattingCodes}</p>
                <p className="options-hint">{h.formattingLimits}</p>
              </div>
            )}
            {tab === 'commands' && (
              <div className="options-section">
                <div className="options-title">{h.tabCommands}</div>
                <p>{h.commandsIntro}</p>
                <div className="help-table-wrap"><table className="help-table">
                  <thead><tr><th>{h.colCommand}</th><th>{h.colDescription}</th></tr></thead>
                  <tbody>
                    {BUILTIN_COMMANDS.map(c => (
                      <tr key={c.name}>
                        <td><code>/{c.name}{c.needsArg ? ` <${t.extras.argText}>` : ''}</code></td>
                        <td>{t.extras[c.descKey]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                <p className="options-hint">{h.commandsEscape}</p>
              </div>
            )}
            {tab === 'quickTexts' && (
              <div className="options-section">
                <div className="options-title">{h.tabQuickTexts}</div>
                <p>{h.quickTextsIntro}</p>
                <p className="options-hint">{h.quickTextsExample}</p>
              </div>
            )}
            {tab === 'shortcuts' && (
              <div className="options-section">
                <div className="options-title">{h.tabShortcuts}</div>
                <div className="help-table-wrap"><table className="help-table">
                  <tbody>
                    {keys.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}
                  </tbody>
                </table></div>
              </div>
            )}
            <p className="help-docs"><a href={language === 'fr' ? DOCS_URL_FR : DOCS_URL} target="_blank" rel="noopener noreferrer">{h.docsLink} ↗</a></p>
          </div>
        </div>
        <div className="wlm-options-statusbar">OpenWLM v{__APP_VERSION__}</div>
      </div>
    </div>
  );
};

export default HelpModal;
