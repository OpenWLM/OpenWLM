import React from 'react';

/**
 * Boîte de dialogue Aero (remplace les alert() natifs du navigateur).
 * Réutilise les classes Aero existantes (win-title-control / win-btn) et ajoute
 * une fenêtre « verre » cohérente avec le reste de l'interface.
 */
interface GameDialogProps {
  title: string;
  message: string;
  icon?: string;
  okLabel?: string;
  onClose: () => void;
}

export const GameDialog: React.FC<GameDialogProps> = ({
  title,
  message,
  icon = '🎮',
  okLabel = 'OK',
  onClose
}) => (
  <div className="wlm-aero-dialog-overlay" role="dialog" aria-modal="true">
    <div className="wlm-aero-dialog">
      <div className="wlm-aero-dialog-titlebar">
        <span className="wlm-aero-dialog-icon">{icon}</span>
        <span className="wlm-aero-dialog-title">{title}</span>
        <button className="win-title-control win-close-btn" onClick={onClose} title={okLabel} aria-label={okLabel}>✕</button>
      </div>
      <div className="wlm-aero-dialog-body">{message}</div>
      <div className="wlm-aero-dialog-footer">
        <button className="win-btn win-btn-primary" onClick={onClose}>{okLabel}</button>
      </div>
    </div>
  </div>
);

export default GameDialog;
