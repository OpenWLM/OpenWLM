import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { methodName, type DeviceLockFailure, type DeviceLockMethod } from '../utils/DeviceLock';

/**
 * Écran de déverrouillage au démarrage : les clés mémorisées sont scellées par l'appareil
 * (Windows Hello, Touch ID, empreinte / code Android, cf. DeviceLock.ts). L'authentification
 * est demandée dès l'affichage ; en cas d'annulation ou d'échec, « Déverrouiller » réessaie et
 * « Se connecter avec le mot de passe » retire les clés scellées de cet appareil.
 */

interface DeviceUnlockProps {
  username: string;
  method: DeviceLockMethod;
  /** Null : déverrouillé (l'écran disparaît) ; sinon la raison de l'échec. */
  onUnlock: () => Promise<DeviceLockFailure | null>;
  onUsePassword: () => void;
}

const DeviceUnlock: React.FC<DeviceUnlockProps> = ({ username, method, onUnlock, onUsePassword }) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DeviceLockFailure | null>(null);
  const startedRef = useRef(false);

  const unlock = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      setFailure(await onUnlock());
    } finally {
      setBusy(false);
    }
  };

  // Demande immédiate (une seule fois, même en StrictMode)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errorText = failure === 'cancelled' ? t.deviceLock.errCancelled
    : failure === 'invalidated' ? t.deviceLock.errInvalidated
    : failure === 'unsupported' ? t.deviceLock.errUnsupported
    : failure === 'failed' ? t.deviceLock.errFailed
    : null;
  // Sans issue possible ici, seul le mot de passe reste
  const canRetry = failure !== 'invalidated' && failure !== 'unsupported';

  return (
    <div className="wlm-auth-container">
      <div className="wlm-auth-box wlm-unlock-box" data-testid="device-unlock" role="dialog" aria-label={t.deviceLock.unlockTitle}>
        <div className="wlm-auth-logo">
          <img src="/assets/openwlm_logo.png" alt="OpenWLM Logo" className="wlm-auth-logo-img" />
          <div className="wlm-logo-text-large">OpenWLM</div>
        </div>
        <h2 className="wlm-unlock-title">🔐 {t.deviceLock.unlockTitle}</h2>
        <p className="wlm-unlock-text">{t.deviceLock.unlockHello.replace('{username}', username).replace('{method}', methodName(t, method))}</p>
        {busy ? (
          <div className="wlm-unlock-status" role="status">{t.deviceLock.unlocking}</div>
        ) : (
          <>
            {errorText && <div className="wlm-unlock-error" role="alert">{errorText}</div>}
            {canRetry && (
              <button type="button" className="wlm-btn-auth" onClick={unlock}>{t.deviceLock.unlockBtn}</button>
            )}
          </>
        )}
        <div className="wlm-unlock-fallback">
          <button type="button" className="auth-link-btn" onClick={onUsePassword} disabled={busy}>{t.deviceLock.usePassword}</button>
          <div className="wlm-unlock-hint">{t.deviceLock.usePasswordHint}</div>
        </div>
      </div>
    </div>
  );
};

export default DeviceUnlock;
