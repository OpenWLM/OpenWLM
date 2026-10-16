import React from 'react';
import { formatNickname } from '../utils/NicknameFormatter';
import { SYSTEM_BOT_ID, SYSTEM_BOT_CONTACT, type Contact } from '../types';

/**
 * Barre des onglets de conversation ouvertes.
 * Présentation pure : aucun état interne. Les listes, l'onglet actif, l'état de glisser-
 * déposer et les callbacks (sélection, fermeture, réordonnancement) viennent de `App`.
 */

interface ChatTabsBarProps {
  openChatIds: number[];
  contacts: Contact[];
  activeChatId: number;
  draggedTabId: number | null;
  dragOverTabId: number | null;
  dropPosition: 'left' | 'right' | null;
  /** Indique si l'onglet correspond à une partie en cours ou reprenable (icône 🎮). */
  isGameTab: (id: number) => boolean;
  onSelectTab: (id: number) => void;
  onCloseTab: (e: React.MouseEvent, id: number) => void;
  onMobileBack: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, id: number) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, id: number) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>, id: number) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, id: number) => void;
  onDragEnd: () => void;
}

export const ChatTabsBar: React.FC<ChatTabsBarProps> = ({
  openChatIds,
  contacts,
  activeChatId,
  draggedTabId,
  dragOverTabId,
  dropPosition,
  isGameTab,
  onSelectTab,
  onCloseTab,
  onMobileBack,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}) => {
  return (
    <div className="chat-tabs-bar">
      <div className="mobile-back-btn" onClick={onMobileBack}>◀</div>
      {openChatIds.map(id => {
        const contact = id === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === id);
        const isDragging = draggedTabId === id;
        const isDragOver = dragOverTabId === id;
        const dropClass = isDragOver && dropPosition ? (dropPosition === 'left' ? 'drop-target-left' : 'drop-target-right') : '';
        return (
          <div
            key={id}
            draggable={true}
            onDragStart={(e) => onDragStart(e, id)}
            onDragOver={(e) => onDragOver(e, id)}
            onDragLeave={(e) => onDragLeave(e, id)}
            onDrop={(e) => onDrop(e, id)}
            onDragEnd={onDragEnd}
            className={`chat-tab status-${contact?.status || 'online'} ${activeChatId === id ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${dropClass}`.trim()}
            onClick={() => onSelectTab(id)}
          >
            <span className="tab-name">
              {contact?.isBot ? '🤖 ' : ''}{formatNickname(contact?.nickname || contact?.username || 'Discussion')}{isGameTab(id) ? ' 🎮' : ''}
            </span>
            <span
              className="chat-tab-close"
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onCloseTab(e, id)}
            >
              ✕
            </span>
          </div>
        );
      })}
    </div>
  );
};
