import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { isSystemNotificationSupported } from '../utils/NotificationManager';
import { isAndroidDevice, isPushSupported, type PushBackendStatus } from '../utils/PushNotificationManager';
import { saveAwayTimeout, saveEnableAutoAway, clampAwayTimeout, AWAY_TIMEOUT_MIN, AWAY_TIMEOUT_MAX } from '../utils/profileStorage';
import type { SystemIdlePermission, SystemIdleSupport } from '../utils/systemIdle';
import type { User } from '../types';
import { useAppPrefs, updateAppPrefs } from '../utils/appPrefs';
import LocalDB from '../utils/LocalDB';
import SoundManager from '../utils/SoundManager';

/**
 * Modale d'options (Paramètres). Onglets « Personnel » et « Alertes ».
 *
 * Composant de présentation piloté par props : le profil (pseudo, PSM), les préférences
 * (auto-absence, toasts) et l'état/les actions de notifications viennent de `App` / des
 * hooks. L'onglet actif est un état local à la modale ; l'i18n est lue directement.
 */

interface OptionsModalProps {
  myNickname: string;
  setMyNickname: (value: string) => void;
  myPSM: string;
  setMyPSM: (value: string) => void;
  enableAutoAway: boolean;
  setEnableAutoAway: (value: boolean) => void;
  awayTimeout: number;
  setAwayTimeout: (value: number) => void;
  systemIdleEnabled: boolean;
  systemIdleRunning: boolean;
  systemIdleSupport: SystemIdleSupport;
  enableSystemIdle: () => Promise<SystemIdlePermission>;
  disableSystemIdle: () => void;
  enableDesktopToasts: boolean;
  setEnableDesktopToasts: (value: boolean) => void;
  systemPermission: NotificationPermission | 'unsupported';
  prepromptDismissed: boolean;
  setPrepromptDismissed: (value: boolean) => void;
  permissionAttempted: boolean;
  testAlertFeedback: string | null;
  pushStatus: PushBackendStatus | null;
  pushTestFeedback: string | null;
  handleRequestPermission: () => void;
  handleTestAlert: () => void;
  handleTestPush: () => void;
  syncProfile: (updates: Partial<User>) => void;
  onClose: () => void;
}

