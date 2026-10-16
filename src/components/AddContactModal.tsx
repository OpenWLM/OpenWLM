import React from 'react';
import { useI18n } from '../i18n';

/**
 * Modale d'ajout d'un contact (envoi d'invitation par pseudo/email).
 * Contrôlée : `value`/`onChange` pour le champ, `onSubmit` pour le bouton OK, `onClose` pour
 * la fermeture (bouton ✕, Annuler ou clic sur le fond).
 */

interface AddContactModalProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export const AddContactModal: React.FC<AddContactModalProps> = ({ value, onChange, onSubmit, onClose }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: '400px' }}>
        <div className="win-modal-header"><span>{t.modals.addContactTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="auth-field" style={{ padding: '20px' }}>
          <label>{t.modals.contactEmailLabel}</label>
          <input type="email" value={value} onChange={e => onChange(e.target.value)} placeholder={t.modals.contactEmailPlaceholder || "pseudo@openwlm.dev"} style={{ width: '100%', marginTop: '5px' }} />
        </div>
        <div style={{ marginTop: '20px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '0 20px 20px' }}>
          <button className="win-btn" onClick={onSubmit}>{t.common.ok}</button>
          <button className="win-btn" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </div>
    </div>
  );
};
