import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { useAppPrefs, updateAppPrefs, QUICK_TEXT_MAX, QUICK_TEXT_MAX_LENGTH, QUICK_TEXT_SHORTCUT_RE } from '../utils/appPrefs';
import { isBuiltinCommand } from '../utils/chatCommands';
import { formatNickname } from '../utils/NicknameFormatter';

/**
 * Options → Messages → Textes rapides : « /raccourci » dans une conversation envoie le texte
 * ((!N) = nom du contact). Enregistrés sur l'appareil (préférences locales).
 */
export const QuickTextsEditor: React.FC = () => {
  const { t } = useI18n();
  const quickTexts = useAppPrefs().messages.quickTexts;
  const [shortcut, setShortcut] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const sc = shortcut.trim().replace(/^\//, '').toLowerCase();
    if (!QUICK_TEXT_SHORTCUT_RE.test(sc)) return setError(t.extras.optQuickTextInvalid);
    if (isBuiltinCommand(sc)) return setError(t.extras.optQuickTextReserved);
    if (quickTexts.some(q => q.shortcut === sc)) return setError(t.extras.optQuickTextDuplicate);
    if (!text.trim()) return setError(t.extras.optQuickTextEmpty);
    if (quickTexts.length >= QUICK_TEXT_MAX) return setError(t.extras.optQuickTextFull);
    updateAppPrefs('messages', { quickTexts: [...quickTexts, { shortcut: sc, text: text.trim() }] });
    setShortcut('');
    setText('');
    setError(null);
  };
  const remove = (sc: string) => updateAppPrefs('messages', { quickTexts: quickTexts.filter(q => q.shortcut !== sc) });

  return (
    <div className="options-subsection" data-testid="quick-texts">
      <label className="options-label">{t.extras.optQuickTexts}</label>
      <div className="options-hint">{t.extras.optQuickTextsHint}</div>
      {quickTexts.length === 0 ? (
        <div className="options-hint" style={{ fontStyle: 'italic' }}>{t.extras.optQuickTextNone}</div>
      ) : (
        <ul className="options-blocked-list">
          {quickTexts.map(q => (
            <li key={q.shortcut}>
              <span className="options-blocked-name"><b>/{q.shortcut}</b> — {formatNickname(q.text)}</span>
              <button type="button" className="win-btn" onClick={() => remove(q.shortcut)}>{t.extras.optQuickTextRemove}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="quick-text-form">
        <input
          className="win-input"
          id="qt-shortcut"
          placeholder={t.extras.optQuickTextShortcut}
          aria-label={t.extras.optQuickTextShortcut}
          value={shortcut}
          maxLength={21}
          onChange={e => { setShortcut(e.target.value); setError(null); }}
        />
        <input
          className="win-input"
          id="qt-text"
          placeholder={t.extras.optQuickTextText}
          aria-label={t.extras.optQuickTextText}
          value={text}
          maxLength={QUICK_TEXT_MAX_LENGTH}
          onChange={e => { setText(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
        />
        <button type="button" className="win-btn" onClick={add}>{t.extras.optQuickTextAdd}</button>
      </div>
      {error && <div className="opt-format-error" role="alert">{error}</div>}
    </div>
  );
};

export default QuickTextsEditor;
