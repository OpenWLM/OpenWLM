import React, { useState } from 'react';
import axios from 'axios';
import { deriveZeroKnowledgeKeys } from '../utils/Security';

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
  // États locaux
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [status, setStatus] = useState('online');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isDeriving, setIsDeriving] = useState(false);
  const [captchaData, setCaptchaData] = useState<{ id: string, text: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  /**
   * Récupère un nouveau défi Captcha depuis le serveur
   */
  const fetchCaptcha = async () => {
    try {
      const res = await axios.get('/api/captcha');
      setCaptchaData(res.data);
      setCaptchaAnswer('');
    } catch {
      console.error('Échec de la récupération du captcha');
      setError('Impossible de contacter le serveur pour le captcha.');
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
      setError('Veuillez remplir tous les champs.');
      return;
    }

    if (!isLogin) {
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;
      if (!passwordRegex.test(password)) {
        setError('Le mot de passe doit comporter au moins 12 caractères et inclure majuscule, minuscule, chiffre et caractère spécial.');
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
          setError("Réponse du serveur invalide ou altérée.");
        }
      } else {
        // Tentative d'inscription
        if (!captchaData || !captchaAnswer) {
          setError('Veuillez répondre au captcha.');
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
        alert('Compte créé avec succès ! Vous pouvez maintenant vous connecter.');
      }
    } catch (err: unknown) {
      // Gestion des erreurs serveur
      const serverError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Une erreur inattendue est survenue.';
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
        {/* En-tête avec logo style MSN */}
        <div className="wlm-auth-logo">
           <img src="/assets/openwlm_logo.png" alt="OpenWLM Logo" className="wlm-auth-logo-img" />
           <div className="wlm-logo-text-large">OpenWLM</div>
        </div>
        
        <form onSubmit={handleSubmit} className="wlm-auth-form">
          <h2>{isLogin ? 'Connexion' : 'Inscription'}</h2>
          
          <div className="auth-field">
            <label>Adresse de messagerie :</label>
            <input 
              type="text" 
              value={username} 
              onChange={e => setUsername(e.target.value)} 
              placeholder="exemple@messenger.com"
              required 
            />
          </div>
          
          <div className="auth-field">
            <label>Mot de passe :</label>
            <input 
              type="password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              required 
            />
          </div>

          {/* Sélecteur de statut MSN classique (uniquement à la connexion) */}
          {isLogin && (
            <>
              <div className="auth-field">
                <label>Statut de connexion :</label>
                <select 
                  value={status} 
                  onChange={e => setStatus(e.target.value)} 
                  className="wlm-auth-select"
                >
                  <option value="online">Disponible</option>
                  <option value="busy">Occupé(e)</option>
                  <option value="away">Absent(e)</option>
                  <option value="offline">Hors ligne (Invisible)</option>
                </select>
              </div>

              <div className="auth-field-checkbox" style={{ marginTop: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px' }}>
                  <input 
                    type="checkbox" 
                    checked={rememberMe} 
                    onChange={e => setRememberMe(e.target.checked)} 
                  />
                  Mémoriser mes clés E2EE sur cet ordinateur
                </label>
                {rememberMe && (
                  <div style={{ color: '#cc0000', fontSize: '10px', marginTop: '5px', fontWeight: 'bold' }}>
                    ⚠ Attention : Cela dégrade fortement la sécurité de votre clé privée.
                  </div>
                )}
              </div>
            </>
          )}

          {/* Champs additionnels pour l'inscription */}
          {!isLogin && (
            <>
              <div className="auth-field">
                <label>Surnom :</label>
                <input 
                  type="text" 
                  value={nickname} 
                  onChange={e => setNickname(e.target.value)} 
                  required 
                />
              </div>
              
              {captchaData && (
                <div className="auth-captcha-container">
                  <label className="auth-captcha-label">Validation Anti-Robot :</label>
                  <div className="auth-captcha-text">{captchaData.text}</div>
                  <input 
                    type="number" 
                    value={captchaAnswer} 
                    onChange={e => setCaptchaAnswer(e.target.value)} 
                    required 
                    placeholder="Votre réponse" 
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
              {isDeriving ? 'Chiffrement sécurisé...' : (isLogin ? 'Se connecter' : "S'inscrire")}
            </button>
            <span className="auth-toggle" onClick={toggleMode}>
              {isLogin ? "Pas de compte ? Créer-en un" : "Déjà un compte ? Se connecter"}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Auth;
