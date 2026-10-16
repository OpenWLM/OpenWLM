import React from 'react';
import { useI18n } from '../i18n';
import { WINKS } from '../hooks/useWinksAndNudge';

/**
 * Modale de choix d'un clin d'œil (Wink).
 * Présentation pure : la sélection remonte via `onSelect(winkId)`, la fermeture via `onClose`.
 */

interface WinksModalProps {
  onClose: () => void;
  onSelect: (winkId: string) => void;
}

export const WinksModal: React.FC<WinksModalProps> = ({ onClose, onSelect }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="win-modal-header"><span>{t.modals.chooseWinkTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="scene-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', padding: '20px' }}>
          {WINKS.map(w => (
            <div key={w.id} className="scene-thumb" style={{ height: '80px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }} onClick={() => onSelect(w.id)}>
              <img src={`/assets/winks/${w.id}/${w.id}.png`} alt={w.name} style={{ height: '40px', width: 'auto', marginBottom: '5px' }} />
              <div className="scene-name" style={{ fontSize: '9px', position: 'static', background: 'transparent' }}>{w.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
