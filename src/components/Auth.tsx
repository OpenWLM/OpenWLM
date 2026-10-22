import React, { useState } from 'react';
import axios from 'axios';
import { deriveZeroKnowledgeKeys } from '../utils/Security';
import { useI18n } from '../i18n';
import { PASSWORD_MIN_LENGTH } from '../utils/PasswordStrength';
import { serverErrorText } from '../utils/serverError';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import HelpModal from './HelpModal';
import { solveProofOfWork, type PowChallenge } from '../utils/ProofOfWork';

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
      /** Statut choisi à l'écran de connexion (absent si le sélecteur n'a pas été touché). */
      loginStatus?: string;
      rememberMe?: boolean;
      nickname?: string;
      avatar?: string;
      scene?: string;
      psm?: string;
      public_key?: string;
      encrypted_private_key?: string;
    },
    vaultKey: CryptoKey,
    authKeyHex: string
  ) => void;
  initialUsername?: string;
  /** Statut mémorisé du compte `initialUsername` sur cet appareil (présélection). */
  initialStatus?: string;
}

/**
 * Composant d'authentification (Connexion / Inscription)
 * Architecture Zero-Knowledge stricte : le mot de passe maître ne quitte JAMAIS le navigateur
 */
const Auth: React.FC<AuthProps> = ({ onLogin, initialUsername = '', initialStatus }) => {
  const { t, language, setLanguage } = useI18n();

  // États locaux
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  // Statut : présélection = statut mémorisé du compte affiché (jamais celui d'un autre compte).
  // Il n'est transmis que si l'utilisateur le change ; sinon la préférence du compte s'applique.
  const [chosenStatus, setChosenStatus] = useState<string | null>(null);
  const status = chosenStatus ?? (initialStatus && username.trim() === initialUsername ? initialStatus : 'online');
  const [rememberMe, setRememberMe] = useState(false);
  // Session révoquée depuis un autre appareil : message affiché sur l'écran de connexion jusqu'à
  // la prochaine tentative (pas effacé au montage : la page se recharge juste après la déconnexion)
  const [error, setError] = useState(() => {
    try {
      if (sessionStorage.getItem('wlm_session_notice') === 'revoked') return t.auth.sessionRevokedNotice;
    } catch { /* stockage indisponible */ }
    return '';
  });
  const [info, setInfo] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [isDeriving, setIsDeriving] = useState(false);
  const [captchaData, setCaptchaData] = useState<{ id: string; text: string; num1?: number; num2?: number; pow?: PowChallenge } | null>(null);
  const [isSolvingPow, setIsSolvingPow] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

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
    setInfo('');
    try { sessionStorage.removeItem('wlm_session_notice'); } catch { /* ignore */ }

    // Validation basique côté client
    if (!username || !password) {
      setError(t.auth.fillAllFields);
      return;
    }

    // Politique mot de passe OpenWLM : 12 caractères minimum requis
    if (!isLogin) {
      if (password.length < PASSWORD_MIN_LENGTH) {
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
        const res = await axios.post('/api/login', { username, password: authKeyHex, remember: rememberMe });

        // M2 : le JWT n'est plus renvoyé dans le corps (auth par cookie HttpOnly uniquement).
        // On ne l'exige donc plus pour valider la réponse de login.
        if (res.data && res.data.success && res.data.user && res.data.user.id) {
          onLogin({ 
            ...res.data.user, 
            // Champ distinct : `status` de la réponse serveur n'est PAS un choix de l'utilisateur
            ...(chosenStatus ? { loginStatus: chosenStatus } : {}),
            rememberMe: rememberMe
          }, vaultKey, authKeyHex);
        } else {
          setError(t.auth.invalidServerResponse);
        }
      } else {
        // Tentative d'inscription
        if (!captchaData || !captchaAnswer) {
          setError(t.auth.captchaRequired);
          return;
        }

        // Preuve de travail anti-inscription de masse (défi fourni avec le captcha)
        setIsSolvingPow(true);
        let powNonce: string;
        try {
          powNonce = await solveProofOfWork(captchaData.pow);
        } finally {
          setIsSolvingPow(false);
        }

        await axios.post('/api/signup', { 
          username, 
          password: authKeyHex, 
          nickname, 
          captchaId: captchaData.id, 
          captchaAnswer,
          powNonce
        });
        
        setIsLogin(true);
        // Réussite affichée dans le formulaire (on enchaîne directement sur la connexion)
        setInfo(t.auth.signupSuccess);
      }
    } catch (err: unknown) {
      // Gestion des erreurs serveur
      // Code d'erreur du serveur traduit (identifiants invalides, captcha, identifiant déjà pris…)
      setError(serverErrorText(err, t, language, t.auth.unexpectedError));
      
      // Rafraîchir le captcha en cas d'erreur d'inscription
      if (!isLogin) fetchCaptcha();
    } finally {
      setIsDeriving(false);
    }
  };

  return (
    <div className="wlm-auth-container">
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
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

        {/* En-tête avec logo */}
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
              placeholder={!isLogin ? t.auth.emailPlaceholderSignup : t.auth.emailPlaceholder}
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
            {!isLogin && <PasswordStrengthMeter password={password} />}
          </div>

          {/* Sélecteur de statut (uniquement à la connexion) */}
          {isLogin && (
            <>
              <div className="auth-field">
                <label>{t.auth.statusLabel}</label>
                <select 
                  value={status} 
                  onChange={e => setChosenStatus(e.target.value)} 
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
          {info && !error && <div className="auth-info" role="status">✓ {info}</div>}

          {/* Actions du formulaire */}
          <div className="auth-actions">
            <button 
              type="submit" 
              className="wlm-btn-auth" 
              disabled={isDeriving || (!isLogin && !captchaData)}
            >
              {isSolvingPow ? t.auth.antiBotChecking : isDeriving ? t.auth.encrypting : (isLogin ? t.auth.signInBtn : t.auth.signUpBtn)}
            </button>
            <span className="auth-toggle" onClick={toggleMode}>
              {isLogin ? t.auth.noAccount : t.auth.hasAccount}
            </span>
          </div>
        </form>
        <div className="auth-footer">
          OpenWLM v{__APP_VERSION__} ·{' '}
          <a href="https://github.com/OpenWLM/OpenWLM" target="_blank" rel="noopener noreferrer">GitHub</a>{' '}·{' '}
          <button type="button" className="auth-help-link" onClick={() => setShowHelp(true)}>{t.extras.helpMenu}</button>
        </div>
      </div>
    </div>
  );
};

export default Auth;
