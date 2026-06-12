import React, { useState } from 'react';
import axios from 'axios';

/**
 * Interface pour les propriétés du composant Auth
 */
interface AuthProps {
  onLogin: (user: any) => void;
}

/**
 * Composant d'authentification (Connexion / Inscription)
 * Gère l'interface OpenWLM classique pour l'accès au service
 */
const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  // États locaux
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [status, setStatus] = useState('online');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
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
    } catch (e) {
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

    try {
      if (isLogin) {
        // Tentative de connexion
        const res = await axios.post('/api/login', { username, password });

        // VÉRIFICATION DE SÉCURITÉ : Ne pas faire confiance aveuglément à la réponse.
        // On s'assure que le serveur a bien renvoyé un token JWT valide et un objet utilisateur.
        if (res.data && res.data.success && typeof res.data.token === 'string' && res.data.user && res.data.user.id) {
          // On passe les infos utilisateur au parent, incluant le mot de passe en clair
          // nécessaire pour déchiffrer la clé privée E2EE localement.
          onLogin({ 
            ...res.data.user, 
            token: res.data.token, 
            status, 
            plaintextPassword: password,
            rememberMe: rememberMe
          });
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
          password, 
          nickname, 
          captchaId: captchaData.id, 
          captchaAnswer 
        });
        
        setIsLogin(true);
        alert('Compte créé avec succès ! Vous pouvez maintenant vous connecter.');
      }
    } catch (err: any) {
      // Gestion des erreurs serveur
      const serverError = err.response?.data?.error || 'Une erreur inattendue est survenue.';
      setError(serverError);
      
      // Rafraîchir le captcha en cas d'erreur d'inscription
      if (!isLogin) fetchCaptcha();
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
              disabled={!isLogin && !captchaData}
            >
              {isLogin ? 'Se connecter' : "S'inscrire"}
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
