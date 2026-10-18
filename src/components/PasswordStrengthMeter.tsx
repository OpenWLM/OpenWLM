import React, { useMemo } from 'react';
import { useI18n } from '../i18n';
import { evaluatePassword, PASSWORD_MIN_LENGTH, type PasswordStrengthLevel } from '../utils/PasswordStrength';

/**
 * Conseils, conformité (12 caractères minimum) et jauge de robustesse d'un nouveau mot de
 * passe. Partagé par l'inscription et le changement de mot de passe.
 */
export const PasswordStrengthMeter: React.FC<{ password: string }> = ({ password }) => {
  const { t } = useI18n();
  const evaluation = useMemo(() => evaluatePassword(password), [password]);

  const names: Record<PasswordStrengthLevel, string> = {
    weak: t.auth.passwordStrengthWeak,
    fair: t.auth.passwordStrengthFair,
    good: t.auth.passwordStrengthGood,
    excellent: t.auth.passwordStrengthExcellent
  };
  const feedback: Record<PasswordStrengthLevel, string> = {
    weak: t.auth.passwordFeedbackWeak,
    fair: t.auth.passwordFeedbackFair,
    good: t.auth.passwordFeedbackGood,
    excellent: t.auth.passwordFeedbackExcellent
  };

  return (
    <div className="auth-password-guidance">
      <div className="auth-password-help-text">{t.auth.passwordHelp}</div>
      {password.length > 0 && (
        <div className="auth-password-eval-box" data-testid="password-strength">
          <div className={`auth-compliance-status ${evaluation.isConformant ? 'compliant' : 'non-compliant'}`}>
            {evaluation.isConformant ? (
              <span>✓ {t.auth.passwordLengthMet.replace('{count}', String(password.length))}</span>
            ) : (
              <span>✗ {t.auth.passwordLengthRequired} ({password.length}/{PASSWORD_MIN_LENGTH})</span>
            )}
          </div>
          <div className="auth-strength-box">
            <div className="auth-strength-header">
              <span className="auth-strength-label">{t.auth.passwordStrengthLabel}</span>
              <span className={`auth-strength-badge ${evaluation.strengthLevel}`}>{names[evaluation.strengthLevel]}</span>
            </div>
            <div className="auth-strength-bar">
              <div className={`auth-strength-fill ${evaluation.strengthLevel}`} style={{ width: `${(evaluation.score / 4) * 100}%` }} />
            </div>
            <div className="auth-strength-desc">{feedback[evaluation.strengthLevel]}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PasswordStrengthMeter;