export const OptionsModal: React.FC<OptionsModalProps> = ({
  myNickname,
  setMyNickname,
  myPSM,
  setMyPSM,
  enableAutoAway,
  setEnableAutoAway,
  awayTimeout,
  setAwayTimeout,
  systemIdleEnabled,
  systemIdleRunning,
  systemIdleSupport,
  enableSystemIdle,
  disableSystemIdle,
  enableDesktopToasts,
  setEnableDesktopToasts,
  systemPermission,
  prepromptDismissed,
  setPrepromptDismissed,
  permissionAttempted,
  testAlertFeedback,
  pushStatus,
  pushTestFeedback,
  handleRequestPermission,
  handleTestAlert,
  handleTestPush,
  syncProfile,
  onClose
}) => {
  const { t, language, setLanguage } = useI18n();
  const [optionsTab, setOptionsTab] = useState<'personal' | 'layout' | 'messages' | 'alerts' | 'sounds'>('personal');
  const prefs = useAppPrefs();
  const [cacheCleared, setCacheCleared] = useState(false);
  // Brouillon du délai d'inactivité : permet d'effacer le champ pour retaper une valeur
  const [awayTimeoutDraft, setAwayTimeoutDraft] = useState(() => String(awayTimeout));
  const [systemIdleDenied, setSystemIdleDenied] = useState(false);

  return (
    <div className="modal-bg">
      <div className="modal-box wlm-options-modal" style={{ width: '550px' }}>
        <div className="win-modal-header">
          <span>{t.settings.optionsTitle}</span>
          <button className="win-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="options-body">
          <div className="options-sidebar">
            <div className={`options-nav-item ${optionsTab === 'personal' ? 'active' : ''}`} onClick={() => setOptionsTab('personal')}>{t.settings.tabPersonal}</div>
            <div className={`options-nav-item ${optionsTab === 'layout' ? 'active' : ''}`} onClick={() => setOptionsTab('layout')}>{t.settings.tabLayout}</div>
            <div className={`options-nav-item ${optionsTab === 'messages' ? 'active' : ''}`} onClick={() => setOptionsTab('messages')}>{t.settings.tabMessages}</div>
            <div className={`options-nav-item ${optionsTab === 'alerts' ? 'active' : ''}`} onClick={() => setOptionsTab('alerts')}>{t.settings.tabAlerts}</div>
            <div className={`options-nav-item ${optionsTab === 'sounds' ? 'active' : ''}`} onClick={() => setOptionsTab('sounds')}>{t.settings.tabSounds}</div>
            <div className="options-nav-item">{t.settings.tabSecurity}</div>
            <div className="options-nav-item">{t.settings.tabConnection}</div>
          </div>

          <div className="options-content">
            {optionsTab === 'personal' && (
              <div className="options-section">
                <div className="options-title">{t.settings.tabPersonal}</div>

                <div className="options-subsection">
                  <label className="options-label">{t.auth.nicknameLabel.replace(':', '')}</label>
                  <div className="options-hint">{t.settings.nicknameSub}</div>
                  <input
                    className="win-input"
                    value={myNickname}
                    onChange={e => setMyNickname(e.target.value)}
                    style={{ width: '90%' }}
                  />
                </div>

                <div className="options-subsection">
                  <div className="options-hint">{t.settings.psmSub}</div>
                  <input
                    className="win-input"
                    value={myPSM}
                    onChange={e => setMyPSM(e.target.value)}
                    style={{ width: '90%' }}
                  />
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.common.language}</label>
                  <div style={{ marginTop: '5px' }}>
                    <select
                      value={language}
                      onChange={e => setLanguage(e.target.value as 'fr' | 'en')}
                      className="wlm-auth-select"
                      style={{ width: '160px', padding: '3px 6px' }}
                    >
                      <option value="fr">{t.common.french}</option>
                      <option value="en">{t.common.english}</option>
                    </select>
                  </div>
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.settings.statusSection}</label>
                  <div className="options-checkbox-line">
                    <input
                      type="checkbox"
                      id="check-away"
                      checked={enableAutoAway}
                      onChange={e => {
                        setEnableAutoAway(e.target.checked);
                        saveEnableAutoAway(e.target.checked);
                      }}
                    />
                    <label htmlFor="check-away">{t.settings.autoAwayPrefix}</label>
                    <input
                      type="number"
                      id="away-timeout"
                      className="win-input-small"
                      min={AWAY_TIMEOUT_MIN}
                      max={AWAY_TIMEOUT_MAX}
                      step={1}
                      value={awayTimeoutDraft}
                      disabled={!enableAutoAway}
                      aria-label={`${t.settings.autoAwayPrefix}${t.settings.autoAwaySuffix}`}
                      onChange={e => {
                        // Saisie libre (on peut effacer pour retaper) ; appliquée si valide
                        setAwayTimeoutDraft(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n) && n >= AWAY_TIMEOUT_MIN && n <= AWAY_TIMEOUT_MAX) {
                          setAwayTimeout(n);
                          saveAwayTimeout(n);
                        }
                      }}
                      onBlur={() => {
                        const n = clampAwayTimeout(awayTimeoutDraft, awayTimeout);
                        setAwayTimeoutDraft(String(n));
                        setAwayTimeout(n);
                        saveAwayTimeout(n);
                      }}
                      style={{ width: '44px', textAlign: 'center', margin: '0 5px' }}
                    />
                    <span>{t.settings.autoAwaySuffix}</span>
                  </div>
                  {/* Inactivité de tout l'ordinateur (API Idle Detection), comme sur MSN */}
                  <div className="options-checkbox-line">
                    <input
                      type="checkbox"
                      id="check-system-idle"
                      checked={systemIdleEnabled}
                      disabled={!enableAutoAway || systemIdleSupport !== 'available'}
                      onChange={async e => {
                        if (e.target.checked) {
                          const permission = await enableSystemIdle();
                          setSystemIdleDenied(permission !== 'granted');
                        } else {
                          setSystemIdleDenied(false);
                          disableSystemIdle();
                        }
                      }}
                    />
                    <label htmlFor="check-system-idle">{t.settings.systemIdleLabel}</label>
                  </div>
                  <div className="options-hint" id="system-idle-hint">
                    {systemIdleSupport === 'unsupported' ? t.settings.systemIdleUnsupported
                      : systemIdleSupport === 'insecure' ? t.settings.systemIdleInsecure
                      : systemIdleDenied ? t.settings.systemIdleDenied
                      : systemIdleEnabled && systemIdleRunning ? t.settings.systemIdleActive
                      : systemIdleEnabled ? t.settings.systemIdleBlocked
                      : t.settings.systemIdleHint}
                  </div>
                </div>

              </div>
            )}

            {optionsTab === 'layout' && (
              <div className="options-section">
                <div className="options-title">{t.settings.tabLayout}</div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.layoutContactList}</label>
                  <PrefCheckbox id="pref-show-offline" checked={prefs.layout.showOffline} onChange={v => updateAppPrefs('layout', { showOffline: v })} label={t.settings.layoutShowOffline} />
                  <PrefCheckbox id="pref-show-psm" checked={prefs.layout.showPsm} onChange={v => updateAppPrefs('layout', { showPsm: v })} label={t.settings.layoutShowPsm} />
                  <PrefCheckbox id="pref-show-bot" checked={prefs.layout.showBot} onChange={v => updateAppPrefs('layout', { showBot: v })} label={t.settings.layoutShowBot} />
                </div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.layoutSort}</label>
                  <div className="options-checkbox-line">
                    <input type="radio" id="pref-sort-status" name="pref-sort" checked={prefs.layout.sortBy === 'status'} onChange={() => updateAppPrefs('layout', { sortBy: 'status' })} />
                    <label htmlFor="pref-sort-status">{t.settings.layoutSortStatus}</label>
                  </div>
                  <div className="options-checkbox-line">
                    <input type="radio" id="pref-sort-name" name="pref-sort" checked={prefs.layout.sortBy === 'name'} onChange={() => updateAppPrefs('layout', { sortBy: 'name' })} />
                    <label htmlFor="pref-sort-name">{t.settings.layoutSortName}</label>
                  </div>
                </div>
                <div className="options-hint">{t.settings.prefsDeviceNote}</div>
              </div>
            )}

            {optionsTab === 'messages' && (
              <div className="options-section">
                <div className="options-title">{t.settings.tabMessages}</div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.messagesDisplay}</label>
                  <PrefCheckbox id="pref-emoticons" checked={prefs.messages.emoticonImages} onChange={v => updateAppPrefs('messages', { emoticonImages: v })} label={t.settings.messagesEmoticons} />
                  <PrefCheckbox id="pref-timestamps" checked={prefs.messages.showTimestamps} onChange={v => updateAppPrefs('messages', { showTimestamps: v })} label={t.settings.messagesTimestamps} />
                </div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.messagesFun}</label>
                  <PrefCheckbox id="pref-nudges" checked={prefs.messages.receiveNudges} onChange={v => updateAppPrefs('messages', { receiveNudges: v })} label={t.settings.messagesNudges} />
                  <PrefCheckbox id="pref-winks" checked={prefs.messages.autoPlayWinks} onChange={v => updateAppPrefs('messages', { autoPlayWinks: v })} label={t.settings.messagesWinks} />
                </div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.messagesHistory}</label>
                  <PrefCheckbox
                    id="pref-local-history"
                    checked={prefs.messages.keepLocalHistory}
                    onChange={v => {
                      updateAppPrefs('messages', { keepLocalHistory: v });
                      // Désactivé : la copie déjà enregistrée sur l'appareil est effacée
                      if (!v) { LocalDB.clearAll().then(() => setCacheCleared(true)).catch(() => {}); }
                    }}
                    label={t.settings.messagesLocalHistory}
                  />
                  <div className="options-hint">{t.settings.messagesLocalHistoryPrivate}</div>
                  <button
                    type="button"
                    className="win-btn"
                    id="pref-clear-cache"
                    style={{ marginTop: '6px' }}
                    onClick={() => { LocalDB.clearAll().then(() => setCacheCleared(true)).catch(() => {}); }}
                  >
                    {t.settings.messagesClearCache}
                  </button>
                  {cacheCleared && <span className="options-hint" role="status" style={{ marginLeft: '8px' }}>{t.settings.messagesCacheCleared}</span>}
                </div>
              </div>
            )}

            {optionsTab === 'sounds' && (
              <div className="options-section">
                <div className="options-title">{t.settings.tabSounds}</div>
                <div className="options-subsection">
                  <PrefCheckbox id="pref-sounds" checked={prefs.sounds.enabled} onChange={v => updateAppPrefs('sounds', { enabled: v })} label={t.settings.soundsEnable} />
                  <div className="options-checkbox-line">
                    <label htmlFor="pref-volume">{t.settings.soundsVolume}</label>
                    <input
                      type="range"
                      id="pref-volume"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(prefs.sounds.volume * 100)}
                      disabled={!prefs.sounds.enabled}
                      onChange={e => updateAppPrefs('sounds', { volume: Number(e.target.value) / 100 })}
                      style={{ margin: '0 8px', flex: '1 1 120px', maxWidth: '180px' }}
                    />
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(prefs.sounds.volume * 100)} %</span>
                    <button type="button" className="win-btn" style={{ marginLeft: '8px' }} disabled={!prefs.sounds.enabled} onClick={() => SoundManager.play('NEW_MESSAGE')}>{t.settings.soundsTest}</button>
                  </div>
                </div>
                <div className="options-subsection">
                  <label className="options-label">{t.settings.soundsEvents}</label>
                  <PrefCheckbox id="pref-snd-message" disabled={!prefs.sounds.enabled} checked={prefs.sounds.message} onChange={v => updateAppPrefs('sounds', { message: v })} label={t.settings.soundsMessage} />
                  <PrefCheckbox id="pref-snd-online" disabled={!prefs.sounds.enabled} checked={prefs.sounds.contactOnline} onChange={v => updateAppPrefs('sounds', { contactOnline: v })} label={t.settings.soundsContactOnline} />
                  <PrefCheckbox id="pref-snd-nudge" disabled={!prefs.sounds.enabled} checked={prefs.sounds.nudge} onChange={v => updateAppPrefs('sounds', { nudge: v })} label={t.settings.soundsNudge} />
                  <PrefCheckbox id="pref-snd-winks" disabled={!prefs.sounds.enabled} checked={prefs.sounds.winks} onChange={v => updateAppPrefs('sounds', { winks: v })} label={t.settings.soundsWinks} />
                  <PrefCheckbox id="pref-snd-call" disabled={!prefs.sounds.enabled} checked={prefs.sounds.call} onChange={v => updateAppPrefs('sounds', { call: v })} label={t.settings.soundsCall} />
                  <PrefCheckbox id="pref-snd-games" disabled={!prefs.sounds.enabled} checked={prefs.sounds.games} onChange={v => updateAppPrefs('sounds', { games: v })} label={t.settings.soundsGames} />
                </div>
                <div className="options-subsection">
                  <PrefCheckbox id="pref-snd-busy" disabled={!prefs.sounds.enabled} checked={prefs.sounds.muteWhenBusy} onChange={v => updateAppPrefs('sounds', { muteWhenBusy: v })} label={t.settings.soundsMuteBusy} />
                </div>
                <div className="options-hint">{t.settings.prefsDeviceNote}</div>
              </div>
            )}

            {optionsTab === 'alerts' && (
              <div className="options-section">
                <div className="options-title">{t.settings.alertsTitle}</div>

                <div className="options-subsection">
                  <div className="options-checkbox-line">
                    <input
                      type="checkbox"
                      id="check-desktop-toasts"
                      checked={enableDesktopToasts}
                      onChange={e => setEnableDesktopToasts(e.target.checked)}
                    />
                    <label htmlFor="check-desktop-toasts" style={{ fontWeight: 600 }}>{t.settings.desktopToastEnable}</label>
                  </div>
                  <div className="options-hint" style={{ marginTop: '4px', marginLeft: '22px' }}>
                    {t.settings.desktopToastDesc}
                  </div>
                </div>

                <div className="options-subsection" style={{ marginTop: '16px' }}>
                  <label className="options-label">{t.settings.browserNotifSection}</label>
                  <div style={{ marginTop: '4px', marginBottom: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 600 }}>{t.settings.browserNotifStatusLabel}</span>
                    <span style={{
                      fontWeight: 600,
                      color: systemPermission === 'granted' ? '#1b7d23' : systemPermission === 'denied' ? '#c02717' : '#555'
                    }}>
                      {systemPermission === 'granted'
                        ? t.settings.browserNotifStatusGranted
                        : systemPermission === 'denied'
                        ? t.settings.browserNotifStatusDenied
                        : systemPermission === 'unsupported'
                        ? t.settings.browserNotifStatusUnsupported
                        : t.settings.browserNotifStatusDefault}
                    </span>
                  </div>

                  <div className="options-hint" style={{ marginBottom: '10px' }}>
                    {systemPermission === 'granted'
                      ? t.settings.browserNotifGranted
                      : systemPermission === 'denied'
                      ? t.settings.browserNotifDenied
                      : systemPermission === 'unsupported'
                      ? t.settings.browserNotifUnsupported
                      : t.settings.browserNotifDefault}
                  </div>

                  {systemPermission === 'denied' && (
                    <div style={{ marginTop: '-4px', marginBottom: '10px', fontSize: '10px', color: '#888', fontStyle: 'italic' }}>
                      {t.settings.browserNotifEdgePath}
                    </div>
                  )}

                  {systemPermission === 'default' && isSystemNotificationSupported() && !prepromptDismissed && (
                    <div className="options-preprompt-box" style={{
                      marginTop: '4px',
                      marginBottom: '12px',
                      padding: '8px 10px',
                      background: 'linear-gradient(to bottom, #f0f7ff 0%, #e3f0fc 100%)',
                      border: '1px solid #b8d6f3',
                      borderRadius: '3px'
                    }}>
                      <div style={{ fontSize: '11px', color: '#1a3b5c', marginBottom: '8px', lineHeight: '1.4' }}>
                        {t.settings.browserNotifPreprompt}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          type="button"
                          className="win-btn"
                          onClick={handleRequestPermission}
                          style={{ fontWeight: 600 }}
                        >
                          {t.settings.browserNotifPrompt}
                        </button>
                        <button
                          type="button"
                          className="win-btn"
                          onClick={() => setPrepromptDismissed(true)}
                        >
                          {t.settings.browserNotifLater}
                        </button>
                      </div>
                    </div>
                  )}

                  {systemPermission === 'default' && isSystemNotificationSupported() && prepromptDismissed && (
                    <div style={{ marginBottom: '12px' }}>
                      <button
                        type="button"
                        className="win-btn"
                        onClick={handleRequestPermission}
                      >
                        {t.settings.browserNotifPrompt}
                      </button>
                    </div>
                  )}

                  {systemPermission === 'default' && permissionAttempted && isSystemNotificationSupported() && (
                    <div className="options-edge-box" style={{
                      marginTop: '4px',
                      marginBottom: '12px',
                      padding: '8px 10px',
                      background: '#fffde7',
                      border: '1px solid #e0c875',
                      borderRadius: '3px',
                      fontSize: '11px',
                      color: '#443c1b',
                      lineHeight: '1.4'
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span>🔔</span>
                        <span>{t.settings.browserNotifEdgeTitle}</span>
                      </div>
                      <div>{t.settings.browserNotifEdgeHelp}</div>
                      <div style={{ marginTop: '5px', fontSize: '10px', color: '#6d5a1b', fontStyle: 'italic' }}>
                        {t.settings.browserNotifEdgePath}
                      </div>
                      <div style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          className="win-btn"
                          onClick={handleRequestPermission}
                          style={{ fontSize: '11px', padding: '2px 8px' }}
                        >
                          {t.settings.browserNotifRetry}
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: '6px' }}>
                    <button
                      type="button"
                      className="win-btn"
                      onClick={handleTestAlert}
                    >
                      {t.settings.testAlertBtn}
                    </button>

                    {testAlertFeedback === 'success' && (
                      <div className="options-hint" style={{ marginTop: '6px', color: '#1b7d23', fontWeight: 600 }}>
                        ✓ {t.settings.testAlertSuccess}
                      </div>
                    )}
                    {testAlertFeedback === 'edge_quiet' && (
                      <div className="options-hint" style={{ marginTop: '6px', color: '#8a6d10', fontWeight: 600 }}>
                        ℹ {t.settings.testAlertEdgeQuiet}
                      </div>
                    )}
                    {testAlertFeedback === 'unconfigured' && (
                      <div className="options-hint" style={{ marginTop: '6px', color: '#8a6d10', fontWeight: 600 }}>
                        ℹ {t.settings.testAlertUnconfigured}
                      </div>
                    )}
                    {testAlertFeedback === 'denied' && (
                      <div className="options-hint" style={{ marginTop: '6px', color: '#c02717', fontWeight: 600 }}>
                        ⚠ {t.settings.testAlertDenied}
                      </div>
                    )}
                    {testAlertFeedback === 'unsupported' && (
                      <div className="options-hint" style={{ marginTop: '6px', color: '#666', fontWeight: 600 }}>
                        ℹ {t.settings.testAlertUnsupported}
                      </div>
                    )}
                  </div>
                </div>

                <div className="options-subsection" style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #d0d0d0' }}>
                  <label className="options-label">
                    {t.settings.androidSectionTitle} {isAndroidDevice() && <span style={{ color: '#0078d7', fontWeight: 'normal', fontSize: '11px' }}>• (Cet appareil)</span>}
                  </label>
                  <div className="options-hint" style={{ marginTop: '4px', lineHeight: '1.4' }}>
                    {t.settings.androidBgDesc}
                  </div>

                  <div style={{ marginTop: '8px', padding: '6px 8px', background: '#f5f5f5', borderRadius: '3px', fontSize: '11px' }}>
                    <div style={{ color: '#2b579a', fontWeight: 600 }}>• {t.settings.androidForegroundHint}</div>
                    <div style={{ color: '#555', marginTop: '4px' }}>• {t.settings.androidBackgroundHint}</div>
                  </div>

                  <div style={{ marginTop: '8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 600 }}>{t.settings.webPushStatusLabel}</span>
                    <span style={{
                      color: isPushSupported() ? (pushStatus?.hasVapid ? '#1b7d23' : '#c87800') : '#666',
                      fontWeight: 600
                    }}>
                      {isPushSupported()
                        ? (pushStatus?.hasVapid ? (t.settings.webPushConfigured || 'Actif (clés VAPID configurées)') : t.settings.webPushReady)
                        : t.settings.browserNotifStatusUnsupported}
                    </span>
                  </div>

                  {isPushSupported() && systemPermission === 'granted' && (
                    <div style={{ marginTop: '10px' }}>
                      <button
                        type="button"
                        className="win-btn"
                        style={{ fontSize: '11px', padding: '3px 10px' }}
                        onClick={handleTestPush}
                      >
                        🔔 {t.settings.pushTestButton || 'Tester la notification Push'}
                      </button>
                      {pushTestFeedback && (
                        <div style={{
                          marginTop: '6px',
                          fontSize: '11px',
                          fontWeight: 500,
                          color: pushTestFeedback.includes('succès') || pushTestFeedback.includes('success') ? '#1b7d23' : '#c02717'
                        }}>
                          {pushTestFeedback}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="win-modal-footer">
          <button className="win-btn" onClick={() => { syncProfile({ nickname: myNickname, psm: myPSM }); onClose(); }}>{t.common.ok}</button>
          <button className="win-btn" onClick={onClose}>{t.common.cancel}</button>
          <button className="win-btn" onClick={() => syncProfile({ nickname: myNickname, psm: myPSM })}>{t.common.apply}</button>
        </div>
      </div>
    </div>
  );
};

/** Case à cocher d'option (libellé cliquable, désactivable). */
const PrefCheckbox: React.FC<{ id: string; checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }> = ({ id, checked, onChange, label, disabled }) => (
  <div className="options-checkbox-line">
    <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <label htmlFor={id}>{label}</label>
  </div>
);
