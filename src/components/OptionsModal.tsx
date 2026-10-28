import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { isSystemNotificationSupported } from '../utils/NotificationManager';
import { isAndroidDevice, isPushSupported, type PushBackendStatus } from '../utils/PushNotificationManager';
import { saveAwayTimeout, saveEnableAutoAway, clampAwayTimeout, AWAY_TIMEOUT_MIN, AWAY_TIMEOUT_MAX } from '../utils/profileStorage';
import type { SystemIdlePermission, SystemIdleSupport } from '../utils/systemIdle';
import type { Contact, User } from '../types';
import { formatNickname } from '../utils/NicknameFormatter';
import { useAppPrefs, updateAppPrefs } from '../utils/appPrefs';
import LocalDB from '../utils/LocalDB';
import SoundManager from '../utils/SoundManager';
import type { Socket } from 'socket.io-client';
import ConnectionDiagnostics from './ConnectionDiagnostics';
import FormatPicker from './FormatPicker';
import QuickTextsEditor from './QuickTextsEditor';
import { changeNativeServer, NATIVE_PUSH_SYNC_EVENT } from '../hooks/useNativePush';
import {
  isNativeApp, getNativeAppInfo, getNativeNotificationPermission, requestNativeNotificationPermission,
  openNativeNotificationSettings, getNativeCallPermissions, requestNativeCallPermission,
  type NativeAppInfo, type NativeNotificationPermission, type NativeCallPermissions
} from '../utils/platform';
import { hasPlusFormatting, visibleLength } from '../utils/plusFormat';
import { RELOCK_CHOICES, methodName, type DeviceLockFailure, type DeviceLockMethod } from '../utils/DeviceLock';

/**
 * Modale d'options (Paramètres) : Personnel, Disposition, Messages, Alertes, Sons, Sécurité, Connexion.
 *
 * Composant de présentation piloté par props : le profil (pseudo, PSM), les préférences
 * (auto-absence, toasts) et l'état/les actions de notifications viennent de `App` / des
 * hooks. L'onglet actif est un état local à la modale ; l'i18n est lue directement.
 */

