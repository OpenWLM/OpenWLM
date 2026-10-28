import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { evaluatePassword } from '../utils/PasswordStrength';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';

/**
 * Fenêtre « Changer le mot de passe » (style Aero, comme les autres boîtes de dialogue).
 *
 * Mot de passe actuel, nouveau mot de passe (mêmes règles et même jauge de robustesse qu'à
 * l'inscription : 12 caractères minimum) et confirmation. Le bouton ne s'active que lorsque
 * tout est valide ; les erreurs s'affichent dans la fenêtre. Le changement lui-même (dérivation
 * des clés, re-chiffrement du coffre, appel serveur) est fait par `onSubmit`.
 */

export type ChangePasswordResult = { ok: true } | { ok: false; error: 'wrongCurrent' | 'revoked' | 'limited' | 'failed'; message?: string };

interface PasswordModalProps {
  onClose: () => void;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<ChangePasswordResult>;
}

export const PasswordModal: React.FC<PasswordModalProps> = ({ onClose, onSubmit }) => {
  const { t, language } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fermeture automatique après succès : annulée si la fenêtre disparaît avant
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const conformant = evaluatePassword(next).isConformant;
  const matches = confirm.length > 0 && confirm === next;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit = !busy && !done && current.length > 0 && conformant && matches && !sameAsCurrent;

  const close = () => { if (!busy) onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await onSubmit(current, next);
    setBusy(false);
    if (result.ok) {
      setDone(true);
      setCurrent(''); setNext(''); setConfirm('');
      closeTimerRef.current = setTimeout(onClose, 1800);
    } else {
      // Le détail du serveur est en français : affiché seulement dans l'interface française
      setError(result.error === 'wrongCurrent' ? t.modals.changePasswordWrongCurrent
        : result.error === 'limited' ? t.errors.rate_limited
        : (language === 'fr' && result.message) || t.modals.changePasswordFailed);
    }
  };

  return (
    <div className="wlm-aero-dialog-overlay" role="dialog" aria-modal="true" aria-label={t.modals.changePasswordTitle} onClick={close}>
      <div className="wlm-aero-dialog wlm-password-dialog" onClick={e => e.stopPropagation()}>
        <div className="wlm-aero-dialog-titlebar">
          <span className="wlm-aero-dialog-icon" aria-hidden="true">🔑</span>
          <span className="wlm-aero-dialog-title">{t.modals.changePasswordTitle}</span>
          <button type="button" className="win-close-btn" onClick={close} disabled={busy} aria-label={t.common.cancel}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div className="wlm-aero-dialog-body wlm-password-body">
            <div className="wlm-password-field">
              <label htmlFor="old-password">{t.modals.oldPasswordPlaceholder}</label>
              <input id="old-password" type="password" autoComplete="current-password" value={current}
                onChange={e => { setCurrent(e.target.value); setError(null); }} disabled={busy || done} autoFocus />
            </div>

            <div className="wlm-password-field">
              <label htmlFor="new-password">{t.modals.newPasswordPlaceholder}</label>
              <input id="new-password" type="password" autoComplete="new-password" value={next}
                onChange={e => { setNext(e.target.value); setError(null); }} disabled={busy || done} />
              <PasswordStrengthMeter password={next} />
              {sameAsCurrent && <div className="wlm-password-check bad">✗ {t.modals.changePasswordSameAsCurrent}</div>}
            </div>

            <div className="wlm-password-field">
              <label htmlFor="confirm-password">{t.modals.confirmPasswordLabel}</label>
              <input id="confirm-password" type="password" autoComplete="new-password" value={confirm}
                onChange={e => { setConfirm(e.target.value); setError(null); }} disabled={busy || done} />
              {confirm.length > 0 && (
                <div className={`wlm-password-check ${matches ? 'ok' : 'bad'}`} data-testid="password-match">
                  {matches ? `✓ ${t.modals.passwordsMatch}` : `✗ ${t.modals.passwordsDontMatch}`}
                </div>
              )}
            </div>

            <div className="wlm-password-note">{t.modals.changePasswordNote}</div>
            {error && <div className="wlm-password-error" role="alert">⚠ {error}</div>}
            {done && <div className="wlm-password-success" role="status">✓ {t.modals.changePasswordDone}</div>}
          </div>

          <div className="wlm-aero-dialog-footer">
            <button type="button" className="win-btn" onClick={close} disabled={busy}>{t.common.cancel}</button>
            <button type="submit" className="win-btn" disabled={!canSubmit}>
              {busy ? t.modals.changePasswordBusy : t.modals.changePasswordSubmit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
