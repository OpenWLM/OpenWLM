import React from 'react';
import { useI18n } from '../i18n';
import type { MyEmoticonRecord } from '../utils/CustomEmoticonsDB';

/**
 * Modale « Toutes les émoticônes » : émoticônes personnalisées (E2EE) puis émoticônes
 * standard. Présentation pure : `onSelect(shortcut)` insère le raccourci dans la saisie,
 * `onManage` ouvre le gestionnaire d'émoticônes perso, `onClose` ferme.
 */

interface AllEmoticonsModalProps {
  customEmoticons: MyEmoticonRecord[];
  customEmoticonsMap: Record<string, { url?: string }>;
  standardEmoticons: { shortcut: string; file: string }[];
  onSelect: (shortcut: string) => void;
  onManage: () => void;
  onClose: () => void;
}

export const AllEmoticonsModal: React.FC<AllEmoticonsModalProps> = ({
  customEmoticons,
  customEmoticonsMap,
  standardEmoticons,
  onSelect,
  onManage,
  onClose
}) => {
  const { t } = useI18n();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-box emoticons-all-modal" onClick={e => e.stopPropagation()} style={{ width: '440px' }}>
        <div className="win-modal-header">
          <span>{t.modals.allEmoticonsTitle}</span>
          <button className="win-close-btn" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '12px 16px', maxHeight: '420px', overflowY: 'auto' }}>
          {/* Section Mes émoticônes */}
          <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #d0e0ee' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#004b8d' }}>
                {t.chat.myEmoticons} ({customEmoticons.length})
              </span>
              <button
                type="button"
                className="win-btn"
                style={{ fontSize: '10px', padding: '2px 8px' }}
                onClick={onManage}
              >
                {t.modals.addManageBtn}
              </button>
            </div>
            {customEmoticons.length === 0 ? (
              <div style={{ fontSize: '11px', color: '#888', fontStyle: 'italic', padding: '6px 0' }}>
                {t.chat.noCustomEmoticons}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
                {customEmoticons.map((emo) => {
                  const emoUrl = customEmoticonsMap[emo.shortcut]?.url;
                  return (
                    <div
                      key={emo.id}
                      className="emoticon-item-large"
                      title={emo.shortcut}
                      onClick={() => onSelect(emo.shortcut)}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', padding: '4px', border: '1px solid #e0eaf2', borderRadius: '4px' }}
                    >
                      {emoUrl ? (
                        <img src={emoUrl} alt={emo.shortcut} style={{ width: '24px', height: '24px', objectFit: 'contain' }} />
                      ) : (
                        <span style={{ fontSize: '10px' }}>...</span>
                      )}
                      <span style={{ fontSize: '9px', color: '#444', marginTop: '2px', maxWidth: '50px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emo.shortcut}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section Émoticônes standard */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#004b8d', marginBottom: '8px' }}>
              {t.chat.standardEmoticons}
            </div>
            <div className="emoticon-all-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '10px' }}>
              {standardEmoticons.map((emo, idx) => (
                <div key={idx} className="emoticon-item-large" title={emo.shortcut} onClick={() => onSelect(emo.shortcut)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                  <img src={`/assets/emoticons/${emo.file}`} alt={emo.shortcut} width={19} height={19} draggable={false} />
                  <span style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>{emo.shortcut}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: '10px', padding: '10px 14px', borderTop: '1px solid #ddd', textAlign: 'right', background: '#f5f5f5' }}>
          <button className="win-btn" onClick={onClose}>{t.common.close}</button>
        </div>
      </div>
    </div>
  );
};