export type DeviceLockOutcome = 'ok' | 'wrongPassword' | DeviceLockFailure;

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
  systemIdleStartFailed: boolean;
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
  /** Compte connecté : la copie locale effacée depuis l'onglet Messages est la sienne seulement. */
  userId: number | null;
  /** Onglet Connexion (diagnostic) : connexion temps réel de la session. */
  socket: Socket | null;
  /** Onglet Sécurité : regroupe des actions qui existent aussi dans le menu principal. */
  security: {
    contacts: Contact[];
    onUnblock: (contactId: number) => void;
    isDeviceRemembered: boolean;
    onForgetDevice: () => void;
    globalPrivateMode: boolean;
    onToggleGlobalPrivate: () => void;
    /** Code de sécurité déjà formaté (vide tant que les clés ne sont pas chargées). */
    safetyNumber: string;
    /** Ces deux actions ouvrent leur propre fenêtre : la modale d'options se ferme d'abord. */
    onChangePassword: () => void;
    onResetKeys: () => void;
    /** Coupe les autres appareils (cet appareil reste connecté). */
    onRevokeOtherSessions: () => Promise<{ ok: boolean; disconnected?: number }>;
    /** Clés mémorisées scellées par l'appareil (Windows Hello, Touch ID, empreinte / code), cf. DeviceLock.ts. */
    deviceLock: {
      /** Null : pas de verrouillage possible sur cet appareil / navigateur. */
      method: DeviceLockMethod | null;
      active: boolean;
      /** Le mot de passe ouvre le coffre (clé privée) : activer scelle, désactiver mémorise sans sceller. */
      onEnable: (password: string) => Promise<DeviceLockOutcome>;
      onDisable: (password: string) => Promise<DeviceLockOutcome>;
      onLockNow: () => void;
    };
  };
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
  systemIdleStartFailed,
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
  userId,
  socket,
  security,
  onClose
}) => {
  const { t, language, setLanguage } = useI18n();
  const [optionsTab, setOptionsTab] = useState<'personal' | 'layout' | 'messages' | 'alerts' | 'sounds' | 'security' | 'connection'>('personal');
  const prefs = useAppPrefs();
  const [cacheCleared, setCacheCleared] = useState(false);
  // Effacement de la copie locale (décocher l'option ou bouton) : confirmation dans l'onglet,
  // car les messages privés n'existent que là et sont alors perdus définitivement
  const [clearConfirm, setClearConfirm] = useState<'none' | 'disable' | 'clear'>('none');
  const confirmClearLocal = async () => {
    const action = clearConfirm;
    setClearConfirm('none');
    if (action === 'disable') updateAppPrefs('messages', { keepLocalHistory: false });
    if (userId == null) return;
    try { await LocalDB.clearUser(userId); setCacheCleared(true); } catch { /* stockage indisponible */ }
  };
  // Brouillon du délai d'inactivité : permet d'effacer le champ pour retaper une valeur
  const [awayTimeoutDraft, setAwayTimeoutDraft] = useState(() => String(awayTimeout));
  const [systemIdleDenied, setSystemIdleDenied] = useState(false);
  // App Android : serveur, version et verrouillage (fournis par le code natif)
  const nativeApp = isNativeApp();
  const [nativeInfo, setNativeInfo] = useState<NativeAppInfo | null>(null);
  const [nativeNotif, setNativeNotif] = useState<NativeNotificationPermission | null>(null);
  const [callPerms, setCallPerms] = useState<NativeCallPermissions | null>(null);
  const refreshCallPerms = () => { getNativeCallPermissions().then(setCallPerms); };
  useEffect(() => {
    if (!nativeApp) return;
    let cancelled = false;
    getNativeAppInfo().then(info => { if (!cancelled) setNativeInfo(info); });
    const refresh = () => {
      getNativeNotificationPermission().then(p => { if (!cancelled) setNativeNotif(p); });
      getNativeCallPermissions().then(p => { if (!cancelled) setCallPerms(p); });
    };
    refresh();
    // Retour des réglages Android : l'autorisation a pu changer
    document.addEventListener('visibilitychange', refresh);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', refresh); };
  }, [nativeApp]);
  // « Déconnecter mes autres sessions » : confirmation dans l'onglet (pas de fenêtre du navigateur)
  const [revokeStep, setRevokeStep] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  const confirmRevoke = async () => {
    setRevokeStep('busy');
    const r = await security.onRevokeOtherSessions();
    setRevokeStep(r.ok ? 'done' : 'error');
  };
  const blockedContacts = security.contacts.filter(c => !c.isBot && (c.blocked === true || Number(c.blocked) === 1));
  // Verrouillage des clés : la case ouvre la demande de mot de passe (rien ne change avant)
  const [lockStep, setLockStep] = useState<'idle' | 'enable' | 'disable' | 'busy'>('idle');
  const [lockPassword, setLockPassword] = useState('');
  const [lockOutcome, setLockOutcome] = useState<DeviceLockOutcome | null>(null);
  const [lockOutcomeFor, setLockOutcomeFor] = useState<'enable' | 'disable'>('enable');
  const submitDeviceLock = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (lockStep !== 'enable' && lockStep !== 'disable') return;
    const action = lockStep;
    setLockStep('busy');
    const outcome = await (action === 'enable' ? security.deviceLock.onEnable(lockPassword) : security.deviceLock.onDisable(lockPassword));
    setLockPassword('');
    setLockOutcome(outcome);
    setLockOutcomeFor(action);
    setLockStep(outcome === 'wrongPassword' ? action : 'idle');
  };
  const lockMethod = security.deviceLock.method;
  const lockMethodName = lockMethod ? methodName(t, lockMethod) : '';
  const lockOutcomeText = lockOutcome === 'ok' ? (lockOutcomeFor === 'enable' ? t.deviceLock.enabled : t.deviceLock.disabled)
    : lockOutcome === 'wrongPassword' ? t.deviceLock.wrongPassword
    : lockOutcome === 'cancelled' ? t.deviceLock.cancelled
    : lockOutcome === 'unsupported' ? t.deviceLock.unsupportedNow
    : lockOutcome ? t.deviceLock.failed : null;

  // Tous les réglages s'enregistrent dès qu'ils changent (plus de OK / Annuler / Appliquer).
  // Pseudo et message perso : enregistrés en quittant le champ (ou Entrée) et à la fermeture.
  const savedProfileRef = useRef({ nickname: myNickname, psm: myPSM });
  // Longueur VISIBLE (sans balises) : 50 / 150 caractères
  const nicknameValid = visibleLength(myNickname) <= 50;
  const psmValid = visibleLength(myPSM) <= 150;
  const nicknameRef = useRef<HTMLInputElement>(null);
  const psmRef = useRef<HTMLInputElement>(null);
  // 🎨 : entoure la sélection du champ avec les balises choisies
  const wrapField = (ref: React.RefObject<HTMLInputElement | null>, value: string, set: (v: string) => void, open: string, close: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set(value.slice(0, start) + open + value.slice(start, end) + close + value.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + open.length, end + open.length); });
  };
  const saveProfile = () => {
    const saved = savedProfileRef.current;
    if (saved.nickname === myNickname && saved.psm === myPSM) return;
    if (!nicknameValid || !psmValid) return;
    savedProfileRef.current = { nickname: myNickname, psm: myPSM };
    syncProfile({ nickname: myNickname, psm: myPSM });
  };
  const close = () => { saveProfile(); onClose(); };
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal-box wlm-options-modal" style={{ width: '560px' }} role="dialog" aria-modal="true" aria-label={t.settings.optionsTitle} onClick={e => e.stopPropagation()}>
        <div className="wlm-aero-dialog-titlebar wlm-options-titlebar">
          <span className="wlm-aero-dialog-icon" aria-hidden="true">⚙️</span>
          <span className="wlm-aero-dialog-title">{t.settings.optionsTitle}</span>
          <button type="button" className="win-close-btn" onClick={close} aria-label={t.common.close} title={t.common.close}>✕</button>
        </div>

        <div className="options-body">
          <div className="options-sidebar">
            <div className={`options-nav-item ${optionsTab === 'personal' ? 'active' : ''}`} onClick={() => setOptionsTab('personal')}>{t.settings.tabPersonal}</div>
            <div className={`options-nav-item ${optionsTab === 'layout' ? 'active' : ''}`} onClick={() => setOptionsTab('layout')}>{t.settings.tabLayout}</div>
            <div className={`options-nav-item ${optionsTab === 'messages' ? 'active' : ''}`} onClick={() => setOptionsTab('messages')}>{t.settings.tabMessages}</div>
            <div className={`options-nav-item ${optionsTab === 'alerts' ? 'active' : ''}`} onClick={() => setOptionsTab('alerts')}>{t.settings.tabAlerts}</div>
            <div className={`options-nav-item ${optionsTab === 'sounds' ? 'active' : ''}`} onClick={() => setOptionsTab('sounds')}>{t.settings.tabSounds}</div>
            <div className={`options-nav-item ${optionsTab === 'security' ? 'active' : ''}`} onClick={() => setOptionsTab('security')}>{t.settings.tabSecurity}</div>
            <div className={`options-nav-item ${optionsTab === 'connection' ? 'active' : ''}`} onClick={() => setOptionsTab('connection')}>{t.settings.tabConnection}</div>
          </div>

          <div className="options-content">
            {optionsTab === 'personal' && (
              <div className="options-section">
                <div className="options-title">{t.settings.tabPersonal}</div>

                <div className="options-subsection">
                  <label className="options-label">{t.auth.nicknameLabel.replace(':', '')}</label>
                  <div className="options-hint">{t.settings.nicknameSub}</div>
                  <div className="opt-format-field">
                    <input
                      className="win-input"
                      id="opt-nickname"
                      ref={nicknameRef}
                      value={myNickname}
                      maxLength={300}
                      onChange={e => setMyNickname(e.target.value)}
                      onBlur={saveProfile}
                      onKeyDown={blurOnEnter}
                    />
                    <FormatPicker onWrap={(o, c) => wrapField(nicknameRef, myNickname, setMyNickname, o, c)} testId="nickname-format-picker" align="right" />
                  </div>
                  {hasPlusFormatting(myNickname) && <div className="opt-format-preview" data-testid="nickname-preview">{formatNickname(myNickname)}</div>}
                  {!nicknameValid && <div className="opt-format-error" role="alert">{t.extras.nickTooLong}</div>}
                </div>

                <div className="options-subsection">
                  <div className="options-hint">{t.settings.psmSub}</div>
                  <div className="opt-format-field">
                    <input
                      className="win-input"
                      id="opt-psm"
                      ref={psmRef}
                      value={myPSM}
                      maxLength={600}
                      onChange={e => setMyPSM(e.target.value)}
                      onBlur={saveProfile}
                      onKeyDown={blurOnEnter}
                    />
                    <FormatPicker onWrap={(o, c) => wrapField(psmRef, myPSM, setMyPSM, o, c)} testId="psm-format-picker" align="right" />
                  </div>
                  {hasPlusFormatting(myPSM) && <div className="opt-format-preview">{formatNickname(myPSM)}</div>}
                  {!psmValid && <div className="opt-format-error" role="alert">{t.extras.psmTooLong}</div>}
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
                  {/* Inactivité de tout l'ordinateur (API Idle Detection) : absente des WebView Android */}
                  {!nativeApp && (
                  <>
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
                      : systemIdleEnabled && systemIdleStartFailed ? t.settings.systemIdleRetrying
                      : systemIdleEnabled ? t.settings.systemIdleBlocked
                      : t.settings.systemIdleHint}
                  </div>
                  </>
                  )}
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
                  <PrefCheckbox id="pref-formatting" checked={prefs.messages.showFormatting} onChange={v => updateAppPrefs('messages', { showFormatting: v })} label={t.extras.optFormatting} />
                </div>
                <QuickTextsEditor />
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
                      // Désactiver efface la copie déjà enregistrée : confirmation d'abord
                      if (v) { updateAppPrefs('messages', { keepLocalHistory: true }); setClearConfirm('none'); }
                      else setClearConfirm('disable');
                    }}
                    label={t.settings.messagesLocalHistory}
                  />
                  <div className="options-hint">{t.settings.messagesLocalHistoryPrivate}</div>
                  <button
                    type="button"
                    className="win-btn"
                    id="pref-clear-cache"
                    style={{ marginTop: '6px' }}
                    onClick={() => setClearConfirm('clear')}
                  >
                    {t.settings.messagesClearCache}
                  </button>
                  {clearConfirm !== 'none' && (
                    <div className="options-confirm-box" role="alertdialog" aria-label={t.settings.messagesClearCache} data-testid="clear-local-confirm">
                      <div className="options-hint">{clearConfirm === 'disable' ? t.settings.messagesDisableLocalConfirm : t.settings.messagesClearLocalConfirm}</div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                        <button type="button" className="win-btn" style={{ color: '#c02717' }} onClick={confirmClearLocal}>{t.settings.messagesClearLocalConfirmBtn}</button>
                        <button type="button" className="win-btn" onClick={() => setClearConfirm('none')}>{t.common.cancel}</button>
                      </div>
                    </div>
                  )}
                  {cacheCleared && <span className="options-hint" role="status" style={{ marginLeft: '8px' }}>{t.settings.messagesCacheCleared}</span>}
                </div>
              </div>
            )}

            {optionsTab === 'security' && (
              <div className="options-section" data-testid="options-security">
                <div className="options-title">{t.settings.tabSecurity}</div>

                {nativeApp && (
                  <div className="options-subsection" data-testid="native-app">
                    <label className="options-label">{t.settings.nativeAppSection}</label>
                    <div className="options-hint">{t.settings.nativeServerLabel} <strong>{nativeInfo?.server ?? '…'}</strong></div>
                    <button type="button" className="win-btn" style={{ marginTop: '5px' }} onClick={() => { changeNativeServer(); }}>{t.settings.nativeChangeServer}</button>
                    <div className="options-hint" style={{ marginTop: '6px' }}>{nativeInfo?.appLock === false ? t.settings.nativeLockOff : t.settings.nativeLockOn}</div>
                    {nativeInfo?.versionName && (
                      <div className="options-hint">{t.settings.nativeVersionLabel} {nativeInfo.versionName} ({nativeInfo.versionCode})</div>
                    )}
                  </div>
                )}

                <div className="options-subsection">
                  <label className="options-label">{t.settings.securityPassword}</label>
                  <div className="options-hint">{t.settings.securityPasswordHint}</div>
                  <button type="button" className="win-btn" style={{ marginTop: '5px' }} onClick={security.onChangePassword}>{t.settings.securityChangePassword}</button>
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.settings.securityDevice}</label>
                  <div className="options-hint">{security.isDeviceRemembered ? t.settings.securityDeviceRemembered : t.settings.securityDeviceNotRemembered}</div>
                  {security.isDeviceRemembered && (
                    <button type="button" className="win-btn" style={{ marginTop: '5px', color: '#b33927' }} onClick={security.onForgetDevice}>🔓 {t.auth.forgetDevice}</button>
                  )}
                </div>

                <div className="options-subsection" data-testid="device-lock">
                  <label className="options-label">{t.deviceLock.title}</label>
                  {!lockMethod ? (
                    <div className="options-hint">{t.deviceLock.unsupported}</div>
                  ) : (
                    <>
                      <PrefCheckbox
                        id="pref-device-lock"
                        checked={security.deviceLock.active}
                        disabled={lockStep === 'busy'}
                        onChange={v => { setLockOutcome(null); setLockPassword(''); setLockStep(v ? 'enable' : 'disable'); }}
                        label={lockMethod === 'android' ? t.deviceLock.enableAndroid : t.deviceLock.enableWebauthn}
                      />
                      <div className="options-hint">
                        {security.deviceLock.active
                          ? (lockMethod === 'android' ? t.deviceLock.activeHintAndroid : t.deviceLock.activeHint)
                          : t.deviceLock.inactiveHint.replace('{method}', lockMethodName)}
                      </div>
                      {(lockStep === 'enable' || lockStep === 'disable' || lockStep === 'busy') && (
                        <form className="options-confirm-box" onSubmit={submitDeviceLock} aria-label={t.deviceLock.title}>
                          <label className="options-hint" htmlFor="device-lock-password">{t.deviceLock.passwordPrompt}</label>
                          <input
                            id="device-lock-password"
                            type="password"
                            autoComplete="current-password"
                            value={lockPassword}
                            disabled={lockStep === 'busy'}
                            onChange={e => setLockPassword(e.target.value)}
                            style={{ width: '100%', marginTop: '4px' }}
                            autoFocus
                          />
                          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                            <button type="submit" className="win-btn win-btn-primary" disabled={lockStep === 'busy' || !lockPassword}>
                              {lockStep === 'disable' ? t.deviceLock.confirmDisable : t.deviceLock.confirmEnable}
                            </button>
                            <button type="button" className="win-btn" disabled={lockStep === 'busy'} onClick={() => { setLockStep('idle'); setLockPassword(''); }}>{t.common.cancel}</button>
                          </div>
                        </form>
                      )}
                      {lockOutcomeText && (
                        <div className="options-hint" role="status" data-testid="device-lock-outcome" style={{ color: lockOutcome === 'ok' ? '#1b7d23' : '#c02717' }}>{lockOutcomeText}</div>
                      )}
                      {security.deviceLock.active && (
                        <div style={{ marginTop: '6px' }}>
                          {lockMethod !== 'android' && (
                            <>
                              <label className="options-hint" htmlFor="pref-relock">
                                {t.deviceLock.relockLabel}
                                <select
                                  id="pref-relock"
                                  className="options-device-lock-select"
                                  value={prefs.security.relockMinutes}
                                  onChange={e => updateAppPrefs('security', { relockMinutes: Number(e.target.value) })}
                                >
                                  {RELOCK_CHOICES.map(m => (
                                    <option key={m} value={m}>{t.deviceLock[`relock${m}` as 'relock0' | 'relock1' | 'relock5' | 'relock15' | 'relock30']}</option>
                                  ))}
                                </select>
                              </label>
                              <div className="options-hint">{t.deviceLock.relockHint}</div>
                            </>
                          )}
                          <button type="button" className="win-btn" style={{ marginTop: '5px' }} onClick={security.deviceLock.onLockNow}>🔒 {t.deviceLock.lockNow}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="options-subsection" data-testid="revoke-sessions">
                  <label className="options-label">{t.settings.securitySessions}</label>
                  <div className="options-hint">{t.settings.securitySessionsHint}</div>
                  {revokeStep === 'confirm' || revokeStep === 'busy' ? (
                    <div className="options-confirm-box" role="alertdialog" aria-label={t.settings.securityRevokeOthers}>
                      <div className="options-hint">{t.settings.securityRevokeConfirm}</div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                        <button type="button" className="win-btn" style={{ color: '#c02717' }} disabled={revokeStep === 'busy'} onClick={confirmRevoke}>{t.settings.securityRevokeConfirmBtn}</button>
                        <button type="button" className="win-btn" disabled={revokeStep === 'busy'} onClick={() => setRevokeStep('idle')}>{t.common.cancel}</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="win-btn" style={{ marginTop: '5px' }} onClick={() => setRevokeStep('confirm')}>{t.settings.securityRevokeOthers}</button>
                  )}
                  {revokeStep === 'done' && <div className="options-hint" role="status" style={{ color: '#1b7d23' }}>{t.settings.securityRevokeDone}</div>}
                  {revokeStep === 'error' && <div className="options-hint" role="status" style={{ color: '#c02717' }}>{t.settings.securityRevokeError}</div>}
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.settings.securityPrivacy}</label>
                  <PrefCheckbox id="pref-sec-global-private" checked={security.globalPrivateMode} onChange={security.onToggleGlobalPrivate} label={t.settings.securityGlobalPrivate} />
                  <div className="options-hint">{t.settings.securityGlobalPrivateHint}</div>
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.settings.securityBlocked}</label>
                  <div className="options-hint">{t.settings.securityBlockedHint}</div>
                  {blockedContacts.length === 0 ? (
                    <div className="options-hint" style={{ fontStyle: 'italic', marginTop: '4px' }}>{t.settings.securityBlockedNone}</div>
                  ) : (
                    <ul className="options-blocked-list" data-testid="blocked-list">
                      {blockedContacts.map(c => (
                        <li key={c.id}>
                          <span className="options-blocked-name" title={c.username}>{formatNickname(c.nickname || c.username)}</span>
                          <button type="button" className="win-btn" onClick={() => security.onUnblock(c.id)}>{t.settings.securityUnblock}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="options-subsection">
                  <label className="options-label">{t.settings.securityKeys}</label>
                  <div className="options-hint">{t.settings.securityKeysHint}</div>
                  <div className="options-safety-number" data-testid="my-safety-number">{security.safetyNumber || '…'}</div>
                  <button type="button" className="win-btn" style={{ marginTop: '6px', color: '#c02717' }} onClick={security.onResetKeys}>{t.settings.securityResetKeys}</button>
                  <div className="options-hint">{t.settings.securityResetKeysHint}</div>
                </div>
              </div>
            )}

            {optionsTab === 'connection' && <ConnectionDiagnostics socket={socket} pushStatus={pushStatus} />}

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
                    <button type="button" className="win-btn" style={{ marginLeft: '8px' }} disabled={!prefs.sounds.enabled} onClick={() => SoundManager.preview('NEW_MESSAGE')}>{t.settings.soundsTest}</button>
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

                {nativeApp ? (
                  <>
                  <div className="options-subsection" style={{ marginTop: '16px' }} data-testid="native-notifications">
                    <label className="options-label">{t.settings.nativeNotifSection}</label>
                    <div className="options-hint">
                      {nativeInfo?.push === false ? t.settings.nativeNotifNoFirebase
                        : nativeNotif === 'granted' ? t.settings.nativeNotifGranted
                        : nativeNotif === 'denied' ? t.settings.nativeNotifDenied
                        : t.settings.nativeNotifPrompt}
                    </div>
                    {nativeNotif === 'prompt' && (
                      <button type="button" className="win-btn" style={{ marginTop: '6px' }}
                        onClick={async () => {
                          setNativeNotif(await requestNativeNotificationPermission());
                          window.dispatchEvent(new Event(NATIVE_PUSH_SYNC_EVENT));
                        }}>
                        {t.settings.browserNotifPrompt}
                      </button>
                    )}
                    {nativeNotif === 'denied' && (
                      <button type="button" className="win-btn" style={{ marginTop: '6px' }} onClick={() => { openNativeNotificationSettings(); }}>
                        {t.settings.nativeNotifOpenSettings}
                      </button>
                    )}
                    {nativeNotif === 'granted' && nativeInfo?.push !== false && (
                      <div style={{ marginTop: '8px' }}>
                        <button type="button" className="win-btn" style={{ fontSize: '11px', padding: '3px 10px' }} onClick={handleTestPush}>
                          🔔 {t.settings.pushTestButton}
                        </button>
                        {pushTestFeedback && (
                          <div className="options-hint" style={{ marginTop: '6px', color: pushTestFeedback === t.settings.pushTestSuccess ? '#1b7d23' : '#c02717' }}>
                            {pushTestFeedback}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="options-subsection" data-testid="native-call-permissions">
                    <label className="options-label">{t.settings.nativeCallSection}</label>
                    <div className="options-hint">{t.settings.nativeCallHint}</div>
                    {callPerms && ([
                      ['microphone', t.settings.nativeCallMicrophone],
                      ['camera', t.settings.nativeCallCamera],
                      ['fullScreen', t.settings.nativeCallFullScreen]
                    ] as const).map(([kind, label]) => (
                      <div key={kind} className="options-hint" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                        <span style={{ flex: 1 }}>{label}</span>
                        {callPerms[kind] === 'granted' ? (
                          <span style={{ color: '#1b7d23', fontWeight: 600 }}>✓ {t.settings.nativeCallGranted}</span>
                        ) : (
                          <button type="button" className="win-btn" style={{ fontSize: '11px', padding: '2px 8px' }}
                            onClick={async () => {
                              await requestNativeCallPermission(kind);
                              refreshCallPerms();
                            }}>
                            {kind === 'fullScreen' || callPerms[kind] === 'denied' ? t.settings.nativeCallOpenSettings : t.settings.nativeCallAllow}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  </>
                ) : (
                <>
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
                        ? (pushStatus?.hasVapid ? t.settings.webPushConfigured : t.settings.webPushReady)
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
                        🔔 {t.settings.pushTestButton}
                      </button>
                      {pushTestFeedback && (
                        <div style={{
                          marginTop: '6px',
                          fontSize: '11px',
                          fontWeight: 500,
                          color: pushTestFeedback === t.settings.pushTestSuccess ? '#1b7d23' : '#c02717'
                        }}>
                          {pushTestFeedback}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="wlm-options-statusbar">{t.settings.autoSavedNote}</div>
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
