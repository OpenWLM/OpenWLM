import React from 'react';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';
import { SYSTEM_BOT_ID, type Contact } from '../types';
import { useAppPrefs } from '../utils/appPrefs';

/**
 * Liste des contacts (roster) : invitations en attente, groupes « En ligne » / « Hors ligne »
 * et assistant OpenWLM. Présentation pure : les listes filtrées et les callbacks
 * (ouverture de conversation, menu contextuel, invitations) viennent de `App`.
 */

interface PendingInvite {
  id: number;
  nickname?: string;
  username?: string;
}

interface ContactRosterProps {
  /** Messages non lus par contact (mise en avant dans la liste). */
  unreadCounts?: Record<number, number>;
  pendingInvites: PendingInvite[];
  onlineContacts: Contact[];
  offlineContacts: Contact[];
  activeChatId: number;
  isGroupOpen: boolean;
  onToggleOnlineGroup: () => void;
  isOfflineGroupOpen: boolean;
  onToggleOfflineGroup: () => void;
  isServicesGroupOpen: boolean;
  onToggleServicesGroup: () => void;
  onOpenChat: (id: number) => void;
  onAcceptInvite: (id: number) => void;
  onDeclineInvite: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
}

export const ContactRoster: React.FC<ContactRosterProps> = ({
  unreadCounts = {},
  pendingInvites,
  onlineContacts,
  offlineContacts,
  activeChatId,
  isGroupOpen,
  onToggleOnlineGroup,
  isOfflineGroupOpen,
  onToggleOfflineGroup,
  isServicesGroupOpen,
  onToggleServicesGroup,
  onOpenChat,
  onAcceptInvite,
  onDeclineInvite,
  onContextMenu
}) => {
  const { t } = useI18n();
  const { showPsm, showOffline, showBot } = useAppPrefs().layout;

  const caret = (open: boolean) => (
    <span style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
  );

  return (
    <div className="contact-roster">
      {/* Invitations en attente */}
      {pendingInvites.length > 0 && (
        <div className="pending-section">
          <div className="group-header">{t.roster.pendingInvites} ({pendingInvites.length})</div>
          {pendingInvites.map(invite => (
            <div key={invite.id} className="contact-row pending">
              <div className="status-square offline"></div>
              <div className="contact-name-txt" style={{flex: 1, marginLeft: '10px'}}>{formatNickname(invite.nickname || invite.username)}</div>
              <div style={{display:'flex', gap:'5px', marginRight: '10px'}}>
                <button className="win-btn mini" onClick={() => onAcceptInvite(invite.id)}>{t.roster.accept}</button>
                <button className="win-btn mini secondary" onClick={() => onDeclineInvite(invite.id)}>{t.roster.decline}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Contacts en ligne */}
      <div className="group-header" onClick={onToggleOnlineGroup}>
        {caret(isGroupOpen)}
        {t.roster.onlineGroup} ({onlineContacts.length})
      </div>
      {isGroupOpen && onlineContacts.map(contact => (
        <div
          key={contact.id}
          className={`contact-row ${activeChatId === contact.id ? 'active' : ''} ${unreadCounts[contact.id] ? 'contact-unread' : ''}`}
          onClick={() => onOpenChat(contact.id)}
          onContextMenu={(e) => onContextMenu(e, contact.id)}
        >
          <div className={`status-square ${contact.status || 'online'}`}></div>
          <div className="contact-name-txt">
            {formatNickname(contact.nickname || contact.username)}
            {unreadCounts[contact.id] ? <span className="contact-unread-badge" title={`${unreadCounts[contact.id]}`}>✉ {unreadCounts[contact.id]}</span> : null}
            {showPsm && contact.psm && <span className="contact-psm-txt"> - {formatNickname(contact.psm)}</span>}
          </div>
        </div>
      ))}

      {/* Contacts hors ligne ou bloqués (hors ligne masquables : Options → Disposition) */}
      {(showOffline || offlineContacts.length > 0) && <div className="group-header" onClick={onToggleOfflineGroup}>
        {caret(isOfflineGroupOpen)}
        {t.roster.offlineGroup} ({offlineContacts.length})
      </div>}
      {isOfflineGroupOpen && offlineContacts.map(contact => (
        <div
          key={contact.id}
          className={`contact-row ${activeChatId === contact.id ? 'active' : ''} ${unreadCounts[contact.id] ? 'contact-unread' : ''}`}
          onClick={() => onOpenChat(contact.id)}
          onContextMenu={(e) => onContextMenu(e, contact.id)}
        >
          <div className={`status-square offline`}></div>
          <div className="contact-name-txt" style={{color: contact.blocked ? '#f44336' : '#999'}}>
            {formatNickname(contact.nickname || contact.username)}
            {unreadCounts[contact.id] ? <span className="contact-unread-badge" title={`${unreadCounts[contact.id]}`}>✉ {unreadCounts[contact.id]}</span> : null}
            {showPsm && contact.psm && <span className="contact-psm-txt"> - {formatNickname(contact.psm)}</span>}
            {contact.blocked ? <span style={{fontSize:'10px', marginLeft: '5px'}}>{t.roster.blockedSuffix}</span> : ''}
          </div>
        </div>
      ))}

      {/* Contact de test « OpenWLM » (masquable : Options → Disposition) */}
      {showBot && <div className="group-header" onClick={onToggleServicesGroup}>
        {caret(isServicesGroupOpen)}
        {t.roster.botSection} (1)
      </div>}
      {showBot && isServicesGroupOpen && (
        <div
          className={`contact-row ${activeChatId === SYSTEM_BOT_ID ? 'active' : ''}`}
          onClick={() => onOpenChat(SYSTEM_BOT_ID)}
          title={t.bot.tooltip}
        >
          <div className="status-square online"></div>
          <div className="contact-name-txt" style={{ display: 'flex', alignItems: 'center', gap: '3px', overflow: 'hidden' }}>
            <span style={{ fontWeight: 600 }}>{t.bot.name}</span>
            <span className="wlm-bot-badge">{t.bot.badge}</span>
            <span className="contact-psm-txt"> - {t.bot.status}</span>
          </div>
        </div>
      )}
    </div>
  );
};
