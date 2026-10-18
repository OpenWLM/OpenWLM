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
  loadSystemIdleEnabled,
  saveSystemIdleEnabled,
  sanitizeUserForStorage
} from '../utils/profileStorage';
import {
  getSystemIdleSupport,
  querySystemIdlePermission,
  requestSystemIdlePermission,
  startSystemIdleDetection,
  watchSystemIdlePermission,
  type SystemIdlePermission,
  type SystemIdleSupport
} from '../utils/systemIdle';
import type { User } from '../types';
import type { ChangePasswordResult } from '../components/PasswordModal';

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
  /** Inactivité de tout l'ordinateur (API Idle Detection) : préférence de l'appareil. */
  systemIdleEnabled: boolean;
  /** true quand la détection système tourne réellement (permission accordée, API disponible). */
  systemIdleRunning: boolean;
  systemIdleSupport: SystemIdleSupport;
  /** Active l'option : demande la permission (à appeler depuis un clic). */
  enableSystemIdle: () => Promise<SystemIdlePermission>;
  disableSystemIdle: () => void;
  syncProfile: (updates: Partial<User>) => Promise<void>;
  handleChangePassword: (currentPassword: string, newPassword: string, socketId?: string) => Promise<ChangePasswordResult>;
  handleForgetDevice: () => Promise<void>;
}

