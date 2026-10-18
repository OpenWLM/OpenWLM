import React from 'react';
import { useI18n } from '../i18n';

/**
 * Coquille de la fenêtre de conversation : conteneur principal + état vide.
 *
 * Composant de mise en page : quand aucune discussion n'est ouverte, affiche l'état vide
 * (avec le bouton de test de l'assistant) ; sinon, compose la barre d'onglets, la barre
 * d'outils et le contenu de la conversation (journal + composeur + jeu), fournis par `App`
 * via les slots `tabs`, `toolbar` et `children`.
 */

interface ChatWindowProps {
  activeChatId: number;
  /** Des onglets sont ouverts : la barre reste visible au-dessus de l'écran d'accueil. */
  hasOpenChats?: boolean;
  isNudging: boolean;
  onStartBotChat: () => void;
  tabs: React.ReactNode;
  toolbar: React.ReactNode;
  children: React.ReactNode;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  activeChatId,
  hasOpenChats = false,
  isNudging,
  onStartBotChat,
  tabs,
  toolbar,
  children
}) => {
  const { t } = useI18n();

  return (
    <div className={`conversation-window ${isNudging ? 'wlm-nudge' : ''}`}>
      {activeChatId === 0 ? (
        /* État vide si aucune discussion n'est sélectionnée (les onglets restent visibles :
           un message reçu ouvre un onglet qui clignote tant qu'il n'est pas lu) */
        <>
        {hasOpenChats && tabs}
        <div className="empty-chat-state">
          <div className="msn-butterfly giant"></div>
          <div className="welcome-text">{t.roster.emptyStateTitle}</div>
          <div className="sub-welcome">{t.roster.emptyStateSubtitle}</div>
          <div style={{ marginTop: '16px' }}>
            <button
              type="button"
              className="win-btn"
              onClick={onStartBotChat}
              style={{ padding: '6px 14px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 600 }}
            >
              <span>🤖</span>
              <span>{t.roster.startTestChat}</span>
            </button>
          </div>
          <div style={{ fontSize: '11px', color: '#777', marginTop: '10px' }}>
            {t.roster.emptyStateBotHint}
          </div>
        </div>
        </>
      ) : (
        <>
          {tabs}
          {toolbar}
          {children}
        </>
      )}
    </div>
  );
};
