import React from 'react';
import { useI18n } from '../i18n';

/**
 * Modale de changement de mot de passe.
 * Présentation pure : la soumission remonte via `onSubmit(e)` (gérée par le domaine profil),
 * la fermeture via `onClose`. Les champs sont lus par id (`old-password` / `new-password`).
 */

interface PasswordModalProps {
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const PasswordModal: React.FC<PasswordModalProps> = ({ onClose, onSubmit }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: '300px' }}>
        <div className="win-modal-header"><span>{t.modals.changePasswordTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '20px' }}>
          <input id="old-password" type="password" placeholder={t.modals.oldPasswordPlaceholder} required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
          <input id="new-password" type="password" placeholder={t.modals.newPasswordPlaceholder} required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
          <button type="submit" className="win-btn" style={{ marginTop: '10px' }}>{t.modals.validateBtn}</button>
        </form>
      </div>
    </div>
  );
};
