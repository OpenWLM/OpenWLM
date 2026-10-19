import React from 'react';
import { useI18n } from '../i18n';
import { SYSTEM_BOT_ID, type Contact } from '../types';
import { stripPlusTags } from '../utils/plusFormat';

/**
 * Barre d'actions du haut de la conversation : fichiers, arrière-plan, appel vidéo/audio,
 * menu Jeux, mode privé et vérification d'identité (safety number).
 * Présentation pure : tous les callbacks viennent de `App`.
 */

interface ChatToolbarProps {
  activeChatId: number;
  activeContact: Contact;
  globalPrivateMode: boolean;
  isPrivateMode: Record<number, boolean>;
  showGamesMenu: boolean;
  onToggleGamesMenu: () => void;
  onOpenFiles: () => void;
  onOpenBackground: () => void;
  onStartVideo: () => void;
  onStartCall: () => void;
  onInviteGame: (gameType: string) => void;
  onTogglePrivateMode: () => void;
  onOpenSafetyModal: (id: number) => void;
}

export const ChatToolbar: React.FC<ChatToolbarProps> = ({
  activeChatId,
  activeContact,
  globalPrivateMode,
  isPrivateMode,
  showGamesMenu,
  onToggleGamesMenu,
  onOpenFiles,
  onOpenBackground,
  onStartVideo,
  onStartCall,
  onInviteGame,
  onTogglePrivateMode,
  onOpenSafetyModal
}) => {
  const { t } = useI18n();
  // Texte brut (infobulles) : sans balises de mise en forme
  const contactName = stripPlusTags(activeContact.nickname) || activeContact.username || '';

  return (
    <div className="chat-top-actions">
      <span onClick={onOpenFiles} style={{cursor:'pointer'}} title={t.chat.filesTooltip}>{t.chat.files}</span>
      <span onClick={onOpenBackground} style={{cursor:'pointer'}}>{t.chat.background}</span>
      <span onClick={onStartVideo} style={{cursor:'pointer'}}>{t.chat.video}</span>
      <span onClick={onStartCall} style={{cursor:'pointer'}}>{t.chat.call}</span>
      <div className="wlm-games-menu-wrapper">
        <span
          onClick={onToggleGamesMenu}
          style={{ cursor: 'pointer', fontWeight: showGamesMenu ? 'bold' : 'normal' }}
          title={t.chat.gamesMenuTooltip}
        >
          {t.chat.gamesMenu}
        </span>
        {showGamesMenu && (
          <>
            <div
              className="wlm-menu-backdrop"
              onClick={(e) => { e.stopPropagation(); onToggleGamesMenu(); }}
            />
            <div className="wlm-games-dropdown" onClick={e => e.stopPropagation()}>
              <div
                className="wlm-game-menu-item"
                onClick={() => onInviteGame('puissance4')}
                title={t.games.puissance4Title.replace('{name}', contactName)}
              >
                <span className="msn-game-icon">🔴</span>
                <span>{t.games.puissance4}</span>
              </div>
              <div
                className="wlm-game-menu-item"
                onClick={() => onInviteGame('checkers')}
                title={t.games.checkersTitle.replace('{name}', contactName)}
              >
                <span className="msn-game-icon">⚪</span>
                <span>{t.games.checkers}</span>
              </div>
              <div
                className="wlm-game-menu-item"
                onClick={() => onInviteGame('minesweeper')}
                title={t.games.minesweeperTitle.replace('{name}', contactName)}
              >
                <span className="msn-game-icon">💣</span>
                <span>{t.games.minesweeper}</span>
              </div>
              <div
                className="wlm-game-menu-item"
                onClick={() => onInviteGame('morpion')}
                title={t.games.morpionTitle.replace('{name}', contactName)}
              >
                <span className="msn-game-icon">🎮</span>
                <span>{t.games.morpion}</span>
              </div>
            </div>
          </>
        )}
      </div>
      <span
        onClick={onTogglePrivateMode}
        style={{ cursor: 'pointer', fontWeight: (globalPrivateMode || isPrivateMode[activeChatId]) ? 'bold' : 'normal', color: (globalPrivateMode || isPrivateMode[activeChatId]) ? '#00FF00' : 'inherit' }}
        title={t.chat.privateModeTooltip}
      >
        {t.chat.privateMode}
      </span>
      {activeChatId !== SYSTEM_BOT_ID && (
        <span
          onClick={() => onOpenSafetyModal(activeChatId)}
          style={{ cursor: 'pointer' }}
          title={t.chat.verifyIdentity}
        >
          {t.chat.verifyIdentity}
        </span>
      )}
    </div>
  );
};
