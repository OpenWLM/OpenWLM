import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import axios from 'axios';
import E2EEKeyStorage from '../utils/E2EEKeyStorage';
import {
  deriveZeroKnowledgeKeys,
  encryptPrivateKeyVault,
  decryptPrivateKeyVault
} from '../utils/Security';
import {
  loadAwayTimeout,
  loadEnableAutoAway,
  sanitizeUserForStorage
} from '../utils/profileStorage';
import type { User } from '../types';

/**
 * DOMAINE PROFIL PERSONNEL
 *
 * Regroupe l'état et les actions du profil de l'utilisateur :
 * - identité affichée : statut, PSM, pseudo, avatar, scène (+ drapeaux d'édition) ;
 * - synchronisation serveur du profil (`syncProfile`) ;
 * - absence automatique (auto-away) selon l'inactivité ;
 * - sécurité du compte : changement de mot de passe, oubli de l'appareil.
 *
 * `syncProfile` est exposé car il est utilisé ailleurs dans `App` (édition de pseudo,
 * PSM, avatar, scène, statut). Les setters du compte (utilisateur, drapeau « appareil
 * mémorisé », notification de persistance) sont injectés.
 */

export interface UseProfileOptions {
  user: User | null;
  setUser: Dispatch<SetStateAction<User | null>>;
  /** Clés E2EE courantes (le changement de mot de passe re-chiffre la clé privée). */
  myKeysRef: { current: { privateKeyJwk?: any } | null };
  setShowPasswordModal: Dispatch<SetStateAction<boolean>>;
  setIsDeviceRemembered: Dispatch<SetStateAction<boolean>>;
  setPersistenceNotice: Dispatch<SetStateAction<string | null>>;
  /** Texte i18n affiché après « oublier cet appareil ». */
  forgetDeviceSuccessText: string;
}

export interface ProfileApi {
  myStatus: string;
  setMyStatus: Dispatch<SetStateAction<string>>;
  myPSM: string;
  setMyPSM: Dispatch<SetStateAction<string>>;
  myNickname: string;
  setMyNickname: Dispatch<SetStateAction<string>>;
  myAvatar: string;
  setMyAvatar: Dispatch<SetStateAction<string>>;
  myScene: string;
  setMyScene: Dispatch<SetStateAction<string>>;
  isEditingNickname: boolean;
  setIsEditingNickname: Dispatch<SetStateAction<boolean>>;
  isEditingPSM: boolean;
  setIsEditingPSM: Dispatch<SetStateAction<boolean>>;
  awayTimeout: number;
  setAwayTimeout: Dispatch<SetStateAction<number>>;
  enableAutoAway: boolean;
  setEnableAutoAway: Dispatch<SetStateAction<boolean>>;
  syncProfile: (updates: Partial<User>) => Promise<void>;
  handleChangePassword: (e: React.FormEvent) => Promise<void>;
  handleForgetDevice: () => Promise<void>;
}

