import React, { useEffect, useState } from 'react';
import SoundManager from '../utils/SoundManager';
import Synthesis from '../utils/Synthesis';

/**
 * Interface pour les propriétés du lecteur de Clins d'œil (Winks)
 */
interface WinkPlayerProps {
  winkId: string;   // Identifiant unique du clin d'œil
  onFinish: () => void; // Callback appelé à la fin de l'animation
}

/**
 * Composant WinkPlayer
 * Gère l'affichage plein écran et la reproduction sonore des "Clins d'œil" MSN.
 * Inclut des animations CSS complexes pour les clins d'œil reconstruits.
 */
const WinkPlayer: React.FC<WinkPlayerProps> = ({ winkId, onFinish }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    /**
     * Logique de reproduction sonore associée aux clins d'œil
     */
    if (winkId === 'frog') {
      // Séquence sonore spécifique pour la grenouille
      setTimeout(() => Synthesis.playCatch(), 1800); // Capture de la mouche
      setTimeout(() => Synthesis.playBurp(), 2500);  // Rot final
    } else {
      // Mapping des sons standards
      const soundMap: Record<string, string> = {
        'guitar_smash': 'electric_guitar',
        'bouncy_ball': 'nudge',
        'kiss': 'Kiss',
        'knock': 'nudge'
      };
      SoundManager.play(soundMap[winkId] || winkId);
    }

    /**
     * Durée de vie du clin d'œil (5 secondes par défaut)
     */
    const timer = setTimeout(() => {
      setVisible(false);
      onFinish();
    }, 5000);

    return () => clearTimeout(timer);
  }, [winkId, onFinish]);

  // Si le clin d'œil n'est plus visible, on ne rend rien
  if (!visible) return null;

  return (
    <div className="wink-overlay">
      <div className="wink-canvas">
        {/* Clin d'œil : Bisou (Kiss) */}
        {winkId === 'kiss' && (
          <div className="reconstructed-kiss">
             <div className="lips">💋</div>
             <div className="heart">❤️</div>
          </div>
        )}

        {/* Clin d'œil : Balle bondissante (Bouncy Ball) */}
        {winkId === 'bouncy_ball' && (
          <div className="reconstructed-ball">
             <img src="/assets/icons/smiley_tongue.svg" alt="ball" style={{width: '100%', height: '100%'}} />
          </div>
        )}

        {/* Clin d'œil : Guitare cassée (Guitar Smash) */}
        {winkId === 'guitar_smash' && (
          <div className="reconstructed-guitar">
             🎸
             <div className="explosion">💥</div>
          </div>
        )}

        {/* Clin d'œil : Grenouille (Frog) - Version 2 avec langue animée */}
        {winkId === 'frog' && (
          <div className="reconstructed-frog-v2">
             <div className="frog-body">🐸</div>
             <div className="fly">🪰</div>
             <div className="tongue-v2"></div>
             <div className="burp-cloud">💨</div>
          </div>
        )}

        {/* Clin d'œil : Lettre d'amour (Love Letter) */}
        {winkId === 'love_letter' && (
          <div className="reconstructed-letter">
             ✉️
             <div className="hearts-burst">💕✨</div>
          </div>
        )}

        {/* Clin d'œil : Gros Cœur (Heart) */}
        {winkId === 'heart' && (
          <div className="reconstructed-bigheart">💖</div>
        )}

        {/* Clin d'œil : Toc Toc (Knock) */}
        {winkId === 'knock' && (
          <div className="reconstructed-knock">
             <div className="fist">✊</div>
             <div className="impact">💥</div>
          </div>
        )}

        {/* Rendu par défaut pour les clins d'œil basés sur des images PNG si non reconstruits */}
        {!['kiss', 'bouncy_ball', 'guitar_smash', 'frog', 'love_letter', 'heart', 'knock'].includes(winkId) && (
          <div className="wink-container-png">
            <img
              src={`/assets/winks/${winkId}/${winkId}.png`}
              alt={`Clin d'œil ${winkId}`}
              className="wink-image-anim"
              style={{ width: '600px' }}
              onError={(e) => (e.currentTarget.style.display = 'none')} // Gestion d'erreur si image manquante
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default WinkPlayer;
