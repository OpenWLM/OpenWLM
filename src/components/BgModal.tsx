import React from 'react';
import { useI18n } from '../i18n';

/**
 * Modale de choix de l'arrière-plan de la discussion courante.
 * Présentation pure : la sélection remonte via `onSelect(file)` (`''` = standard),
 * la fermeture via `onClose`.
 */

const CONV_BACKGROUNDS = [
  { id: 'none', name: 'Standard', file: '' },
  { id: 'car', name: 'Voiture', file: 'car.jpg' },
  { id: 'fish', name: 'Poissons', file: 'fish.jpg' },
  { id: 'hearts', name: 'Cœurs', file: 'hearts.jpg' },
  { id: 'lavender', name: 'Lavande', file: 'lavender.jpg' },
  { id: 'planets', name: 'Planètes', file: 'planets.jpg' }
];

interface BgModalProps {
  onClose: () => void;
  onSelect: (file: string) => void;
}

export const BgModal: React.FC<BgModalProps> = ({ onClose, onSelect }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="win-modal-header"><span>{t.modals.changeBgTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="scene-grid">
          {CONV_BACKGROUNDS.map(bg => (
            <div
              key={bg.id}
              className="scene-thumb"
              onClick={() => onSelect(bg.file)}
            >
              {bg.file ? <img src={`/assets/backgrounds/${bg.file}`} alt={bg.name} /> : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f0f0' }}>{t.modals.bgNone}</div>}
              <div className="scene-name">{bg.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
