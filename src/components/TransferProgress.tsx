import React from 'react';
import { useI18n } from '../i18n';
import {
  formatBytes, formatDuration, formatSpeed, progressPercent, remainingSeconds,
  type TransferProgressState
} from '../utils/transferProgress';

/**
 * Barre de progression verte façon Aero (Windows 7) pour un transfert de fichier :
 * pourcentage, débit et temps restant. Sans taille connue (chiffrement, finalisation), la barre
 * défile en continu.
 */
interface TransferProgressProps {
  label: string;
  progress: TransferProgressState | null;
  /** Étape sans mesure possible (chiffrement, finalisation) : barre animée sans chiffres. */
  busyText?: string;
  onCancel?: () => void;
}

export const TransferProgress: React.FC<TransferProgressProps> = ({ label, progress, busyText, onCancel }) => {
  const { t, language } = useI18n();
  const busy = !!busyText || !progress || progress.total <= 0;
  const percent = progress ? progressPercent(progress) : 0;
  const eta = progress ? remainingSeconds(progress) : null;

  return (
    <div className="wlm-transfer" data-testid="transfer-progress">
      <div className="wlm-transfer-head">
        <span className="wlm-transfer-label" title={label}>{label}</span>
        {onCancel && (
          <button type="button" className="wlm-transfer-cancel" onClick={onCancel}>
            {t.fileTransfer.cancel}
          </button>
        )}
      </div>
      <div
        className={`wlm-progress${busy ? ' wlm-progress-busy' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={busy ? undefined : percent}
      >
        <div className="wlm-progress-fill" style={busy ? undefined : { width: `${percent}%` }} />
        {!busy && <span className="wlm-progress-text">{percent} %</span>}
      </div>
      <div className="wlm-transfer-stats">
        {busy ? (
          <span>{busyText || t.fileTransfer.preparing}</span>
        ) : (
          <>
            <span data-testid="transfer-amount">
              {formatBytes(progress!.loaded, language)} / {formatBytes(progress!.total, language)}
            </span>
            <span data-testid="transfer-speed">
              {progress!.rate !== null ? formatSpeed(progress!.rate, language) : t.fileTransfer.measuring}
            </span>
            <span data-testid="transfer-eta">
              {eta !== null ? t.fileTransfer.timeLeft.replace('{time}', formatDuration(eta)) : '—'}
            </span>
          </>
        )}
      </div>
    </div>
  );
};

export default TransferProgress;