export function useProfile(options: UseProfileOptions): ProfileApi {
  const {
    user,
    setUser,
    myKeysRef,
    setShowPasswordModal,
    setIsDeviceRemembered,
    setPersistenceNotice,
    forgetDeviceSuccessText
  } = options;

  const [myStatus, setMyStatus] = useState('online');
  const [myPSM, setMyPSM] = useState('Disponible');
  const [myNickname, setMyNickname] = useState('');
  const [myAvatar, setMyAvatar] = useState('/assets/usertiles/chess.png');
  const [myScene, setMyScene] = useState('/assets/scenes/0006.png');
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [isEditingPSM, setIsEditingPSM] = useState(false);

  // Dernière activité dans un ref : la stocker dans un état re-rendait toute l'application
  // à chaque mouvement de souris
  const lastActivityRef = useRef(0);
  const [awayTimeout, setAwayTimeout] = useState(() => loadAwayTimeout(5));
  const [enableAutoAway, setEnableAutoAway] = useState(() => loadEnableAutoAway(true));
  const [isAutoAway, setIsAutoAway] = useState(false);
  const isAutoAwayRef = useRef(false);
  useEffect(() => { isAutoAwayRef.current = isAutoAway; }, [isAutoAway]);
  const myStatusRef = useRef(myStatus);
  useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);

  /**
   * MISE À JOUR DU PROFIL SUR LE SERVEUR
   */
  const syncProfile = useCallback(async (updates: Partial<User>) => {
    if (!user) return;
    try {
      await axios.post('/api/user/update', {
        userId: user.id,
        nickname: updates.nickname !== undefined ? updates.nickname : myNickname,
        psm: updates.psm !== undefined ? updates.psm : myPSM,
        avatar: updates.avatar !== undefined ? updates.avatar : myAvatar,
        scene: updates.scene !== undefined ? updates.scene : myScene,
        // Le statut n'est envoyé que s'il est demandé : renvoyer l'état local à chaque
        // modification de profil pouvait écraser le vrai statut avec une valeur périmée
        // (ex. « offline » resté en mémoire après une déconnexion).
        ...(updates.status !== undefined ? { status: updates.status } : {})
      });
      const newUser = { ...user, ...updates };
      setUser(newUser);

      if (newUser.rememberMe) {
        localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage(newUser)));
      }
    } catch (err) {
      console.error("Échec de synchronisation du profil:", err);
    }
  }, [user, setUser, myNickname, myPSM, myAvatar, myScene]);

  /**
   * DÉTECTION D'INACTIVITÉ (AUTO-AWAY)
   */
  useEffect(() => {
    // Point de départ de l'inactivité : le montage (puis chaque changement de réglage)
    if (!lastActivityRef.current) lastActivityRef.current = Date.now();
    const resetActivity = () => {
      lastActivityRef.current = Date.now();
      if (isAutoAwayRef.current) {
        isAutoAwayRef.current = false;
        setIsAutoAway(false);
        if (myStatusRef.current === 'away') {
          setMyStatus('online');
          syncProfile({ status: 'online' });
        }
      }
    };

    // Souris, clavier, toucher (mobile), molette ; `scroll` en capture pour compter aussi le
    // défilement des zones internes (conversation, liste de contacts), qui ne remonte pas.
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'];
    events.forEach(ev => window.addEventListener(ev, resetActivity, { passive: true }));
    window.addEventListener('scroll', resetActivity, { passive: true, capture: true });

    const interval = setInterval(() => {
      if (enableAutoAway && !isAutoAwayRef.current && myStatusRef.current === 'online') {
        const inactiveTime = Date.now() - lastActivityRef.current;
        if (inactiveTime > awayTimeout * 60 * 1000) {
          isAutoAwayRef.current = true;
          setIsAutoAway(true);
          setMyStatus('away');
          syncProfile({ status: 'away' });
        }
      }
    }, 10000); // Vérification toutes les 10s

    return () => {
      events.forEach(ev => window.removeEventListener(ev, resetActivity));
      window.removeEventListener('scroll', resetActivity, { capture: true });
      clearInterval(interval);
    };
  }, [awayTimeout, enableAutoAway, syncProfile]);

  /**
   * CHANGEMENT DE MOT DE PASSE (re-chiffrement Zero-Knowledge de la clé privée)
   */
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const oldPInput = document.getElementById('old-password') as HTMLInputElement;
    const newPInput = document.getElementById('new-password') as HTMLInputElement;
    const oldP = oldPInput ? oldPInput.value : '';
    const newP = newPInput ? newPInput.value : '';

    if (!oldP || !newP) {
      alert("Veuillez renseigner l'ancien et le nouveau mot de passe.");
      return;
    }

    try {
      // 1. Dériver oldAuthKeyHex et oldVaultKey depuis l'ancien mot de passe
      const { authKeyHex: oldAuthKeyHex, vaultKey: oldVaultKey } = await deriveZeroKnowledgeKeys(user.username, oldP);

      // 2. Déchiffrer la clé privée RSA existante
      let privateKeyJwk = myKeysRef.current?.privateKeyJwk;
      if (!privateKeyJwk && user.encrypted_private_key) {
        const vault = typeof user.encrypted_private_key === 'string'
          ? JSON.parse(user.encrypted_private_key)
          : user.encrypted_private_key;
        privateKeyJwk = await decryptPrivateKeyVault(vault.encryptedKeyBase64, vault.ivBase64, oldVaultKey);
      }

      if (!privateKeyJwk) {
        alert("Impossible de déchiffrer votre clé privée actuelle. Vérifiez l'ancien mot de passe.");
        return;
      }

      // 3. Dériver newAuthKeyHex et newVaultKey depuis le nouveau mot de passe
      const { authKeyHex: newAuthKeyHex, vaultKey: newVaultKey } = await deriveZeroKnowledgeKeys(user.username, newP);

      // 4. Re-chiffrer la clé privée RSA avec newVaultKey
      const newEncryptedPrivateKey = await encryptPrivateKeyVault(privateKeyJwk, newVaultKey);

      // 5. Envoyer { oldAuthKeyHex, newAuthKeyHex, newEncryptedPrivateKey }
      const res = await axios.post('/api/user/change-password', {
        oldAuthKeyHex,
        newAuthKeyHex,
        newEncryptedPrivateKey
      });

      if (res.data && res.data.success) {
        setUser(prev => prev ? { ...prev, encrypted_private_key: JSON.stringify(newEncryptedPrivateKey) } : null);
        if (oldPInput) oldPInput.value = '';
        if (newPInput) newPInput.value = '';
        alert('Mot de passe changé avec succès !');
        setShowPasswordModal(false);
      }
    } catch (err: any) {
      console.error("Échec changement mot de passe:", err);
      alert(err.response?.data?.error || 'Erreur lors du changement de mot de passe');
    }
  };

  /**
   * OUBLIER CET APPAREIL (Suppression des clés locales sans déconnexion forcée)
   */
  const handleForgetDevice = async () => {
    try {
      if (user?.id) {
        await E2EEKeyStorage.removeKeys(user.id);
      }
      localStorage.removeItem('wlm_user');
      localStorage.removeItem('token');
      sessionStorage.clear();
      setIsDeviceRemembered(false);
      if (user) {
        setUser({ ...user, rememberMe: false });
      }
      setPersistenceNotice(forgetDeviceSuccessText);
    } catch (e) {
      console.warn('[Session] Erreur lors de l\'oubli de l\'appareil:', e);
    }
  };

  return {
    myStatus,
    setMyStatus,
    myPSM,
    setMyPSM,
    myNickname,
    setMyNickname,
    myAvatar,
    setMyAvatar,
    myScene,
    setMyScene,
    isEditingNickname,
    setIsEditingNickname,
    isEditingPSM,
    setIsEditingPSM,
    awayTimeout,
    setAwayTimeout,
    enableAutoAway,
    setEnableAutoAway,
    syncProfile,
    handleChangePassword,
    handleForgetDevice
  };
}