export function useProfile(options: UseProfileOptions): ProfileApi {
  const {
    user,
    setUser,
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
  const [systemIdleEnabled, setSystemIdleEnabled] = useState(() => loadSystemIdleEnabled());
  const [systemIdleRunning, setSystemIdleRunning] = useState(false);
  const systemIdleRunningRef = useRef(false);
  const systemIdleSupport = getSystemIdleSupport();
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
   * Deux sources, jamais en même temps :
   * - par défaut, l'activité dans la page OpenWLM (souris, clavier, toucher, défilement) ;
   * - si l'option est activée et autorisée, l'inactivité de tout l'ordinateur et le
   *   verrouillage de l'écran (API Idle Detection, voir src/utils/systemIdle.ts).
   * Seul un statut « Disponible » passe en absence automatique ; il revient « Disponible » au
   * retour de l'activité. Un statut choisi à la main n'est jamais modifié.
   */
  const goAutoAway = useCallback(() => {
    if (isAutoAwayRef.current || myStatusRef.current !== 'online') return;
    isAutoAwayRef.current = true;
    setIsAutoAway(true);
    setMyStatus('away');
    syncProfile({ status: 'away' });
  }, [syncProfile]);

  const leaveAutoAway = useCallback(() => {
    if (!isAutoAwayRef.current) return;
    isAutoAwayRef.current = false;
    setIsAutoAway(false);
    if (myStatusRef.current === 'away') {
      setMyStatus('online');
      syncProfile({ status: 'online' });
    }
  }, [syncProfile]);

  // Callbacks lus par référence : les effets ci-dessous ne doivent PAS redémarrer quand le
  // profil change (sinon le détecteur système, relancé, signale d'abord « actif » et annule
  // l'absence qu'il venait de déclencher)
  const goAutoAwayRef = useRef(goAutoAway);
  const leaveAutoAwayRef = useRef(leaveAutoAway);
  useEffect(() => {
    goAutoAwayRef.current = goAutoAway;
    leaveAutoAwayRef.current = leaveAutoAway;
  }, [goAutoAway, leaveAutoAway]);

  // Source 1 : activité dans la page (ignorée quand la détection système tourne)
  useEffect(() => {
    // Point de départ de l'inactivité : le montage (puis chaque changement de réglage)
    if (!lastActivityRef.current) lastActivityRef.current = Date.now();
    const resetActivity = () => {
      lastActivityRef.current = Date.now();
      if (!systemIdleRunningRef.current) leaveAutoAwayRef.current();
    };

    // Souris, clavier, toucher (mobile), molette ; `scroll` en capture pour compter aussi le
    // défilement des zones internes (conversation, liste de contacts), qui ne remonte pas.
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'];
    events.forEach(ev => window.addEventListener(ev, resetActivity, { passive: true }));
    window.addEventListener('scroll', resetActivity, { passive: true, capture: true });

    const interval = setInterval(() => {
      if (!enableAutoAway || systemIdleRunningRef.current) return;
      if (Date.now() - lastActivityRef.current > awayTimeout * 60 * 1000) goAutoAwayRef.current();
    }, 10000); // Vérification toutes les 10s

    return () => {
      events.forEach(ev => window.removeEventListener(ev, resetActivity));
      window.removeEventListener('scroll', resetActivity, { capture: true });
      clearInterval(interval);
    };
  }, [awayTimeout, enableAutoAway]);

  // Source 2 : inactivité de tout l'ordinateur (opt-in). Reprise automatique au démarrage si
  // la permission a déjà été accordée ; sinon retour à la détection dans la page.
  // Permission retirée (ou rendue) en cours de session : la détection est relancée, ce qui
  // l'arrête et rebascule sur l'activité dans la page tant que la permission manque.
  const [systemIdlePermissionEpoch, setSystemIdlePermissionEpoch] = useState(0);
  useEffect(() => {
    if (!enableAutoAway || !systemIdleEnabled || systemIdleSupport !== 'available') return;
    return watchSystemIdlePermission(() => setSystemIdlePermissionEpoch((n) => n + 1));
  }, [enableAutoAway, systemIdleEnabled, systemIdleSupport]);

  useEffect(() => {
    if (!enableAutoAway || !systemIdleEnabled || systemIdleSupport !== 'available') return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const permission = await querySystemIdlePermission();
      if (cancelled || permission !== 'granted') return;
      stop = await startSystemIdleDetection(awayTimeout * 60 * 1000, (idle) => {
        if (idle) goAutoAwayRef.current(); else leaveAutoAwayRef.current();
      });
      if (cancelled) { stop?.(); return; }
      if (stop) {
        systemIdleRunningRef.current = true;
        setSystemIdleRunning(true);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
      systemIdleRunningRef.current = false;
      setSystemIdleRunning(false);
      lastActivityRef.current = Date.now();
    };
  }, [enableAutoAway, systemIdleEnabled, systemIdleSupport, awayTimeout, systemIdlePermissionEpoch]);

  const enableSystemIdle = useCallback(async (): Promise<SystemIdlePermission> => {
    const permission = await requestSystemIdlePermission();
    if (permission === 'granted') {
      saveSystemIdleEnabled(true);
      setSystemIdleEnabled(true);
    }
    return permission;
  }, []);

  const disableSystemIdle = useCallback(() => {
    saveSystemIdleEnabled(false);
    setSystemIdleEnabled(false);
  }, []);

  /**
   * CHANGEMENT DE MOT DE PASSE (re-chiffrement Zero-Knowledge de la clé privée)
   */
  // `socketId` : connexion temps réel de cet appareil, conservée par le serveur (les autres sont coupées)
  const handleChangePassword = async (oldP: string, newP: string, socketId?: string): Promise<ChangePasswordResult> => {
    if (!user || !oldP || !newP) return { ok: false, error: 'failed' };
    try {
      // 1. Dériver oldAuthKeyHex et oldVaultKey depuis l'ancien mot de passe
      const { authKeyHex: oldAuthKeyHex, vaultKey: oldVaultKey } = await deriveZeroKnowledgeKeys(user.username, oldP);

      // 2. Clé privée RSA en clair (JWK), obtenue en déchiffrant le coffre avec l'ancien mot de
      //    passe (échec = ancien mot de passe incorrect). La clé de la session ne convient pas :
      //    elle est NON EXTRACTIBLE (CryptoKey), la re-chiffrer donnait un coffre vide.
      let vaultSource = user.encrypted_private_key;
      if (!vaultSource) {
        const me = await axios.get('/api/user/me');
        vaultSource = me.data?.user?.encrypted_private_key;
      }
      if (!vaultSource) return { ok: false, error: 'failed' };
      let privateKeyJwk: JsonWebKey | null = null;
      try {
        const vault = typeof vaultSource === 'string' ? JSON.parse(vaultSource) : vaultSource;
        privateKeyJwk = await decryptPrivateKeyVault(vault.encryptedKeyBase64, vault.ivBase64, oldVaultKey);
      } catch {
        privateKeyJwk = null;
      }
      if (!privateKeyJwk || typeof privateKeyJwk !== 'object' || !privateKeyJwk.d) return { ok: false, error: 'wrongCurrent' };

      // 3. Dériver newAuthKeyHex et newVaultKey depuis le nouveau mot de passe
      const { authKeyHex: newAuthKeyHex, vaultKey: newVaultKey } = await deriveZeroKnowledgeKeys(user.username, newP);

      // 4. Re-chiffrer la clé privée RSA avec newVaultKey
      const newEncryptedPrivateKey = await encryptPrivateKeyVault(privateKeyJwk, newVaultKey);

      // 5. Envoyer { oldAuthKeyHex, newAuthKeyHex, newEncryptedPrivateKey }. Le serveur vérifie
      //    l'ancien mot de passe, renouvelle le cookie de CET appareil et coupe les connexions
      //    des autres (ils reviennent à l'écran de connexion).
      const res = await axios.post('/api/user/change-password', {
        oldAuthKeyHex,
        newAuthKeyHex,
        newEncryptedPrivateKey,
        socketId
      });
      if (res.data && res.data.success) {
        setUser(prev => prev ? { ...prev, encrypted_private_key: JSON.stringify(newEncryptedPrivateKey) } : null);
        return { ok: true };
      }
      return { ok: false, error: 'failed' };
    } catch (err: unknown) {
      const r = (err as { response?: { status?: number; data?: { error?: string } } }).response;
      console.error("Échec changement mot de passe:", err);
      if (r?.status === 401) return { ok: false, error: 'wrongCurrent' };
      return { ok: false, error: 'failed', message: r?.data?.error };
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
    systemIdleEnabled,
    systemIdleRunning,
    systemIdleSupport,
    enableSystemIdle,
    disableSystemIdle,
    syncProfile,
    handleChangePassword,
    handleForgetDevice
  };
}
