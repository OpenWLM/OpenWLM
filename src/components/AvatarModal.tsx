import React from 'react';
import { useI18n } from '../i18n';

/**
 * Modale de choix de l'avatar (image perso) du profil.
 * Présentation pure : la sélection remonte via `onSelect(tile)`, la fermeture via `onClose`.
 */

const USERTILES = [
  'basketball.png', 'bonsai.png', 'chef.png', 'chess.png', 'daisy.png',
  'doctor.png', 'dog.png', 'electric_guitar.png', 'executive.png', 'fish.png',
  'flare.png', 'gerber_daisy.png', 'golf.png', 'guest.png', 'guitar.png',
  'kitten.png', 'leaf.png', 'morty.png', 'music.png', 'robot.png',
  'seastar.png', 'shopping.png', 'sports.png', 'surf.png', 'tennis.png'
];

interface AvatarModalProps {
  onClose: () => void;
  onSelect: (tile: string) => void;
}

export const AvatarModal: React.FC<AvatarModalProps> = ({ onClose, onSelect }) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="win-modal-header"><span>{t.modals.chooseAvatarTitle}</span><button className="win-close-btn" onClick={onClose}>✕</button></div>
        <div className="scene-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {USERTILES.map(tile => (
            <div key={tile} className="scene-thumb" style={{ height: '60px' }} onClick={() => onSelect(tile)}>
              <img src={`/assets/usertiles/${tile}`} alt="Avatar" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
