import React from 'react';
import { useI18n } from '../i18n';

/**
 * Modale de choix du décor (Scène) du profil.
 * Présentation pure : la sélection remonte via `onSelect(file)`, la fermeture via `onClose`.
 */

const SCENES = [
  { id: '1', file: '0001.png', name: 'Marguerites' },
  { id: '2', file: '0002.jpg', name: 'Bambou' },
  { id: '3', file: '0003.jpg', name: 'Cerisiers' },
  { id: '4', file: '0004.png', name: 'Fleur Violette' },
  { id: '6', file: '0006.png', name: 'Aurore' },
  { id: '10', file: 'CarbonFiber.jpg', name: 'Carbone' },
  { id: '16', file: 'ButterflyPattern.png', name: 'Papillon' }
];

interface SceneModalProps {
  onClose: () => void;
  onSelect: (file: string) => void;
}

export const SceneModal: React.FC<SceneModalProps> = ({ onClose, onSelect }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="win-modal-header"><span>{t.modals.changeSceneTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="scene-grid">
          {SCENES.map(s => (
            <div key={s.id} className="scene-thumb" onClick={() => onSelect(s.file)}>
              <img src={`/assets/scenes/${s.file}`} alt={s.name} />
              <div className="scene-name">{s.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
