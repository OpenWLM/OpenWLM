import React, { useState } from 'react';

/**
 * Modale de CONFIRMATION Aero (remplace window.confirm()).
 * Supporte une case à cocher obligatoire (« je suis sûr ») pour éviter les actions accidentelles.
 */
interface AeroConfirmDialogProps {
  title: string;
  message: string;
  icon?: string;
  checkboxLabel?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const AeroConfirmDialog: React.FC<AeroConfirmDialogProps> = ({
  title,
  message,
  icon = '⚠️',
  checkboxLabel,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel
}) => {
  const [checked, setChecked] = useState(false);
  const canConfirm = !checkboxLabel || checked;

  return (
    <div className="wlm-aero-dialog-overlay" role="dialog" aria-modal="true">
      <div className="wlm-aero-dialog">
        <div className="wlm-aero-dialog-titlebar">
          <span className="wlm-aero-dialog-icon">{icon}</span>
          <span className="wlm-aero-dialog-title">{title}</span>
          {onCancel && (
            <button className="win-title-control win-close-btn" onClick={onCancel} aria-label={cancelLabel || 'Fermer'}>✕</button>
          )}
        </div>
        <div className="wlm-aero-dialog-body">
          <div>{message}</div>
          {checkboxLabel && (
            <label className="wlm-aero-dialog-check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{checkboxLabel}</span>
            </label>
          )}
        </div>
        <div className="wlm-aero-dialog-footer">
          {cancelLabel && onCancel && (
            <button className="win-btn" onClick={onCancel}>{cancelLabel}</button>
          )}
          <button
            className={`win-btn win-btn-primary${danger ? ' danger' : ''}`}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AeroConfirmDialog;
