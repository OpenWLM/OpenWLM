import React, { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { answerDialog, useCurrentDialog } from '../utils/dialogs';

/**
 * Affiche les boîtes demandées par notify() / askConfirm() (src/utils/dialogs.ts), une à la
 * fois, dans le style Aero des autres fenêtres. Entrée = bouton principal, Échap = Annuler
 * (ou fermer pour un simple message). Monté une seule fois à la racine (main.tsx).
 */
export const DialogHost: React.FC = () => {
  const { t } = useI18n();
  const dialog = useCurrentDialog();
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!dialog) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answerDialog(dialog.id, false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); answerDialog(dialog.id, true); }
    };
    // Capture : la boîte passe avant les raccourcis des fenêtres en dessous (Échap des Options…)
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialog]);

  if (!dialog) return null;
  const isConfirm = dialog.kind === 'confirm';
  const title = dialog.title || t.common.appName;
  const icon = dialog.icon || (isConfirm ? '❓' : 'ℹ️');

  return (
    <div className="wlm-aero-dialog-overlay wlm-aero-dialog-overlay-top" role="alertdialog" aria-modal="true" aria-label={title} data-testid="aero-dialog">
      <div className="wlm-aero-dialog">
        <div className="wlm-aero-dialog-titlebar">
          <span className="wlm-aero-dialog-icon" aria-hidden="true">{icon}</span>
          <span className="wlm-aero-dialog-title">{title}</span>
          <button className="win-title-control win-close-btn" onClick={() => answerDialog(dialog.id, false)} aria-label={t.common.close}>✕</button>
        </div>
        <div className="wlm-aero-dialog-body" data-testid="aero-dialog-message">{dialog.message}</div>
        <div className="wlm-aero-dialog-footer">
          {isConfirm && (
            <button className="win-btn" onClick={() => answerDialog(dialog.id, false)}>{t.common.cancel}</button>
          )}
          <button
            ref={okRef}
            className={`win-btn win-btn-primary${dialog.danger ? ' danger' : ''}`}
            onClick={() => answerDialog(dialog.id, true)}
          >
            {dialog.confirmLabel || t.common.ok}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DialogHost;
