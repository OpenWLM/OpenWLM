import React, { useState, useMemo } from 'react';
import axios from 'axios';
import { deriveZeroKnowledgeKeys } from '../utils/Security';
import { useI18n } from '../i18n';
import { evaluatePassword, type PasswordStrengthLevel } from '../utils/PasswordStrength';

/**
 * Interface pour les propriétés du composant Auth
 */
interface AuthProps {
  onLogin: (
    user: {
      id: number;
      username: string;
      token: string;
      status: string;
      rememberMe?: boolean;
      nickname?: string;
      avatar?: string;
      scene?: string;
      psm?: string;
      public_key?: string;
      encrypted_private_key?: string;
    },
    vaultKey: CryptoKey
  ) => void;
  initialUsername?: string;
}

/**
 * Composant d'authentification (Connexion / Inscription)
 * Architecture Zero-Knowledge stricte : le mot de passe maître ne quitte JAMAIS le navigateur
 */
const Auth: React.FC<AuthProps> = ({ onLogin, initialUsername = '' }) => {
  const { t, language, setLanguage } = useI18n();

  // États locaux
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [status, setStatus] = useState('online');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isDeriving, setIsDeriving] = useState(false);
  const [captchaData, setCaptchaData] = useState<{ id: string; text: string; num1?: number; num2?: number } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  // Évaluation dynamique de la robustesse et de la conformité du mot de passe
  const passwordEval = useMemo(() => evaluatePassword(password), [password]);

  const getStrengthName = (level: PasswordStrengthLevel) => {
    switch (level) {
      case 'weak': return t.auth.passwordStrengthWeak || 'Faible';
      case 'fair': return t.auth.passwordStrengthFair || 'Moyenne';
      case 'good': return t.auth.passwordStrengthGood || 'Bonne';
      case 'excellent': return t.auth.passwordStrengthExcellent || 'Excellente';
    }
  };

  const getStrengthFeedback = (level: PasswordStrengthLevel) => {
    switch (level) {
      case 'weak': return t.auth.passwordFeedbackWeak;
      case 'fair': return t.auth.passwordFeedbackFair;
      case 'good': return t.auth.passwordFeedbackGood;
      case 'excellent': return t.auth.passwordFeedbackExcellent;
    }
  };

  /**
   * Formate la question du captcha selon la langue active
   */
  const formatCaptchaQuestion = (data: { id: string; text: string; num1?: number; num2?: number } | null) => {
    if (!data) return '';
    let n1 = data.num1;
    let n2 = data.num2;
    if (n1 === undefined || n2 === undefined) {
      const match = data.text.match(/(\d+)\s*\+\s*(\d+)/);
      if (match) {
        n1 = Number(match[1]);
        n2 = Number(match[2]);
      }
    }
    if (n1 !== undefined && n2 !== undefined) {
      const template = t.auth.captchaQuestion || (language === 'en' ? 'How much is {num1} + {num2}?' : 'Combien font {num1} + {num2} ?');
      return template.replace('{num1}', String(n1)).replace('{num2}', String(n2));
    }
    return data.text;
  };

  /**
   * Récupère un nouveau défi Captcha depuis le serveur
   */
  const fetchCaptcha = async () => {
    try {
      const res = await axios.get('/api/captcha', { params: { lang: language } });
      setCaptchaData(res.data);
      setCaptchaAnswer('');
    } catch {
      console.error('Échec de la récupération du captcha');
      setError(t.auth.captchaError);
    }
  };

  /**
   * Bascule entre le mode Connexion et Inscription
   */
  const toggleMode = () => {
    setIsLogin(!isLogin);
    setError('');
    if (isLogin) {
      fetchCaptcha();
    }
  };

  /**
   * Gère la soumission du formulaire
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation basique côté client
    if (!username || !password) {
      setError(t.auth.fillAllFields);
      return;
    }

    // Politique mot de passe OpenWLM : 12 caractères minimum requis
    if (!isLogin) {
      if (password.length < 12) {
        setError(t.auth.passwordPolicy);
        return;
      }
    }

    try {
      setIsDeriving(true);

      // DÉRIVATION ZERO-KNOWLEDGE STRICTE :
      // PBKDF2 (600 000 itérations) + HKDF-SHA256
      // Le mot de passe maître NE QUITTE JAMAIS le navigateur
      const { authKeyHex, vaultKey } = await deriveZeroKnowledgeKeys(username, password);

      if (isLogin) {
        // Envoi uniquement de authKeyHex (jamais le mot de passe brut)
        const res = await axios.post('/api/login', { username, password: authKeyHex });

        if (res.data && res.data.success && typeof res.data.token === 'string' && res.data.user && res.data.user.id) {
          onLogin({ 
            ...res.data.user, 
            token: res.data.token, 
            status, 
            rememberMe: rememberMe
          }, vaultKey);
        } else {
          setError(t.auth.invalidServerResponse);
        }
      } else {
        // Tentative d'inscription
        if (!captchaData || !captchaAnswer) {
          setError(t.auth.captchaRequired);
          return;
        }

        await axios.post('/api/signup', { 
          username, 
          password: authKeyHex, 
          nickname, 
          captchaId: captchaData.id, 
          captchaAnswer 
        });
        
        setIsLogin(true);
        alert(t.auth.signupSuccess);
      }
    } catch (err: unknown) {
      // Gestion des erreurs serveur
      const serverError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t.auth.unexpectedError;
      setError(serverError);
      
      // Rafraîchir le captcha en cas d'erreur d'inscription
      if (!isLogin) fetchCaptcha();
    } finally {
      setIsDeriving(false);
    }
  };

  return (
    <div className="wlm-auth-container">
      <div className="wlm-auth-box">
        {/* Sélecteur de langue discret style WLM */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '4px', fontSize: '11px', gap: '5px' }}>
          <span style={{ color: '#666' }}>{t.common.language} :</span>
          <button 
            type="button" 
            onClick={() => setLanguage('fr')} 
            style={{ 
              background: 'none', 
              border: 'none', 
              cursor: 'pointer', 
              fontWeight: language === 'fr' ? 'bold' : 'normal', 
              color: language === 'fr' ? '#004b8d' : '#777',
              textDecoration: language === 'fr' ? 'underline' : 'none',
              padding: '0 2px',
              fontSize: '11px'
            }}
          >
            FR
          </button>
          <span style={{ color: '#bbb' }}>|</span>
          <button 
            type="button" 
            onClick={() => setLanguage('en')} 
            style={{ 
              background: 'none', 
              border: 'none', 
              cursor: 'pointer', 
              fontWeight: language === 'en' ? 'bold' : 'normal', 
              color: language === 'en' ? '#004b8d' : '#777',
              textDecoration: language === 'en' ? 'underline' : 'none',
              padding: '0 2px',
              fontSize: '11px'
            }}
          >
            EN
          </button>
        </div>

        {/* En-tête avec logo style MSN */}
        <div className="wlm-auth-logo">
           <img src="/assets/openwlm_logo.png" alt="OpenWLM Logo" className="wlm-auth-logo-img" />
           <div className="wlm-logo-text-large">OpenWLM</div>
        </div>
        
        <form onSubmit={handleSubmit} className="wlm-auth-form">
          <h2>{isLogin ? t.auth.login : t.auth.signup}</h2>
          
          <div className="auth-field">
            <label>{t.auth.emailAddressLabel}</label>
            <input 
              type="text" 
              value={username} 
              onChange={e => setUsername(e.target.value)} 
              placeholder={!isLogin ? (t.auth.emailPlaceholderSignup || "exemple@openwlm.dev") : t.auth.emailPlaceholder}
              required 
            />
          </div>
          
          <div className="auth-field">
            <label>{isLogin ? t.auth.passwordLabel : (t.auth.passwordLabelSignup || t.auth.passwordLabel)}</label>
            <input 
              type="password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              placeholder={!isLogin ? t.auth.passwordPlaceholderSignup : undefined}
              required 
            />
            {!isLogin && (
              <div className="auth-password-guidance">
                <div className="auth-password-help-text">
                  {t.auth.passwordHelp}
                </div>

                {password.length > 0 && (
                  <div className="auth-password-eval-box">
                    <div className={`auth-compliance-status ${passwordEval.isConformant ? 'compliant' : 'non-compliant'}`}>
                      {passwordEval.isConformant ? (
                        <span>✓ {t.auth.passwordLengthMet.replace('{count}', String(password.length))}</span>
                      ) : (
                        <span>✗ {t.auth.passwordLengthRequired} ({password.length}/12)</span>
                      )}
                    </div>

                    <div className="auth-strength-box">
                      <div className="auth-strength-header">
                        <span className="auth-strength-label">{t.auth.passwordStrengthLabel}</span>
                        <span className={`auth-strength-badge ${passwordEval.strengthLevel}`}>
                          {getStrengthName(passwordEval.strengthLevel)}
                        </span>
                      </div>
                      <div className="auth-strength-bar">
                        <div 
                          className={`auth-strength-fill ${passwordEval.strengthLevel}`} 
                          style={{ width: `${(passwordEval.score / 4) * 100}%` }}
                        />
                      </div>
                      <div className="auth-strength-desc">
                        {getStrengthFeedback(passwordEval.strengthLevel)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sélecteur de statut MSN classique (uniquement à la connexion) */}
          {isLogin && (
            <>
              <div className="auth-field">
                <label>{t.auth.statusLabel}</label>
                <select 
                  value={status} 
                  onChange={e => setStatus(e.target.value)} 
                  className="wlm-auth-select"
                >
                  <option value="online">{t.auth.statusOnline}</option>
                  <option value="busy">{t.auth.statusBusy}</option>
                  <option value="away">{t.auth.statusAway}</option>
                  <option value="offline">{t.auth.statusOffline}</option>
                </select>
              </div>

              <div className="auth-field-checkbox" style={{ marginTop: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px' }}>
                  <input 
                    type="checkbox" 
                    checked={rememberMe} 
                    onChange={e => setRememberMe(e.target.checked)} 
                  />
                  {t.auth.rememberKeys}
                </label>
                {rememberMe && (
                  <div style={{ color: '#005a9e', fontSize: '10px', marginTop: '4px', lineHeight: '1.3' }}>
                    {t.auth.rememberWarning}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Champs additionnels pour l'inscription */}
          {!isLogin && (
            <>
              <div className="auth-field">
                <label>{t.auth.nicknameLabel}</label>
                <input 
                  type="text" 
                  value={nickname} 
                  maxLength={50}
                  onChange={e => setNickname(e.target.value)} 
                  required 
                />
              </div>
              
              {captchaData && (
                <div className="auth-captcha-container">
                  <label className="auth-captcha-label">{t.auth.captchaLabel}</label>
                  <div className="auth-captcha-text">{formatCaptchaQuestion(captchaData)}</div>
                  <input 
                    type="number" 
                    value={captchaAnswer} 
                    onChange={e => setCaptchaAnswer(e.target.value)} 
                    required 
                    placeholder={t.auth.captchaPlaceholder} 
                  />
                </div>
              )}
            </>
          )}

          {/* Affichage des erreurs */}
          {error && <div className="auth-error">{error}</div>}

          {/* Actions du formulaire */}
          <div className="auth-actions">
            <button 
              type="submit" 
              className="wlm-btn-auth" 
              disabled={isDeriving || (!isLogin && !captchaData)}
            >
              {isDeriving ? t.auth.encrypting : (isLogin ? t.auth.signInBtn : t.auth.signUpBtn)}
            </button>
            <span className="auth-toggle" onClick={toggleMode}>
              {isLogin ? t.auth.noAccount : t.auth.hasAccount}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Auth;
