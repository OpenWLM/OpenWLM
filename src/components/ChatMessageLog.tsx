import React from 'react';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';
import { resolveMessageSide } from '../utils/MessageIdentity';
import FileTransferCard, { isImageFile } from './FileTransferCard';
import VoiceClipPlayer from './VoiceClipPlayer';
import { SYSTEM_BOT_ID, SYSTEM_BOT_CONTACT, type Contact, type Message } from '../types';

/**
 * Journal des messages de la conversation active + actions rapides de test pour OpenWLM.
 * Présentation pure : les messages, le contact, les callbacks (renvoi, action assistant) et
 * le rendu riche du corps (`renderMessageContent`, gardé dans `App` car lié aux émoticônes)
 * sont fournis en props. Les helpers purs (resolveMessageSide, isImageFile, formatNickname)
 * sont importés directement.
 */

interface ChatMessageLogProps {
  messages: Message[];
  activeChatId: number;
  contacts: Contact[];
  myId: number | undefined;
  selfDisplayName: string;
  myPrivateKeyJwk: any;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  onResend: (chatId: number, clientMsgId: string) => void;
  onAssistantAction: (action: 'emo' | 'wizz' | 'sons' | 'morpion' | 'puissance4' | 'help') => void;
  renderMessageContent: (text: string, style?: any) => React.ReactNode;
}

export const ChatMessageLog: React.FC<ChatMessageLogProps> = ({
  messages,
  activeChatId,
  contacts,
  myId,
  selfDisplayName,
  myPrivateKeyJwk,
  chatEndRef,
  onResend,
  onAssistantAction,
  renderMessageContent
}) => {
  const { t } = useI18n();

  return (
    <>
      {/* Historique des messages (Scrollable) */}
      <div className="chat-log-scroll">
        {messages.map((m, i) => {
          const messageSide = resolveMessageSide(m, myId);
          const isSender = messageSide === 'self';
          const activeContact = activeChatId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === activeChatId);
          const senderDisplayName = isSender
            ? selfDisplayName
            : (messageSide === 'unknown'
                ? t.chat.unknownSender
                : (m.sender && m.sender !== 'Contact' ? m.sender : (activeContact?.nickname || activeContact?.username || m.sender || 'Contact')));

          const isImage = isImageFile(m.fileData);
          const fileHeaderLabel = isSender
            ? (isImage ? t.chat.youSentImage : t.chat.youSentFile)
            : (isImage ? t.chat.contactSentImage.replace('{name}', senderDisplayName) : t.chat.contactSentFile.replace('{name}', senderDisplayName));

          return (
          <div key={i} className="msg-line">
             {m.sender === 'Système' ? (
               <div className="msg-system">{m.text}</div>
             ) : (
               <>
                 <div className={`msg-name ${isSender ? 'me' : ''}`}>
                   <span>{m.fileData ? formatNickname(fileHeaderLabel) : <>{formatNickname(senderDisplayName)} {t.chat.says}</>}</span>
                   {m.time && <span className="msg-time">{m.time}</span>}
                   {isSender && activeChatId !== SYSTEM_BOT_ID && m._failed && (
                     <span className="msg-send-failed" role="alert">
                       <span
                         title={
                           m._failed === 'offline_private' ? t.chat.sendFailedOfflinePrivate :
                           m._failed === 'too_large' ? t.chat.sendFailedTooLarge :
                           (m._failReason || t.chat.sendFailedGeneric)
                         }
                       >
                         ⚠ {t.chat.notSent}
                       </span>
                       {m._failed !== 'too_large' && m.clientMsgId && (
                         <button
                           type="button"
                           className="msg-resend-btn"
                           onClick={() => onResend(activeChatId, m.clientMsgId as string)}
                         >
                           {t.chat.resend}
                         </button>
                       )}
                     </span>
                   )}
                   {isSender && activeChatId !== SYSTEM_BOT_ID && !m._failed && (
                     <span
                       className={`msg-status-badge status-${m.delivery_status || (m._isPending ? 'pending' : 'sent')}`}
                       title={
                         m.delivery_status === 'read' ? t.chat.statusRead :
                         m.delivery_status === 'delivered' ? t.chat.statusDelivered :
                         t.chat.statusSent
                       }
                     >
                       {m.delivery_status === 'read' ? '✓✓' : (m.delivery_status === 'delivered' ? '✓✓' : '✓')}
                     </span>
                   )}
                 </div>
                 {isSender && (m._failed === 'offline_private' || m._failed === 'too_large') && (
                   <div className="msg-send-failed-detail">
                     {m._failed === 'offline_private' ? t.chat.sendFailedOfflinePrivate : t.chat.sendFailedTooLarge}
                   </div>
                 )}
                 {(m._auth === 'invalid' || m._auth === 'plaintext' || m._auth === 'unsigned-legacy' || m._auth === 'unverifiable') ? (
                   <div className="msg-rejected" role="alert">
                     ⛔ {m._auth === 'plaintext' ? t.chat.authRejectedPlaintext
                       : m._auth === 'unsigned-legacy' ? t.chat.authUnsignedLegacy
                       : m._auth === 'unverifiable' ? t.chat.authUnverifiable
                       : t.chat.authRejectedInvalid}
                   </div>
                 ) : m.fileData ? (
                   <FileTransferCard
                     fileData={m.fileData}
                     myPrivateKey={myPrivateKeyJwk}
                     isSender={isSender}
                   />
                 ) : m.audio ? (
                   <VoiceClipPlayer src={m.audio} />
                 ) : (
                   renderMessageContent(m.text, m.style)
                 )}
               </>
             )}
          </div>
        );
        })}
        <div ref={chatEndRef} />
      </div>

      {/* Actions rapides de test pour OpenWLM */}
      {activeChatId === SYSTEM_BOT_ID && (
        <div className="wlm-bot-quick-actions">
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('emo')} title={t.bot.chipEmoticons}>
            {t.bot.chipEmoticons}
          </button>
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('wizz')} title={t.bot.chipWizz}>
            {t.bot.chipWizz}
          </button>
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('sons')} title={t.bot.chipSounds}>
            {t.bot.chipSounds}
          </button>
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('morpion')} title={t.bot.chipMorpion}>
            {t.bot.chipMorpion}
          </button>
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('puissance4')} title={t.bot.chipPuissance4}>
            {t.bot.chipPuissance4}
          </button>
          <button type="button" className="wlm-chip-btn" onClick={() => onAssistantAction('help')} title={t.bot.chipHelp}>
            {t.bot.chipHelp}
          </button>
        </div>
      )}
    </>
  );
};
