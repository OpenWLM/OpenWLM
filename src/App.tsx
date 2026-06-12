import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import Auth from './components/Auth';
import './WLM.css';
import SoundManager from './utils/SoundManager';
import LocalDB from './utils/LocalDB';
import { 
  sanitize, 
  generateKeyPair, 
  encryptMessagePayload, 
  decryptMessagePayload, 
  encryptPrivateKeyVault, 
  decryptPrivateKeyVault 
} from './utils/Security';
import WinkPlayer from './components/WinkPlayer';
import VideoCall from './components/VideoCall';

/**
 * INTERFACES
 */

interface User {
  id: number;
  username: string;
  nickname?: string;
  psm?: string;
  avatar?: string;
  scene?: string;
  status?: string;
  token: string;
  encrypted_private_key?: string;
  public_key?: string;
  plaintextPassword?: string; // Utilisé temporairement lors de la connexion pour le coffre-fort E2E
  global_private?: number;
  rememberMe?: boolean;
}

interface Contact {
  id: number;
  username: string;
  nickname?: string;
  psm?: string;
  avatar?: string;
  scene?: string;
  status: string;
  blocked: number | boolean;
  global_private?: number;
}

interface Message {
  senderId?: number;
  receiverId?: number;
  sender: string;
  text: string;
  time?: string;
  style?: any;
  audio?: string | null;
  type?: string;
  isWink?: boolean;
}

interface FontSettings {
  family: string;
  weight: string;
  style: string;
  color: string;
  size: string;
  strikeout: boolean;
  underline: boolean;
}

/**
 * CONSTANTES DE CONFIGURATION
 */

const WLM_COLORS = [
  { name: 'Noir', hex: '#000000' },
  { name: 'Bordeaux', hex: '#800000' },
  { name: 'Vert', hex: '#008000' },
  { name: 'Olive', hex: '#808000' },
  { name: 'Bleu marine', hex: '#000080' },
  { name: 'Violet', hex: '#800080' },
  { name: 'Sarcelle', hex: '#008080' },
  { name: 'Gris', hex: '#808080' },
  { name: 'Argent', hex: '#C0C0C0' },
  { name: 'Rouge', hex: '#FF0000' },
  { name: 'Citron vert', hex: '#00FF00' },
  { name: 'Jaune', hex: '#FFFF00' },
  { name: 'Bleu', hex: '#0000FF' },
  { name: 'Fuchsia', hex: '#FF00FF' },
  { name: 'Aqua', hex: '#00FFFF' },
  { name: 'Blanc', hex: '#FFFFFF' },
];



const SCENES = [
  { id: '1', file: '0001.png', name: 'Marguerites' },
  { id: '2', file: '0002.jpg', name: 'Bambou' },
  { id: '3', file: '0003.jpg', name: 'Cerisiers' },
  { id: '4', file: '0004.png', name: 'Fleur Violette' },
  { id: '6', file: '0006.png', name: 'Aurore' },
  { id: '10', file: 'CarbonFiber.jpg', name: 'Carbone' },
  { id: '16', file: 'ButterflyPattern.png', name: 'Papillon' },
];

const WINKS = [
  { id: 'bouncy_ball', name: 'Bouncy Ball', icon: '⚽' },
  { id: 'kiss', name: 'Kiss', icon: '💋' },
  { id: 'love_letter', name: 'Love Letter', icon: '💌' },
  { id: 'frog', name: 'Frog', icon: '🐸' },
  { id: 'guitar_smash', name: 'Guitar Smash', icon: '🎸' },
  { id: 'heart', name: 'Heart', icon: '❤️' },
  { id: 'knock', name: 'Knock', icon: '🚪' },
];

const STATUS_OPTIONS = [
  { id: 'online', label: 'Disponible', color: '#5ec300' },
  { id: 'busy', label: 'Occupé', color: '#ef3100' },
  { id: 'away', label: 'Absent', color: '#f9a000' },
  { id: 'offline', label: 'Hors ligne', color: '#a0a0a0' },
];

const EMOTICON_MAP: Record<string, string> = {
  ':)': 'regular_smile.gif',
  ':-)': 'regular_smile.gif',
  ':D': 'teeth_smile.gif',
  ':-D': 'teeth_smile.gif',
  ';)': 'wink_smile.gif',
  ';-)': 'wink_smile.gif',
  ':O': 'omg_smile.gif',
  ':-O': 'omg_smile.gif',
  ':P': 'tongue_smile.gif',
  ':-P': 'tongue_smile.gif',
  '(H)': 'shades_smile.gif',
  ':@': 'angry_smile.gif',
  ':-@': 'angry_smile.gif',
  ':S': 'confused_smile.gif',
  ':-S': 'confused_smile.gif',
  ':$': 'red_smile.gif',
  ':-$': 'red_smile.gif',
  ':(': 'sad_smile.gif',
  ':-(': 'sad_smile.gif',
  ":'(": 'cry_smile.gif',
  ':|': 'what_smile.gif',
  ':-|': 'what_smile.gif',
  '(A)': 'angel_smile.gif',
  '8o|': 'angry.gif',
  '8-|': 'glasses_happy.gif',
  '+o(': 'sick.gif',
  '<:o)': 'party.gif',
  '|-)': 'Sleepy.gif',
  '*-)': 'thinking.gif',
  ':-#': 'shutup.gif',
  ':-*': 'kiss.gif',
  '^o)': 'eye-rolling.gif',
  '8-)': 'glasses_happy.gif',
  '(L)': 'heart.gif',
  '(U)': 'broken_heart.gif',
  '(M)': 'messenger.gif',
  '(@)': 'cat.gif',
  '(&)': 'dog.gif',
  '(sn)': 'escargot.gif',
  '(bah)': 'sheep.gif',
  '(S)': 'moon.gif',
  '(*)': 'star.gif',
  '(#)': 'idk.gif',
  '(R)': 'rose.gif',
  '({)': 'guy_hug.gif',
  '(})': 'girl_hug.gif',
  '(K)': 'kiss.gif',
  '(F)': 'rose.gif',
  '(W)': 'wilted_rose.gif',
  '(O)': 'clock.gif',
  '(ip)': 'airplane.gif',
  '(b)': 'beer_mug.gif',
  '(d)': 'bowl.gif',
  '(c)': 'coffee.gif',
  '(co)': 'computer.gif',
  '(e)': 'envelope.gif',
  '(f)': 'film.gif',
  '(g)': 'gift.gif',
  '(i)': 'lightbulb.gif',
  '(l)': 'Lightning.gif',
  '(m)': 'mobile.gif',
  '(n)': 'note.gif',
  '(p)': 'phone.gif',
  '(pi)': 'pizza.gif',
  '(pl)': 'plate.gif',
  '(r)': 'rain.gif',
  '(u)': 'umbrella.gif',
};

const EMOTICONS_LIST = (() => {
  const seenFiles = new Set<string>();
  const list: { shortcut: string, file: string }[] = [];
  Object.entries(EMOTICON_MAP).forEach(([shortcut, file]) => {
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      list.push({ shortcut, file });
    }
  });
  return list;
})();

const USERTILES = [
  'basketball.png', 'bonsai.png', 'chef.png', 'chess.png', 'daisy.png',
  'doctor.png', 'dog.png', 'electric_guitar.png', 'executive.png', 'fish.png',
  'flare.png', 'gerber_daisy.png', 'golf.png', 'guest.png', 'guitar.png',
  'kitten.png', 'leaf.png', 'morty.png', 'music.png', 'robot.png',
  'seastar.png', 'shopping.png', 'sports.png', 'surf.png', 'tennis.png'
];

const CONV_BACKGROUNDS = [
  { id: 'none', name: 'Standard', file: '' },
  { id: 'car', name: 'Voiture', file: 'car.jpg' },
  { id: 'fish', name: 'Poissons', file: 'fish.jpg' },
  { id: 'hearts', name: 'Cœurs', file: 'hearts.jpg' },
  { id: 'lavender', name: 'Lavande', file: 'lavender.jpg' },
  { id: 'planets', name: 'Planètes', file: 'planets.jpg' },
];

/**
 * COMPOSANTS AUXILIAIRES
 */

/**
 * Lecteur de clip vocal simple avec icône play/pause et barre de progression texte.
 */
const VoiceClipPlayer: React.FC<{ src: string }> = ({ src }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const togglePlay = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(src);
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      audioRef.current.ontimeupdate = () => {
        setCurrentTime(audioRef.current?.currentTime || 0);
      };
      audioRef.current.onloadedmetadata = () => {
        setDuration(audioRef.current?.duration || 0);
      };
    }

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(err => console.error("Erreur lecture audio:", err));
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="wlm-voice-clip-player" onClick={togglePlay} title="Cliquer pour écouter">
      <div className={`play-pause-icon ${isPlaying ? 'pause' : 'play'}`}></div>
      <div className="voice-clip-info">
        <span className="voice-clip-text">{isPlaying ? 'Lecture...' : 'Écouter le clip vocal'}</span>
        {duration > 0 && (
          <span className="voice-clip-timer">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  // --- ÉTAT UTILISATEUR & AUTHENTIFICATION ---
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('wlm_user');
      return saved ? JSON.parse(saved) : null;
    } catch (e) { 
      console.error("Erreur lecture wlm_user localstorage:", e);
      return null; 
    }
  });

  // --- ÉTAT SOCKET & NAVIGATION ---
  const [socket, setSocket] = useState<Socket | null>(null);
  const [openChatIds, setOpenChatIds] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('wlm_open_chats');
      return saved ? JSON.parse(saved) : [];
    } catch (e) { return []; }
  });
  const [activeChatId, setActiveChatId] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('wlm_active_chat');
      return saved ? parseInt(saved) : 0;
    } catch (e) { return 0; }
  });

  // --- ÉTAT DU PROFIL PERSONNEL ---
  const [myStatus, setMyStatus] = useState('online');
  const [myPSM, setMyPSM] = useState('Disponible');
  const [myNickname, setMyNickname] = useState('');
  const [myAvatar, setMyAvatar] = useState('/assets/usertiles/chess.png');
  const [myScene, setMyScene] = useState('/assets/scenes/0006.png');
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [isEditingPSM, setIsEditingPSM] = useState(false);

  // --- ÉTAT DE L'INACTIVITÉ (AUTO-AWAY) ---
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [awayTimeout, setAwayTimeout] = useState(() => {
    const saved = localStorage.getItem('wlm_away_timeout');
    return saved ? parseInt(saved) : 5; // Défaut 5 minutes
  });
  const [enableAutoAway, setEnableAutoAway] = useState(() => {
    const saved = localStorage.getItem('wlm_enable_auto_away');
    return saved !== 'false'; // Défaut activé
  });
  const [isAutoAway, setIsAutoAway] = useState(false);

  // --- ÉTAT DES MODALES & MENUS ---
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showBgModal, setShowBgModal] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showWinksModal, setShowWinksModal] = useState(false);
  const [showEmoticonMenu, setShowEmoticonMenu] = useState(false);
  const [showAllEmoticonsModal, setShowAllEmoticonsModal] = useState(false);
  const [showFontModal, setShowFontModal] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [showColorDropdown, setShowColorDropdown] = useState(false);

  // --- RÉFÉRENCES ---
  const myStatusRef = useRef(myStatus);
  useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);
  
  

  /**
   * BASCULER LE MODE PRIVÉ (AVEC NOTIFICATION)
   */
  const togglePrivateMode = (chatId: number) => {
    const activeContact = contacts.find(c => c.id === chatId);
    if (activeContact?.global_private === 1) {
      alert("Ce contact a imposé le mode privé. Vous ne pouvez pas le désactiver.");
      return;
    }
    if (globalPrivateMode) {
      alert("Le mode privé global est activé. Désactivez-le dans le menu principal pour gérer individuellement.");
      return;
    }
    const newState = !isPrivateMode[chatId];
    setIsPrivateMode(prev => ({ ...prev, [chatId]: newState }));
    
    // Notification système locale
    const systemMsg = {
      senderId: 0,
      receiverId: chatId,
      text: `Vous avez ${newState ? 'activé' : 'désactivé'} le mode privé. Les messages ${newState ? 'ne seront plus' : 'seront à nouveau'} enregistrés.`,
      sender: 'Système',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages(prev => ({ ...prev, [chatId]: [...(prev[chatId] || []), systemMsg] }));

    // Envoyer au destinataire
    if (socket) {
      socket.emit('toggle_private_mode', {
        senderId: user?.id,
        receiverId: chatId,
        isPrivate: newState,
        senderNickname: myNickname
      });
    }
  };

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
        status: updates.status !== undefined ? updates.status : myStatus
      });
      const newUser = { ...user, ...updates };
      setUser(newUser);

      // SÉCURITÉ : Ne jamais persister le mot de passe sur le disque
      const userToSave = { ...newUser };
      delete userToSave.plaintextPassword;
      localStorage.setItem('wlm_user', JSON.stringify(userToSave));
    } catch (err) { 
      console.error("Échec de synchronisation du profil:", err); 
    }
  }, [user, myNickname, myPSM, myAvatar, myScene, myStatus]);

  /**
   * DÉTECTION D'INACTIVITÉ (AUTO-AWAY)
   */
  useEffect(() => {
    const resetActivity = () => {
      setLastActivity(Date.now());
      if (isAutoAway) {
        setIsAutoAway(false);
        if (myStatusRef.current === 'away') {
          setMyStatus('online');
          syncProfile({ status: 'online' });
        }
      }
    };

    window.addEventListener('mousemove', resetActivity);
    window.addEventListener('keydown', resetActivity);
    window.addEventListener('mousedown', resetActivity);
    window.addEventListener('scroll', resetActivity);

    const interval = setInterval(() => {
      if (enableAutoAway && !isAutoAway && myStatusRef.current === 'online') {
        const inactiveTime = Date.now() - lastActivity;
        if (inactiveTime > awayTimeout * 60 * 1000) {
          setIsAutoAway(true);
          setMyStatus('away');
          syncProfile({ status: 'away' });
        }
      }
    }, 10000); // Vérification toutes les 10s

    return () => {
      window.removeEventListener('mousemove', resetActivity);
      window.removeEventListener('keydown', resetActivity);
      window.removeEventListener('mousedown', resetActivity);
      window.removeEventListener('scroll', resetActivity);
      clearInterval(interval);
    };
  }, [lastActivity, awayTimeout, enableAutoAway, isAutoAway, syncProfile]);

  // --- ÉTAT DES INTERACTIONS (Winks, Nudges, Voice) ---
  const [activeWink, setActiveWink] = useState<string | null>(null);
  const [winkCounter, setWinkCounter] = useState(0);
  const [isNudging, setIsNudging] = useState(false);
  const [nudgeTimestamps, setNudgeTimestamps] = useState<number[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const cancelRecordingRef = useRef(false);

  // --- ÉTAT DES APPELS (WebRTC) ---
  const [activeCallId, setActiveCallId] = useState<number | null>(null);
  const [isReceivingCall, setIsReceivingCall] = useState(false);
  const [callSignal, setCallSignal] = useState<any>(null);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [iceCandidatesBuffer, setIceCandidatesBuffer] = useState<any[]>([]);

  // --- ÉTAT DES CONTACTS & MESSAGES ---
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, contactId: number } | null>(null);
  const [messages, setMessages] = useState<Record<number, Message[]>>({});
  const [inputText, setInputText] = useState('');
  const [isGroupOpen, setIsGroupOpen] = useState(true);
  const [isOfflineGroupOpen, setIsOfflineGroupOpen] = useState(true);
  const [convBg, setConvBg] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState<Record<number, boolean>>(() => {
    try {
      const saved = localStorage.getItem('wlm_private_modes');
      return saved ? JSON.parse(saved) : {};
    } catch (e) { return {}; }
  });
  
  const [globalPrivateMode, setGlobalPrivateMode] = useState(() => {
    if (user && user.global_private !== undefined) return user.global_private === 1;
    return localStorage.getItem('wlm_global_private') === 'true';
  });

  // Sauvegarde persistante du mode privé global
  useEffect(() => {
    localStorage.setItem('wlm_global_private', globalPrivateMode.toString());
    
    // Synchroniser avec les chats ouverts
    if (user?.id && openChatIds.length > 0) {
       // Note: To avoid socket missing here, we'll handle emission in another way, 
       // but we persist the value so it applies to all logic.
    }
  }, [globalPrivateMode]);

  // Sauvegarde persistante du mode privé
  useEffect(() => {
    localStorage.setItem('wlm_private_modes', JSON.stringify(isPrivateMode));
  }, [isPrivateMode]);

  const isPrivateModeRef = useRef(isPrivateMode);
  useEffect(() => { isPrivateModeRef.current = isPrivateMode; }, [isPrivateMode]);
  

  // --- ÉTAT DE LA SÉCURITÉ (E2E) ---
  const [publicKeysCache, setPublicKeysCache] = useState<Record<number, any>>({});
  const [myKeys, setMyKeys] = useState<{ publicKeyJwk: any, privateKeyJwk: any } | null>(null);
  const myKeysRef = useRef<{ publicKeyJwk: any, privateKeyJwk: any } | null>(null);
  useEffect(() => { myKeysRef.current = myKeys; }, [myKeys]);

  // --- CONFIGURATION DE LA POLICE ---
  const [fontSettings, setFontSettings] = useState<FontSettings>({
    family: 'Segoe UI',
    weight: 'bold',
    style: 'normal',
    color: '#0000FF',
    size: '10',
    strikeout: false,
    underline: false
  });

  // --- AUTRES RÉFÉRENCES ---
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [contactEmail, setContactEmail] = useState('');

  // --- GESTION DE LA SESSION ET DES CLÉS ---
  useEffect(() => {
    const syncAndInit = async () => {
      console.log("[Session] Démarrage synchronisation...");
      if (!user) { console.warn("[Session] Pas d'utilisateur en mémoire."); return; }
      
      let currentUser = user;
      console.log("[Session] Utilisateur actuel:", currentUser.username, "ID:", currentUser.id, "RememberMe:", currentUser.rememberMe);

      // SÉCURITÉ & RÉSEAU : Configurer immédiatement le token pour les requêtes
      // Cela évite l'erreur 401 (Unauthorized) lors de la synchronisation initiale.
      if (currentUser.token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${currentUser.token}`;
      }

      try {
        // 1. Toujours synchroniser le profil avec le serveur pour avoir les dernières clés E2E
        const res = await axios.get(`/api/user/me`);
        if (res.data && res.data.user) {
          currentUser = { ...user, ...res.data.user };
          setUser(currentUser);
          
          // Mise à jour de l'état du mode privé global depuis le serveur
          if (currentUser.global_private !== undefined) {
            setGlobalPrivateMode(currentUser.global_private === 1);
          }

          // SÉCURITÉ : Ne jamais persister le mot de passe sur le disque
          const userToSave = { ...currentUser };
          delete userToSave.plaintextPassword;
          localStorage.setItem('wlm_user', JSON.stringify(userToSave));
        }
      } catch (err) {
        console.warn("[E2E] Impossible de synchroniser le profil, utilisation du cache local.", err);
      }

      // Chargement des préférences utilisateur
      setMyNickname(currentUser.nickname || currentUser.username || 'Utilisateur');
      setMyPSM(currentUser.psm || 'Disponible');
      setMyAvatar(currentUser.avatar || '/assets/usertiles/chess.png');
      setMyScene(currentUser.scene || '/assets/scenes/0006.png');
      setMyStatus(currentUser.status || 'online');

      // 2. Initialisation des clés E2E
      try {
        let localPrivJwk = localStorage.getItem(`wlm_priv_${currentUser.id}`);
        let localPubJwk = localStorage.getItem(`wlm_pub_${currentUser.id}`);

        // Migration des anciennes clés (si présentes)
        let legacyKeys = localStorage.getItem(`wlm_keys_${currentUser.id}`);
        if (legacyKeys && (!localPrivJwk || !localPubJwk)) {
          try {
            const parsed = JSON.parse(legacyKeys);
            localPrivJwk = JSON.stringify(parsed.privateKeyJwk);
            localPubJwk = JSON.stringify(parsed.publicKeyJwk);
            localStorage.setItem(`wlm_priv_${currentUser.id}`, localPrivJwk);
            localStorage.setItem(`wlm_pub_${currentUser.id}`, localPubJwk);
            localStorage.removeItem(`wlm_keys_${currentUser.id}`);
          } catch(e) { console.error("Échec migration clés legacy", e); }
        }

        // Vérifier si les clés locales correspondent à ce que le serveur attend
        const serverPubJwkStr = currentUser.public_key;
        let isStale = false;
        if (localPubJwk && serverPubJwkStr) {
          try {
            const localObj = JSON.parse(localPubJwk);
            const serverObj = typeof serverPubJwkStr === 'string' ? JSON.parse(serverPubJwkStr) : serverPubJwkStr;
            if (JSON.stringify(localObj) !== JSON.stringify(serverObj)) {
              console.warn("[E2E] Clés locales obsolètes (désynchronisées par rapport au serveur).");
              isStale = true;
            }
          } catch(e) { isStale = true; }
        }

        // SÉCURITÉ : Vérifier si l'utilisateur veut être mémorisé
        const shouldRemember = currentUser.rememberMe;

        // Cas 1 : Clés locales présentes et à jour
        if (localPrivJwk && localPubJwk && !isStale) {
          const keys = { publicKeyJwk: JSON.parse(localPubJwk), privateKeyJwk: JSON.parse(localPrivJwk) };
          setMyKeys(keys);

          // Si on a changé d'avis et qu'on ne veut plus être mémorisé : on purge le cache
          if (!shouldRemember) {
            localStorage.removeItem("wlm_priv_" + currentUser.id);
            localStorage.removeItem("wlm_pub_" + currentUser.id);
            console.log("[E2E] Clés purgées du disque (Mode RAM-only).");
          }
          
          // Si l'utilisateur n'a pas de backup sur le serveur (anomalie), on en crée un
          if (!currentUser.encrypted_private_key && currentUser.plaintextPassword) {
            const vault = await encryptPrivateKeyVault(JSON.parse(localPrivJwk), currentUser.plaintextPassword);
            await axios.post('/api/user/keys', { 
              userId: currentUser.id, 
              publicKey: keys.publicKeyJwk, 
              encryptedPrivateKey: vault 
            }).catch(e => console.warn("Échec backup clés vers serveur", e));
          }
          return;
        }

        // Cas 2 : Restauration depuis le serveur (Vault)
        // Indispensable lors d'une reconnexion sur une nouvelle machine
        if (currentUser.encrypted_private_key && currentUser.plaintextPassword) {
          console.log("[E2E] Restauration depuis le coffre-fort serveur...");
          const vaultStr = currentUser.encrypted_private_key;
          const vault = typeof vaultStr === 'string' ? JSON.parse(vaultStr) : vaultStr;
          
          const privJwk = await decryptPrivateKeyVault(vault.encryptedKeyBase64, vault.saltBase64, vault.ivBase64, currentUser.plaintextPassword);
          
          if (privJwk) {
            const pubJwk = typeof currentUser.public_key === 'string' ? JSON.parse(currentUser.public_key) : currentUser.public_key;
            
            // On ne sauvegarde sur le disque QUE si l'utilisateur l'a demandé
            if (shouldRemember) {
              localStorage.setItem("wlm_priv_" + currentUser.id, JSON.stringify(privJwk));
              localStorage.setItem("wlm_pub_" + currentUser.id, JSON.stringify(pubJwk));
            }

            setMyKeys({ publicKeyJwk: pubJwk, privateKeyJwk: privJwk });
            console.log(shouldRemember ? "[E2E] Synchro réussie (Persistant)." : "[E2E] Synchro réussie (RAM-only).");
          } else {
            handleLogout('Echec déchiffrement Vault');
          }
        } 
        // Cas 3 : Nouvel utilisateur sans clés du tout
        else if (!currentUser.encrypted_private_key && currentUser.plaintextPassword) {
          console.log("[E2E] Génération de nouvelles clés...");
          const keys = await generateKeyPair();
          const vault = await encryptPrivateKeyVault(keys.privateKeyJwk, currentUser.plaintextPassword);
          await axios.post('/api/user/keys', { userId: currentUser.id, publicKey: keys.publicKeyJwk, encryptedPrivateKey: vault });
          
          if (shouldRemember) {
            localStorage.setItem("wlm_priv_" + currentUser.id, JSON.stringify(keys.privateKeyJwk));
            localStorage.setItem("wlm_pub_" + currentUser.id, JSON.stringify(keys.publicKeyJwk));
          }
          setMyKeys(keys);
        } 
        else {
          // Si on est dans un état incohérent (ex: refresh F5 mais clés locales perdues ou stale)
          if (isStale || !localPrivJwk) {
            console.error("[E2E] Session RAM-only expirée ou clés obsolètes.");
            handleLogout('Session RAM-only expirée ou clés obsolètes');
          }
        }
      } catch (error) {
        console.error("[E2E] Erreur fatale lors de l'initialisation:", error);
        handleLogout('Erreur fatale initialisation');
            } finally {
        // PURGE DE SÉCURITÉ : On efface le mot de passe de la RAM et du DISQUE
        setUser(prev => {
          if (!prev) return null;
          const clean = { ...prev };
          delete clean.plaintextPassword;
          
          // On s'assure que localStorage est aussi purgé du mot de passe
          const saved = localStorage.getItem('wlm_user');
          if (saved) {
            try {
               const parsed = JSON.parse(saved);
               delete parsed.plaintextPassword;
               localStorage.setItem('wlm_user', JSON.stringify(parsed));
            } catch(e) {}
          }
          
          return clean;
        });
        console.log("[E2E] Mot de passe purgé de la mémoire vive et du cache.");
      }

    };

    syncAndInit();
  }, [user?.id]);

    /**
   * PERSISTENCE DE LA NAVIGATION
   */
  useEffect(() => {
    localStorage.setItem('wlm_open_chats', JSON.stringify(openChatIds));
  }, [openChatIds]);

  useEffect(() => {
    localStorage.setItem('wlm_active_chat', activeChatId.toString());
  }, [activeChatId]);

  /**
   * CHARGEMENT AUTOMATIQUE DE L'HISTORIQUE AU DÉMARRAGE (POUR LES ONGLETS OUVERTS)
   */
  useEffect(() => {
    let active = true;
    const loadAllOpenHistories = async () => {
      const keys = myKeysRef.current;
      if (!keys || openChatIds.length === 0) return;

      for (const id of openChatIds) {
        try {
          // Chargement depuis IndexedDB
          let history = await LocalDB.getMessages(`${user?.id}_${id}`, keys.privateKeyJwk);
          
          if (history.length > 0) {
            history = await decryptMessageArray(history, keys.privateKeyJwk);
          }
          
          // On tente quand même de récupérer les nouveaux messages du serveur (publics)
          try {
            const res = await axios.get(`/api/messages/${user?.id}/${id}`);
            if (res.data && res.data.length > 0) {
              const serverMsgs = await decryptMessageArray(res.data, keys.privateKeyJwk);
              
              // Fusionner (éviter les doublons basés sur le contenu et l'heure)
              // Note: On ignore les messages du serveur qui sont illisibles et absents du cache local
              const existingKeys = new Set(history.map(m => m.text + m.time));
              for (const sm of serverMsgs) {
                const key = sm.text + sm.time;
                if (!existingKeys.has(key)) {
                  if (sm.text === "[!] Message illisible (E2E)") continue; // Évite d'ajouter les "fantômes"
                  history.push(sm);
                  await LocalDB.saveMessage(`${user?.id}_${id}`, sm, keys.publicKeyJwk);
                }
              }
            }
          } catch(e) { /* Pas grave si le serveur est injoignable */ }

          if (active) {
            setMessages(prev => ({ ...prev, [id]: history }));
          }
        } catch (err) {
          console.error(`Erreur chargement auto historique pour ${id}:`, err);
        }
      }
    };

    if (user && myKeys) {
      loadAllOpenHistories();
    }
    return () => { active = false; };
  }, [user, !!myKeys, JSON.stringify(openChatIds)]);

  /**
   * AUTO-SCROLL DES MESSAGES
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }, 50);
    return () => clearTimeout(timer);
  }, [messages, activeChatId]);

  /**
   * GESTION DES SOCKETS (CONNEXION & ÉVÉNEMENTS)
   */
  useEffect(() => {
    if (user?.id) {
      const newSocket = io({ auth: { token: user.token } });

      newSocket.on('connect', () => {
        newSocket.emit('identify', user.id);
      });

      // Réception d'un message (texte ou audio, éventuellement chiffré)
      newSocket.on('receive_message', async (data) => {
        const senderId = data.senderId;
        const originalSenderName = data.sender || data.sender_name || 'Contact';
        let decryptedData = { ...data };

        // Tentative de détection si le message est chiffré de bout en bout
        let isEncrypted = false;
        let parsedE2e = null;
        try {
           const potentialJson = JSON.parse(data.text);
           if (potentialJson && (potentialJson.keyReceiver || potentialJson.keySender)) {
              isEncrypted = true;
              parsedE2e = potentialJson;
           }
        } catch(e) { /* Pas du JSON chiffré */ }

        if (isEncrypted) {
          const currentKeys = myKeysRef.current;
          if (currentKeys) {
            try {
              const isSender = data.senderId === user.id;
              const payload = await decryptMessagePayload(parsedE2e, currentKeys.privateKeyJwk, isSender);
              if (payload) {
                 decryptedData = { ...data, ...payload };
              } else {
                 decryptedData = { ...data, text: "[!] Message chiffré illisible", audio: null };
              }
            } catch(e) {
              console.error("Erreur de déchiffrement:", e);
              decryptedData = { ...data, text: "[!] Erreur de déchiffrement", audio: null };
            }
          } else {
            decryptedData = { ...data, text: "[!] Attente des clés de déchiffrement...", audio: null };
          }
        }

        // Mise à jour de l'interface
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        setActiveChatId(prev => prev === 0 ? senderId : prev);

        const finalMsg = { ...decryptedData, sender: decryptedData.sender || originalSenderName };

        setMessages(prev => {
          const currentMsgs = prev[senderId] || [];
          return {
            ...prev,
            [senderId]: [...currentMsgs, finalMsg]
          };
        });

        // Sauvegarde locale dans IndexedDB (Chiffré)
        if (myKeysRef.current) {
          LocalDB.saveMessage(`${user?.id}_${senderId}`, finalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
        }

        // Déclenchement des actions spéciales si chiffré
        if (decryptedData.type === 'wink' && decryptedData.winkId) {
          handleSendWink(decryptedData.winkId, true, senderId);
        } else if (decryptedData.type === 'nudge') {
          handleNudge(true, senderId);
        } else {
          SoundManager.play('NEW_MESSAGE');
        }

      });

      // Réception d'un Wizz
      newSocket.on('receive_wizz', (data) => {
        const senderId = data.senderId;
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        setActiveChatId(prev => (prev === 0 ? senderId : prev));
        handleNudge(true, senderId);
      });

      // Réception d'un Clin d'œil
      newSocket.on('receive_wink', (data) => {
        const senderId = data.senderId;
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        setActiveChatId(prev => (prev === 0 ? senderId : prev));
        handleSendWink(data.winkId, true, senderId);
      });

      // Synchronisation du Mode Privé
      newSocket.on('private_mode_changed', (data: any) => {
        const { senderId, isPrivate, senderNickname } = data;
        setIsPrivateMode(prev => ({ ...prev, [senderId]: isPrivate }));

        const systemMsg: Message = {
          senderId: 0,
          receiverId: senderId,
          text: `${senderNickname} a ${isPrivate ? 'activé' : 'désactivé'} le mode privé. Les messages ${isPrivate ? 'ne seront pas' : 'seront'} enregistrés.`,
          sender: 'Système',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => ({ ...prev, [senderId]: [...(prev[senderId] || []), systemMsg] }));
      });

      // WebRTC : Réception d'un appel
      newSocket.on('incoming_call', (data) => {
        console.log("Appel entrant de :", data.callerName);
        
        try { setCallSignal(JSON.parse(decodeURIComponent(escape(window.atob(data.signal))))); } catch(e) { setCallSignal(data.signal); }
        setActiveCallId(data.caller);
        setIsReceivingCall(true);
        setIsAudioOnly(!!data.audioOnly);
      });

      // Bufferisation des signaux WebRTC (ICE candidates) arrivant avant la réponse
      newSocket.on('webrtc_signal', (data) => {
        let signal = data.signal;
        try { signal = JSON.parse(decodeURIComponent(escape(window.atob(data.signal)))); } catch(e) {}
        if (signal && signal.type === 'ice-candidate') {
           setIceCandidatesBuffer(prev => [...prev, signal.candidate]);
        }
      });
      // Changement de statut d'un contact
      newSocket.on('user_status_changed', (data) => {
        setContacts(prev => {
          const prevContact = prev.find(c => c.id === data.userId);
          if (prevContact) {
            const isNowOnline = data.status !== 'offline';
            const wasOffline = prevContact.status === 'offline';
            if (isNowOnline && wasOffline) {
              SoundManager.play('ONLINE');
            }
            if (data.global_private !== undefined) {
               prevContact.global_private = data.global_private;
            }
          }
          return prev.map(c => c.id === data.userId ? { ...c, ...data } : c);
        });
      });

      // Invitation acceptée
      newSocket.on('contact_accepted', () => {
        refreshData();
      });

      setSocket(newSocket);
      return () => { newSocket.disconnect(); };
    }
  }, [user?.id]);

  /**
   * RÉCUPÉRATION DE L'HISTORIQUE DES MESSAGES
   */
  useEffect(() => {
    const fetchHistory = async () => {
      // On ne récupère l'historique que si on a un utilisateur, des clés E2E et une discussion active vide
      if (user && myKeys && activeChatId !== 0 && (!messages[activeChatId] || messages[activeChatId].length === 0)) {
        try {
          const res = await axios.get(`/api/messages/${user.id}/${activeChatId}`);
          
          if (!Array.isArray(res.data)) return;

          const historyPromises = res.data.map(async (m: any) => {
            let decryptedM = { ...m };
            let isEncrypted = false;
            let parsedE2e = null;
            
            try {
               const potentialJson = JSON.parse(m.text);
               if (potentialJson && potentialJson.keyReceiver) {
                  isEncrypted = true;
                  parsedE2e = potentialJson;
               }
            } catch(e) { /* Pas du JSON chiffré */ }

            if (isEncrypted && myKeys) {
              const isSender = m.sender_id === user.id;
              try {
                const payload = await decryptMessagePayload(parsedE2e, myKeys.privateKeyJwk, isSender);
                if (payload) {
                   decryptedM = { ...m, ...payload };
                } else {
                   decryptedM = { ...m, text: "[!] Message chiffré illisible", audio: null };
                }
              } catch (err) {
                decryptedM = { ...m, text: "[!] Erreur de déchiffrement", audio: null };
              }
            }

            return {
              ...decryptedM,
              sender: m.sender_id === user.id ? myNickname : (decryptedM.sender || m.sender_name || 'Contact'),
              style: decryptedM.style ? (typeof decryptedM.style === 'string' ? JSON.parse(decryptedM.style) : decryptedM.style) : null
            };
          });

          const history = await Promise.all(historyPromises);
          setMessages(prev => ({ ...prev, [activeChatId]: history }));
        } catch (err) { 
          console.error("Erreur lors de la récupération de l'historique:", err); 
        }
      }
    };
    fetchHistory();
  }, [activeChatId, user, myNickname, myKeys]);

  /**
   * RÉCUPÉRATION DE LA CLÉ PUBLIQUE D'UN CONTACT (Cache-first)
   */
  const getPublicKey = async (contactId: number) => {
    if (publicKeysCache[contactId]) return publicKeysCache[contactId];
    try {
      const res = await axios.get(`/api/user/${contactId}/public-key`);
      if (res.data && res.data.publicKey) {
        setPublicKeysCache(prev => ({ ...prev, [contactId]: res.data.publicKey }));
        return res.data.publicKey;
      }
    } catch (e) { 
      console.warn("Impossible de récupérer la clé publique pour l'ID:", contactId); 
    }
    return null;
  };

  /**
   * RÉCUPÉRATION DES CONTACTS & INVITATIONS
   */
  const refreshData = useCallback(async () => {
    if (!user) return;
    try {
      const [resContacts, resInvites] = await Promise.all([
        axios.get(`/api/contacts/${user.id}`),
        axios.get(`/api/invitations/${user.id}`)
      ]);
      
      if (Array.isArray(resContacts.data)) {
        setContacts(resContacts.data);
        // Synchroniser le cache des clés publiques pour éviter les messages illisibles
        const newKeys: Record<number, any> = {};
        resContacts.data.forEach((c: any) => {
          if (c.public_key) {
            try {
              newKeys[c.id] = typeof c.public_key === 'string' ? JSON.parse(c.public_key) : c.public_key;
            } catch(e) {}
          }
        });
        setPublicKeysCache(prev => ({ ...prev, ...newKeys }));
      }
      if (Array.isArray(resInvites.data)) setPendingInvites(resInvites.data);
    } catch (err) { 
      console.error("Erreur lors du rafraîchissement des données:", err); 
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshData();
      const interval = setInterval(refreshData, 15000); // Rafraîchissement toutes les 15s
      return () => clearInterval(interval);
    }
  }, [user, refreshData]);

  /**
   * ENVOI D'UN MESSAGE TEXTE
   */
  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    if (!socket) { console.error("Socket non prêt"); return; }
    if (!myKeys) { console.error("Clés E2E non prêtes"); return; }
    
    // On récupère la clé publique du destinataire pour le chiffrement E2E
    const contactPubKey = await getPublicKey(activeChatId);
    if (!contactPubKey) {
      alert("Ce contact doit se connecter au moins une fois pour activer la discussion sécurisée.");
      return;
    }

    try {
      const unencryptedPayload = { 
        text: sanitize(inputText), 
        sender: myNickname, 
        style: { ...fontSettings }, 
        type: 'text' 
      };
      
      // Chiffrement du message
      const e2eData = await encryptMessagePayload(unencryptedPayload, contactPubKey, myKeys.publicKeyJwk);

      const msgData = { 
        senderId: user?.id, 
        receiverId: activeChatId, 
        text: JSON.stringify(e2eData), 
        style: null, 
        audio: null, 
        type: 'text',
        isPrivate: globalPrivateMode || !!isPrivateMode[activeChatId]
      };
      
      socket.emit('send_message', msgData);

      // Ajout local immédiat pour la fluidité (optimistic UI)
      const myLocalMsg = { 
        ...unencryptedPayload, 
        sender: myNickname, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
      };

      setMessages(prev => ({ 
        ...prev, 
        [activeChatId]: [...(prev[activeChatId] || []), myLocalMsg] 
      }));

      // Sauvegarde dans IndexedDB pour la persistance locale (Chiffré)
      if (myKeysRef.current) {
        LocalDB.saveMessage(`${user?.id}_${activeChatId}`, myLocalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
      }

      setInputText('');

    } catch (e) {
      console.error("Échec du chiffrement:", e);
      alert("Erreur lors du chiffrement du message.");
    }
  };

  /**
   * ENVOI D'UN CLIN D'ŒIL (WINK)
   */
  const handleSendWink = async (winkId: string, received: boolean = false, fromId: number = 0) => {
    const targetId = received ? fromId : activeChatId;

    if (!received) {
      if (!socket || !myKeys) return;
      const contactPubKey = await getPublicKey(activeChatId);
      if (!contactPubKey) {
        alert("Ce contact doit être en ligne pour recevoir un clin d'œil.");
        return;
      }

      const wink = WINKS.find(w => w.id === winkId);
      const unencryptedPayload = {
        text: `--- Clin d'œil: ${wink?.name || winkId} ---`,
        sender: myNickname,
        winkId: winkId,
        type: 'wink'
      };

      try {
        const e2eData = await encryptMessagePayload(unencryptedPayload, contactPubKey, myKeys.publicKeyJwk);
        socket.emit('send_message', {
          senderId: user?.id,
          receiverId: activeChatId,
          text: JSON.stringify(e2eData),
          type: 'wink',
          isPrivate: globalPrivateMode || !!isPrivateMode[activeChatId]
        });
      } catch (err) { console.error("Echec envoi Wink chiffré:", err); return; }
    }

    setShowWinksModal(false);
    setActiveWink(winkId);
    setWinkCounter(prev => prev + 1);
    
    const wink = WINKS.find(w => w.id === winkId);
    const msg: Message = { 
      text: received ? `Vous avez reçu un clin d'œil (${wink?.name || winkId}).` : `Vous venez d'envoyer un clin d'œil (${wink?.name || winkId}).`, 
      sender: 'Système', 
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
      isWink: true, 
      style: null 
    };
    
    setMessages(prev => ({ ...prev, [targetId]: [...(prev[targetId] || []), msg] }));
    if (!received) SoundManager.play('ONLINE');
  };

  /**
   * ENVOI/RÉCEPTION D'UN WIZZ (NUDGE)
   */
  const handleNudge = (received: boolean = false, fromId: number = 0) => {
    const targetId = received ? fromId : activeChatId;
    
    if (!received) {
      // Anti-spam local pour les Wizz
      const now = Date.now();
      const recentNudges = nudgeTimestamps.filter(ts => now - ts < 60000);
      if (recentNudges.length >= 3) {
        setMessages(prev => ({ 
          ...prev, 
          [activeChatId]: [...(prev[activeChatId] || []), { text: 'Vous ne pouvez pas envoyer de Wizz aussi souvent.', sender: 'Système' }] 
        }));
        return;
      }
      setNudgeTimestamps([...recentNudges, now]);
      if (socket) socket.emit('send_wizz', { senderId: user?.id, receiverId: activeChatId });
    }
    
    SoundManager.play('NUDGE');
    if (isNudging) return;
    setIsNudging(true);
    
    const msgText = received ? 'Vous venez de recevoir un Wizz !' : 'Vous venez d\'envoyer un Wizz !';
    setMessages(prev => ({ ...prev, [targetId]: [...(prev[targetId] || []), { text: msgText, sender: 'Système' }] }));
    setTimeout(() => setIsNudging(false), 2000);
  };

  const handleWinkFinish = useCallback(() => setActiveWink(null), []);

  /**
   * GESTION DES CLIPS VOCAUX
   */
  const handleCancelVoiceClip = () => {
    cancelRecordingRef.current = true;
    if (mediaRecorder) {
      mediaRecorder.stop();
      setIsRecording(false);
      setMediaRecorder(null);
    }
  };

  const handleVoiceClip = async () => {
    if (!isRecording) {
      cancelRecordingRef.current = false;
      try {
        if (!navigator.mediaDevices || !window.isSecureContext) {
          alert("Votre navigateur bloque l'accès au microphone car le site n'est pas sécurisé (HTTPS requis).");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        
        recorder.ondataavailable = (e) => chunks.push(e.data);
        
        recorder.onstop = async () => {
          if (cancelRecordingRef.current) return;
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          reader.onloadend = async () => {
            let base64Audio = reader.result as string;
             base64Audio = base64Audio.replace(/; *codecs=[^;]+/, '');
            
            if (!myKeys) return;
            const contactPubKey = await getPublicKey(activeChatId);
            if (!contactPubKey) {
              alert("Ce contact doit se connecter au moins une fois pour activer la discussion sécurisée.");
              return;
            }

            const unencryptedPayload = {
              text: '--- Clip vocal ---',
              sender: myNickname,
              style: { ...fontSettings },
              audio: base64Audio,
              type: 'audio'
            };

            try {
              const e2eData = await encryptMessagePayload(unencryptedPayload, contactPubKey, myKeys.publicKeyJwk);
              const msgData = {
                senderId: user?.id,
                receiverId: activeChatId,
                text: JSON.stringify(e2eData),
                style: null,
                audio: null,
                type: 'audio',
                isPrivate: globalPrivateMode || !!isPrivateMode[activeChatId]
              };

              if (socket) socket.emit('send_message', msgData);

              const myLocalMsg = {
                ...unencryptedPayload,
                sender: myNickname,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              };

              setMessages(prev => ({
                ...prev,
                [activeChatId]: [...(prev[activeChatId] || []), myLocalMsg]
              }));

              if (myKeysRef.current) {
                LocalDB.saveMessage(`${user?.id}_${activeChatId}`, myLocalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
              }
            } catch (err) {
              console.error("Échec chiffrement clip vocal:", err);
            }
          };
        };
        
        recorder.start();
        setMediaRecorder(recorder);
        setIsRecording(true);
      } catch (err) { 
        alert("Impossible d'accéder au microphone."); 
      }
    } else {
      mediaRecorder?.stop();
      setIsRecording(false);
      setMediaRecorder(null);
    }
  };

  /**
   * CHANGEMENT DE MOT DE PASSE
   */
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const oldP = (document.getElementById('old-password') as HTMLInputElement).value;
    const newP = (document.getElementById('new-password') as HTMLInputElement).value;
    
    try {
      let newVault = null;
      if (myKeysRef.current) {
         // On rechiffre la clé privée avec le nouveau mot de passe pour le coffre-fort
         newVault = await encryptPrivateKeyVault(myKeysRef.current.privateKeyJwk, newP);
      }
      const res = await axios.post('/api/user/change-password', {
        userId: user?.id,
        oldPassword: oldP,
        newPassword: newP,
        newVault
      });
      if (res.data && res.data.success) {
        alert('Mot de passe changé avec succès !');
        setShowPasswordModal(false);
      }
    } catch (err: any) {
      console.error("Échec changement mot de passe:", err);
      alert(err.response?.data?.error || 'Erreur lors du changement de mot de passe');
    }
  };

  /**
   * RÉINITIALISATION DES CLÉS E2E
   */
  const handleResetE2EKeys = async () => {
    if (window.confirm("Attention : cela va supprimer vos clés de chiffrement actuelles. Vos anciens messages deviendront illisibles. Continuer ?")) {
      if (user) {
        localStorage.removeItem(`wlm_priv_${user.id}`);
        localStorage.removeItem(`wlm_pub_${user.id}`);
        localStorage.removeItem(`wlm_keys_${user.id}`);
      }
      window.location.reload();
    }
  };

  /**
   * DÉCONNEXION
   */
  const handleLogout = (reason?: string) => {
    if (reason) console.warn("[Session] Déconnexion forcée:", reason); 
    localStorage.removeItem('wlm_user'); 
    localStorage.removeItem('wlm_open_chats');
    localStorage.removeItem('wlm_active_chat');
    // On force le rechargement de la page pour vider TOUTE la mémoire vive (clés E2E, messages, contacts)
    // et s'assurer qu'il n'y a aucune fuite d'état entre deux comptes.
    window.location.reload(); 
  };

  /**
   * DÉCHIFFREMENT D'UN TABLEAU DE MESSAGES
   */
  const decryptMessageArray = async (msgs: any[], privateKey: any) => {
    const results = [];
    for (const m of msgs) {
      let decryptedText = m.text;
      let decryptedAudio = m.audio;

      try {
        const potentialJson = JSON.parse(m.text);
        if (potentialJson && (potentialJson.keyReceiver || potentialJson.keySender)) {
           const isSender = m.sender_id === user?.id || m.senderId === user?.id;
           const payload = await decryptMessagePayload(potentialJson, privateKey, isSender);
           if (payload) {
             decryptedText = payload.text;
             if (payload.audio) decryptedAudio = payload.audio;
             if (payload.style) m.style = payload.style;
           }
           else decryptedText = "[!] Message illisible (E2E)";
        }
      } catch(e) { /* Pas du JSON chiffré */ }

      // Normalisation pour l'affichage (Conversion des noms de champs serveur -> frontend)
      const formattedTime = m.timestamp 
        ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        : (m.time || '');

      results.push({ 
        ...m, 
        text: decryptedText, 
        audio: decryptedAudio,
        sender: m.sender || m.sender_name || 'Contact',
        time: formattedTime
      });
    }
    return results;
  };

  /**
   * LANCER UN APPEL (AUDIO OU VIDÉO)
   */
  const handleStartCall = (audioOnly: boolean) => {
    if (!activeChatId || !user) return;
    setIsAudioOnly(audioOnly);
    setActiveCallId(activeChatId);
    setIsReceivingCall(false);
    setCallSignal(null);
  };

  const handleEndCall = () => {
    setActiveCallId(null);
    setIsReceivingCall(false);
    setCallSignal(null);
  };

  /**
   * GESTION DES DISCUSSIONS OUVERTES
   */
  const openChat = async (id: number) => {
    if (!openChatIds.includes(id)) {
      setOpenChatIds(prev => [...prev, id]);

      // Chargement de l'historique local (IndexedDB) - DÉCHIFFRÉ
      try {
        const keys = myKeysRef.current;
        if (keys) {
          let localHistory = await LocalDB.getMessages(`${user?.id}_${id}`, keys.privateKeyJwk);
          
          if (localHistory.length > 0) {
            // On déchiffre aussi la couche E2EE interne des messages chargés localement
            localHistory = await decryptMessageArray(localHistory, keys.privateKeyJwk);
            setMessages(prev => ({ ...prev, [id]: localHistory }));
          } else {
            // Si rien en local, on tente de charger depuis le serveur
            const res = await axios.get(`/api/messages/${user?.id}/${id}`);
            const serverMsgs = await decryptMessageArray(res.data, keys.privateKeyJwk);
            setMessages(prev => ({ ...prev, [id]: serverMsgs }));

            // On sauvegarde aussi l'historique serveur en local (chiffré) pour la prochaine fois
            for (const m of res.data) {
              await LocalDB.saveMessage(`${user?.id}_${id}`, m, keys.publicKeyJwk);
            }
          }
        }
      } catch (err) {
        console.error("Erreur chargement historique local:", err);
      }

      // Synchronisation automatique du mode privé si actif en local
      if ((globalPrivateMode || isPrivateMode[id]) && socket) {
        socket.emit('toggle_private_mode', {
          senderId: user?.id,
          receiverId: id,
          isPrivate: true,
          senderNickname: myNickname
        });
      }
    }
    setActiveChatId(id);
  };
  const closeChat = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    const newIds = openChatIds.filter(cid => cid !== id);
    setOpenChatIds(newIds);
    if (activeChatId === id) {
      setActiveChatId(newIds.length > 0 ? newIds[0] : 0);
    }
  };

  /**
   * GESTION DES CONTACTS (Blocage, Suppression)
   */
  const handleBlockContact = async (contactId: number, block: boolean) => {
    if (!user) return;
    try {
      await axios.post('/api/contacts/block', { userId: user.id, contactId, block });
      refreshData();
      setContextMenu(null);
    } catch (err) { 
      console.error("Erreur lors du blocage/déblocage:", err); 
    }
  };

  const handleDeleteContact = async (contactId: number) => {
    if (!user) return;
    if (!window.confirm("Voulez-vous vraiment supprimer ce contact ?")) return;
    try {
      await axios.post('/api/contacts/delete', { userId: user.id, contactId });
      refreshData();
      setContextMenu(null);
      if (activeChatId === contactId) setActiveChatId(0);
      setOpenChatIds(prev => prev.filter(id => id !== contactId));
    } catch (err) {
      console.error("Erreur lors de la suppression du contact:", err);
    }
  };

  const handleClearHistory = async (contactId: number) => {
    if (!user) return;
    if (!window.confirm("Voulez-vous vraiment effacer TOUT l'historique de discussion avec ce contact (Local et Serveur) ? Cette action est irréversible.")) return;

    try {
      // 1. Supprimer sur le serveur
      await axios.post('/api/messages/clear', { userId: user.id, contactId });

      // 2. Supprimer en local (IndexedDB)
      await LocalDB.clearHistory(`${user.id}_${contactId}`);

      // 3. Mettre à jour l'état React
      setMessages(prev => {
        const next = { ...prev };
        delete next[contactId];
        return next;
      });

      setContextMenu(null);
      alert("Historique effacé avec succès.");
    } catch (err) {
      console.error("Erreur lors de la suppression de l'historique:", err);
      alert("Une erreur est survenue lors de la suppression de l'historique.");
    }
  };

  const handleContextMenu = (e: React.MouseEvent, contactId: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, contactId });
  };

  useEffect(() => {
    const hideMenu = () => setContextMenu(null);
    window.addEventListener('click', hideMenu);
    return () => window.removeEventListener('click', hideMenu);
  }, []);

  /**
   * GESTION DES INVITATIONS
   */
  const handleInvite = async () => {
    if (!contactEmail.trim()) return;
    try {
      await axios.post('/api/invite', { senderId: user?.id, receiverUsername: contactEmail });
      alert('Invitation envoyée !');
      setShowAddContactModal(false);
      setContactEmail('');
    } catch (err: any) { 
      alert(err.response?.data?.error || 'Erreur lors de l\'envoi de l\'invitation.'); 
    }
  };

  const handleAcceptInvite = async (invitationId: number) => {
    try {
      await axios.post('/api/accept-invite', { invitationId, userId: user?.id });
      refreshData();
    } catch (err) { 
      console.error("Erreur acceptation invitation:", err); 
    }
  };

  const handleDeclineInvite = async (invitationId: number) => {
    try {
      await axios.post('/api/decline-invite', { invitationId });
      refreshData();
    } catch (err) { 
      console.error("Erreur refus invitation:", err); 
    }
  };

  /**
   * RENDU DU CONTENU DES MESSAGES (Gestion des émoticônes)
   */
  const renderMessageContent = (text: string, style: any) => {
    if (!text) return null;
    
    let parts: (string | React.ReactNode)[] = [text];
    
    // On trie les raccourcis par longueur décroissante pour éviter les conflits (ex: :) avant :)) )
    const sortedShortcuts = Object.keys(EMOTICON_MAP).sort((a, b) => b.length - a.length);
    
    sortedShortcuts.forEach(shortcut => {
      const newParts: (string | React.ReactNode)[] = [];
      parts.forEach(part => {
        if (typeof part === 'string') {
          const split = part.split(shortcut);
          split.forEach((s, i) => {
            if (s !== '') newParts.push(s);
            if (i < split.length - 1) {
              newParts.push(
                <img 
                  key={`${shortcut}-${i}`} 
                  src={`/assets/emoticons/${EMOTICON_MAP[shortcut]}`} 
                  className="inline-emoticon" 
                  alt={shortcut} 
                />
              );
            }
          });
        } else {
          newParts.push(part);
        }
      });
      parts = newParts;
    });

    const s = style || { family: 'Segoe UI', weight: 'normal', style: 'normal', color: '#333', size: '10' };
    
    return (
      <div 
        className="msg-content" 
        style={{ 
          fontFamily: s.family, 
          fontWeight: s.weight, 
          fontStyle: s.style, 
          color: s.color, 
          fontSize: `${s.size}pt`, 
          textDecoration: `${s.underline ? 'underline' : ''} ${s.strikeout ? 'line-through' : ''}`.trim(), 
          whiteSpace: 'pre-wrap' 
        }}
      >
        {parts}
      </div>
    );
  };

  /**
   * RENDU DU COMPOSANT
   */

  // Redirection vers l'authentification si aucun utilisateur n'est connecté
  if (!user) return <Auth onLogin={setUser} />;

  // Détermination du contact actif pour l'affichage de la discussion
  const activeContact = contacts.find(c => c.id === activeChatId) || { 
    id: 0, 
    username: '',
    nickname: 'Contact...', 
    status: 'offline', 
    psm: 'Hors ligne', 
    avatar: '/assets/usertiles/guest.png', 
    scene: '/assets/scenes/0006.png', 
    blocked: 0 
  };

  // Filtrage des contacts pour la liste (En ligne / Hors ligne / Recherche)
  const onlineContacts = Array.isArray(contacts) ? contacts.filter(c => 
    Number(c.blocked) === 0 && 
    (c.status || 'online') !== 'offline' && 
    (c.nickname || c.username || '').toLowerCase().includes(searchQuery.toLowerCase())
  ) : [];

  const offlineContacts = Array.isArray(contacts) ? contacts.filter(c => 
    (Number(c.blocked) === 1 || (c.status || 'online') === 'offline') && 
    (c.nickname || c.username || '').toLowerCase().includes(searchQuery.toLowerCase())
  ) : [];

  return (
    <div className={`wlm-desktop ${activeChatId !== 0 ? 'chat-open' : ''} ${isNudging ? 'wlm-nudge' : ''}`}>
      {/* Affichage d'un Wink (Clin d'œil) si actif */}
      {activeWink && <WinkPlayer key={`${activeWink}-${winkCounter}`} winkId={activeWink} onFinish={handleWinkFinish} />}
      
      {/* --- BARRE LATÉRALE (LISTE DE CONTACTS) --- */}
      <div className="wlm-side contact-list-window" onClick={() => setShowStatusMenu(false)}>
        
        {/* Logo et Branding */}
        <div className="wlm-branding">
          <div className="msn-butterfly"></div>
          <div className="wlm-logo-text">Open<span>WLM</span></div>
        </div>

        {/* En-tête Profil (Avatar, Nom, PSM) */}
        <div className="wlm-header-main">
          <div className="header-scene" style={{ backgroundImage: `url(${myScene})` }}></div>
          <div className="folded-corner" onClick={() => setShowSceneModal(true)} title="Changer le décor"></div>
          
          <div className="header-content-inner">
            <div className={`wlm-avatar-glass ${myStatus}`} onClick={() => setShowAvatarModal(true)} style={{ cursor: 'pointer', position: 'relative' }}>
              <img src={myAvatar} alt="Avatar" />
              {globalPrivateMode && (
                <div className="padlock-badge" title="Mode Privé Global Activé" style={{ bottom: '-2px', right: '-2px' }}>🔒</div>
              )}
            </div>
            
            <div className="user-info-text">
              <div className="user-name-status">
                {isEditingNickname ? (
                  <input 
                    className="user-name-input" 
                    value={myNickname} 
                    autoFocus 
                    onChange={e => setMyNickname(e.target.value)} 
                    onBlur={() => { setIsEditingNickname(false); syncProfile({ nickname: myNickname }); }} 
                    onKeyDown={e => e.key === 'Enter' && (setIsEditingNickname(false), syncProfile({ nickname: myNickname }))} 
                  />
                ) : (
                  <span className="nickname-display" onClick={() => setIsEditingNickname(true)} title="Cliquer pour modifier">{myNickname}</span>
                )}
                
                <span className="status-trigger" onClick={(e) => { e.stopPropagation(); setShowStatusMenu(!showStatusMenu); }}>
                  <span className="status-label">({STATUS_OPTIONS.find(o => o.id === myStatus)?.label}) ▼</span>
                </span>

                {/* Menu déroulant de Statut et Options */}
                {showStatusMenu && (
                  <div className="wlm-status-dropdown">
                    {STATUS_OPTIONS.map(opt => (
                      <div key={opt.id} className="dropdown-item" onClick={() => { setMyStatus(opt.id); setShowStatusMenu(false); syncProfile({ status: opt.id }); }}>
                        <div className={`status-icon-box ${opt.id}`}></div>{opt.label}
                      </div>
                    ))}
                    <div className="dropdown-item separator"></div>
                    <div className="dropdown-item" onClick={() => { 
                      const newGlobal = !globalPrivateMode;
                      setGlobalPrivateMode(newGlobal); 
                      setShowStatusMenu(false); 
                      axios.post('/api/user/global-private', { userId: user?.id, globalPrivate: newGlobal }).catch(console.error);
                      if (socket && openChatIds.length > 0) {
                        openChatIds.forEach(id => {
                          socket.emit('toggle_private_mode', {
                            senderId: user?.id,
                            receiverId: id,
                            isPrivate: newGlobal || !!isPrivateMode[id],
                            senderNickname: myNickname
                          });
                        });
                      }
                    }}>
                      {globalPrivateMode ? 'Désactiver le Mode Privé Global' : 'Activer le Mode Privé Global'}
                    </div>
                    <div className="dropdown-item" onClick={() => { setShowOptionsModal(true); setShowStatusMenu(false); }}>Options...</div>
                    <div className="dropdown-item" onClick={() => handleLogout()}>Se déconnecter</div>
                    <div className="dropdown-item separator"></div>
                    <div className="dropdown-item" onClick={() => { setShowAvatarModal(true); setShowStatusMenu(false); }}>Modifier votre image perso...</div>
                    <div className="dropdown-item" onClick={() => { setShowSceneModal(true); setShowStatusMenu(false); }}>Modifier un décor...</div>
                    <div className="dropdown-item" onClick={() => { setIsEditingNickname(true); setShowStatusMenu(false); }}>Modifier votre surnom...</div>
                    <div className="dropdown-item" onClick={() => { setShowPasswordModal(true); setShowStatusMenu(false); }}>Changer de mot de passe...</div>
                    <div className="dropdown-item" onClick={handleResetE2EKeys} style={{color:'red'}}>Réinitialiser les clés E2E...</div>
                  </div>
                )}
              </div>

              {/* Message Personnel (PSM) */}
              {isEditingPSM ? (
                <input 
                  className="user-psm-input" 
                  value={myPSM} 
                  autoFocus 
                  onChange={e => setMyPSM(e.target.value)} 
                  onBlur={() => { setIsEditingPSM(false); syncProfile({ psm: myPSM }); }} 
                  onKeyDown={e => e.key === 'Enter' && (setIsEditingPSM(false), syncProfile({ psm: myPSM }))} 
                />
              ) : (
                <div className="user-psm-display" onClick={() => setIsEditingPSM(true)} title="Cliquer pour modifier">
                  {myPSM || 'Entrez votre message perso'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Barre d'actions rapides (Recherche, Ajout contact) */}
        <div className="wlm-actions-bar">
          <div className="search-wrapper">
            <input type="text" placeholder="Rechercher des contacts..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <i className="search-magnifier">🔍</i>
          </div>
          <div className="actions-icons-right">
            <span onClick={() => setShowAddContactModal(true)} style={{cursor:'pointer'}} title="Ajouter un contact">👤+</span> 
            <span title="Organisation">▤</span> 
            <span title="Messages">✉️</span>
          </div>
        </div>

        {/* Liste des Contacts (Roster) */}
        <div className="contact-roster">
          {/* Invitations en attente */}
          {pendingInvites.length > 0 && (
            <div className="pending-section">
               <div className="group-header">Invitations en attente ({pendingInvites.length})</div>
               {pendingInvites.map(invite => (
                 <div key={invite.id} className="contact-row pending">
                    <div className="status-square offline"></div>
                    <div className="contact-name-txt" style={{flex: 1, marginLeft: '10px'}}>{invite.nickname || invite.username}</div>
                    <div style={{display:'flex', gap:'5px', marginRight: '10px'}}>
                      <button className="win-btn mini" onClick={() => handleAcceptInvite(invite.id)}>Accepter</button>
                      <button className="win-btn mini secondary" onClick={() => handleDeclineInvite(invite.id)}>Refuser</button>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {/* Contacts en ligne */}
          <div className="group-header" onClick={() => setIsGroupOpen(!isGroupOpen)}>
            <span style={{ transform: isGroupOpen ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
            En ligne ({onlineContacts.length})
          </div>
          {isGroupOpen && onlineContacts.map(contact => (
            <div 
              key={contact.id} 
              className={`contact-row ${activeChatId === contact.id ? 'active' : ''}`} 
              onClick={() => openChat(contact.id)} 
              onContextMenu={(e) => handleContextMenu(e, contact.id)}
            >
              <div className={`status-square ${contact.status || 'online'}`}></div>
              <div className="contact-name-txt">
                {contact.nickname || contact.username} 
                {contact.psm && <span className="contact-psm-txt"> - {contact.psm}</span>}
              </div>
            </div>
          ))}

          {/* Contacts hors ligne ou bloqués */}
          <div className="group-header" onClick={() => setIsOfflineGroupOpen(!isOfflineGroupOpen)}>
            <span style={{ transform: isOfflineGroupOpen ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
            Hors ligne ({offlineContacts.length})
          </div>
          {isOfflineGroupOpen && offlineContacts.map(contact => (
            <div 
              key={contact.id} 
              className={`contact-row ${activeChatId === contact.id ? 'active' : ''}`} 
              onClick={() => openChat(contact.id)} 
              onContextMenu={(e) => handleContextMenu(e, contact.id)}
            >
              <div className={`status-square offline`}></div>
              <div className="contact-name-txt" style={{color: contact.blocked ? '#f44336' : '#999'}}>
                {contact.nickname || contact.username} 
                {contact.psm && <span className="contact-psm-txt"> - {contact.psm}</span>} 
                {contact.blocked ? <span style={{fontSize:'10px', marginLeft: '5px'}}>(Bloqué)</span> : ''}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* --- FENÊTRE DE CONVERSATION --- */}
      <div className={`conversation-window ${isNudging ? 'wlm-nudge' : ''}`}>
        {activeChatId === 0 ? (
          /* État vide si aucune discussion n'est sélectionnée */
          <div className="empty-chat-state">
            <div className="msn-butterfly giant"></div>
            <div className="welcome-text">Prêt pour une conversation ?</div>
            <div className="sub-welcome">Sélectionnez un contact dans la liste à gauche pour commencer à chatter.</div>
          </div>
        ) : (
          <>
            {/* Barre d'onglets pour les discussions ouvertes */}
            <div className="chat-tabs-bar">
              <div className="mobile-back-btn" onClick={() => setActiveChatId(0)}>◀</div>
              {openChatIds.map(id => {
                const contact = contacts.find(c => c.id === id);
                return (
                  <div 
                    key={id} 
                    className={`chat-tab status-${contact?.status || 'online'} ${activeChatId === id ? 'active' : ''}`} 
                    onClick={() => setActiveChatId(id)}
                  >
                    <span className="tab-name">{contact?.nickname || contact?.username || 'Discussion'}</span>
                    <span className="chat-tab-close" onClick={(e) => closeChat(e, id)}>✕</span>
                  </div>
                );
              })}
            </div>

            {/* Barre d'actions du chat (Haut) */}
            <div className="chat-top-actions">
              <span>Fichiers</span>
              <span onClick={() => setShowBgModal(true)} style={{cursor:'pointer'}}>Arrière-plan</span>
              <span onClick={() => handleStartCall(false)} style={{cursor:'pointer'}}>Vidéo</span>
              <span onClick={() => handleStartCall(true)} style={{cursor:'pointer'}}>Appeler</span>
              <span>Jeux</span>
              <span>Activités</span>

              <span
                onClick={() => {
                  if (globalPrivateMode) {
                    alert("Le mode privé global est activé. Désactivez-le dans le menu principal pour gérer individuellement.");
                  } else {
                    togglePrivateMode(activeChatId);
                  }
                }}
                style={{ cursor: 'pointer', fontWeight: (globalPrivateMode || isPrivateMode[activeChatId]) ? 'bold' : 'normal', color: (globalPrivateMode || isPrivateMode[activeChatId]) ? '#00FF00' : 'inherit' }}
                title="Les messages envoyés dans ce mode ne sont pas enregistrés sur le serveur."
              >
                Mode Privé
              </span>
              </div>

            {/* Zone principale de discussion */}
            <div className="chat-main-area" style={convBg ? { backgroundImage: `url(/assets/backgrounds/${convBg})`, backgroundSize: 'cover' } : {}}>
               
               {/* En-tête de la discussion (Avatar & PSM du contact) */}
               <div className="conv-header-area" style={{ backgroundImage: `url(${activeContact.scene})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                  <div className="conv-header-overlay"></div>
                  <div className="conv-header-content" style={{ display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                     <div className={`conv-avatar-box ${activeContact.status || 'online'}`} style={{ position: 'relative' }}>
                       <img src={activeContact.avatar} alt="Avatar" />
                       {(globalPrivateMode || isPrivateMode[activeChatId]) && (
                         <div className="padlock-badge" title="Mode Privé Activé">🔒</div>
                       )}
                     </div>
                     <div className="conv-info">
                        <div className="conv-name">
                          {activeContact.nickname || activeContact.username} 
                          <span style={{fontSize:'12px', fontWeight:'normal', marginLeft: '10px'}}>
                            ({(activeContact.status === 'offline' || !activeContact.id) ? 'Hors ligne' : 'En ligne'})
                          </span>
                        </div>
                        <div className="conv-psm">{activeContact.psm || (activeContact.status === 'offline' ? '' : 'En ligne')}</div>
                     </div>
                  </div>
               </div>

               {/* Historique des messages (Scrollable) */}
               <div className="chat-log-scroll">
                  {(messages[activeChatId] || []).map((m, i) => (
                    <div key={i} className="msg-line">
                       {m.sender === 'Système' ? (
                         <div className="msg-system">{m.text}</div>
                       ) : (
                         <>
                           <div className={`msg-name ${m.sender === myNickname ? 'me' : ''}`}>{m.sender} dit :</div>
                           {m.audio ? <VoiceClipPlayer src={m.audio} /> : renderMessageContent(m.text, m.style)}
                         </>
                       )}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
               </div>

               {/* Pied de page (Saisie du message) */}
               <div className="chat-footer">
                  <div className="chat-input-bubble">
                     <textarea 
                        className="chat-textarea" 
                        style={{ 
                          fontFamily: fontSettings.family, 
                          fontWeight: fontSettings.weight, 
                          fontStyle: fontSettings.style, 
                          color: fontSettings.color, 
                          fontSize: `${fontSettings.size}pt`, 
                          textDecoration: `${fontSettings.underline ? 'underline' : ''} ${fontSettings.strikeout ? 'line-through' : ''}`.trim() 
                        }} 
                        value={inputText} 
                        onChange={e => setInputText(e.target.value)} 
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSendMessage())} 
                        placeholder="Saisissez un message..." 
                     />
                     
                     {/* Barre d'outils du chat (Émoticônes, Winks, Wizz, Voice) */}
                     <div className="chat-toolbar" style={{ position: 'relative' }}>
                        <span className="tool-icon" title="Émoticônes" onClick={() => setShowEmoticonMenu(!showEmoticonMenu)}>
                          <img src="/assets/icons/emoticon_official.svg" style={{width:'32px', cursor:'pointer'}} alt="Emoticônes" />
                        </span>
                        
                        {showEmoticonMenu && (
                          <div className="emoticon-popup">
                            <div className="emoticon-popup-header">
                              <span>Vos émoticônes</span>
                              <span className="tout-afficher" onClick={() => { setShowAllEmoticonsModal(true); setShowEmoticonMenu(false); }}>Tout afficher...</span>
                            </div>
                            <div className="emoticon-section">
                              <div className="emoticon-section-title">Émoticônes affichées</div>
                              <div className="emoticon-grid">
                                {EMOTICONS_LIST.slice(0, 15).map((emo, idx) => (
                                  <div key={idx} className="emoticon-item" title={emo.shortcut} onClick={() => { setInputText(prev => prev + emo.shortcut); setShowEmoticonMenu(false); }}>
                                    <img src={`/assets/emoticons/${emo.file}`} alt={emo.shortcut} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        <span className="tool-icon" title="Clins d'œil" onClick={() => setShowWinksModal(true)}>
                          <img src="/assets/icons/wink_official.svg" style={{width:'32px', cursor:'pointer'}} alt="Winks" />
                        </span>
                        
                        <span className="tool-icon" title="Wizz!" onClick={() => handleNudge(false)}>
                          <img src="/assets/icons/wizz_reconstructed.svg" style={{width:'36px', cursor:'pointer'}} alt="Wizz" />
                        </span>
                        
                        <span className={`tool-icon ${isRecording ? 'recording' : ''}`} title={isRecording ? "Arrêter et envoyer" : "Clip vocal"} onClick={handleVoiceClip}>
                          <img src="/assets/icons/voice_clip_official.svg" style={{width:'32px', cursor:'pointer'}} alt="Voice Clip" />
                        </span>
                        
                        {isRecording && (
                          <span className="tool-icon" title="Annuler l'enregistrement" onClick={handleCancelVoiceClip} style={{ color: 'red', fontWeight: 'bold', fontSize: '20px' }}>✕</span>
                        )}
                        
                        <span className="tool-icon" title="Police" style={{ fontSize: '14px', fontWeight: 'bold', color: '#004b8d', cursor:'pointer' }} onClick={() => setShowFontModal(true)}>A/B</span>
                     </div>
                  </div>
               </div>
            </div>
          </>
        )}
      </div>

      {/* --- MODALES --- */}

      {/* Modale: Toutes les émoticônes */}
      {showAllEmoticonsModal && (
        <div className="modal-bg" onClick={() => setShowAllEmoticonsModal(false)}>
          <div className="modal-box emoticons-all-modal" onClick={e => e.stopPropagation()} style={{ width: '400px' }}>
            <div className="win-modal-header"><span>Toutes les émoticônes</span><button className="win-close-btn" onClick={() => setShowAllEmoticonsModal(false)}>✕</button></div>
            <div className="emoticon-all-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '10px', maxHeight: '300px', overflowY: 'auto', padding: '10px' }}>
              {EMOTICONS_LIST.map((emo, idx) => (
                <div key={idx} className="emoticon-item-large" title={emo.shortcut} onClick={() => { setInputText(prev => prev + emo.shortcut); setShowAllEmoticonsModal(false); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                  <img src={`/assets/emoticons/${emo.file}`} alt={emo.shortcut} style={{ width: '19px', height: '19px' }} />
                  <span style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>{emo.shortcut}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: '20px', textAlign: 'right' }}><button className="win-btn" onClick={() => setShowAllEmoticonsModal(false)}>Fermer</button></div>
          </div>
        </div>
      )}

      {/* Modale: Choix du décor (Scène) */}
      {showSceneModal && (
        <div className="modal-bg" onClick={() => setShowSceneModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>Modifier votre décor</span><button className="win-close-btn" onClick={() => setShowSceneModal(false)}>✕</button></div>
            <div className="scene-grid">
              {SCENES.map(s => (
                <div key={s.id} className="scene-thumb" onClick={() => { setMyScene(`/assets/scenes/${s.file}`); setShowSceneModal(false); syncProfile({ scene: `/assets/scenes/${s.file}` }); }}>
                  <img src={`/assets/scenes/${s.file}`} alt={s.name} />
                  <div className="scene-name">{s.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modale: Ajouter un contact */}
      {showAddContactModal && (
        <div className="modal-bg" onClick={() => setShowAddContactModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: '400px' }}>
            <div className="win-modal-header"><span>Ajouter un contact</span><button className="win-close-btn" onClick={() => setShowAddContactModal(false)}>✕</button></div>
            <div className="auth-field" style={{ padding: '20px' }}>
              <label>Adresse de messagerie du contact :</label>
              <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="exemple@hotmail.com" style={{ width: '100%', marginTop: '5px' }} />
            </div>
            <div style={{ marginTop: '20px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '0 20px 20px' }}>
              <button className="win-btn" onClick={handleInvite}>OK</button>
              <button className="win-btn" onClick={() => setShowAddContactModal(false)}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Modifier l'arrière-plan de la discussion */}
      {showBgModal && (
        <div className="modal-bg" onClick={() => setShowBgModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>Modifier l'arrière-plan</span><button className="win-close-btn" onClick={() => setShowBgModal(false)}>✕</button></div>
            <div className="scene-grid">
              {CONV_BACKGROUNDS.map(bg => (
                <div key={bg.id} className="scene-thumb" onClick={() => { setConvBg(bg.file); setShowBgModal(false); }}>
                  {bg.file ? <img src={`/assets/backgrounds/${bg.file}`} alt={bg.name} /> : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f0f0' }}>Aucun</div>}
                  <div className="scene-name">{bg.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modale: Choisir une image perso (Avatar) */}
      {showAvatarModal && (
        <div className="modal-bg" onClick={() => setShowAvatarModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>Choisir une image perso</span><button className="win-close-btn" onClick={() => setShowAvatarModal(false)}>✕</button></div>
            <div className="scene-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {USERTILES.map(tile => (
                <div key={tile} className="scene-thumb" style={{ height: '60px' }} onClick={() => { setMyAvatar(`/assets/usertiles/${tile}`); setShowAvatarModal(false); syncProfile({ avatar: `/assets/usertiles/${tile}` }); }}>
                  <img src={`/assets/usertiles/${tile}`} alt="Avatar" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modale: Paramètres de la police (Style Windows Classique) */}
      {showFontModal && (
        <div className="modal-bg" onClick={() => setShowFontModal(false)}>
          <div className="modal-box font-modal win-style-modal" onClick={e => e.stopPropagation()} style={{ width: '550px' }}>
            <div className="win-modal-header"><span>Modifier la police</span><button className="win-close-btn" onClick={() => setShowFontModal(false)}>✕</button></div>
            <div className="win-modal-body">
              <div className="win-font-grid">
                <div className="win-field-col">
                  <label>Police:</label>
                  <input type="text" readOnly value={fontSettings.family} className="win-input-preview" />
                  <div className="win-list-box">
                    {['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Comic Sans MS', 'Courier New', 'Times New Roman'].map(f => (
                      <div key={f} className={`win-list-item ${fontSettings.family === f ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, family: f})}>{f}</div>
                    ))}
                  </div>
                </div>
                <div className="win-field-col">
                  <label>Style de police:</label>
                  <input type="text" readOnly value={fontSettings.weight === 'bold' ? (fontSettings.style === 'italic' ? 'Gras Italique' : 'Gras') : (fontSettings.style === 'italic' ? 'Italique' : 'Normal')} className="win-input-preview" />
                  <div className="win-list-box">
                    <div className={`win-list-item ${fontSettings.weight === 'normal' && fontSettings.style === 'normal' ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, weight: 'normal', style: 'normal'})}>Normal</div>
                    <div className={`win-list-item ${fontSettings.style === 'italic' && fontSettings.weight === 'normal' ? 'selected' : ''}`} style={{ fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, style: 'italic', weight: 'normal'})}>Italique</div>
                    <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'normal' ? 'selected' : ''}`} style={{ fontWeight: 'bold' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'normal'})}>Gras</div>
                    <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'italic' ? 'selected' : ''}`} style={{ fontWeight: 'bold', fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'italic'})}>Gras Italique</div>
                  </div>
                </div>
                <div className="win-field-col">
                  <label>Taille:</label>
                  <input type="text" readOnly value={fontSettings.size} className="win-input-preview" style={{width: '60px'}} />
                  <div className="win-list-box" style={{width: '80px'}}>
                    {['8', '9', '10', '11', '12', '14', '16', '18', '20'].map(s => (
                      <div key={s} className={`win-list-item ${fontSettings.size === s ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, size: s})}>{s}</div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="win-lower-grid">
                <div className="win-effects-group">
                  <fieldset>
                    <legend>Effets</legend>
                    <label className="win-checkbox"><input type="checkbox" checked={fontSettings.strikeout} onChange={e => setFontSettings({...fontSettings, strikeout: e.target.checked})} /> Barré</label>
                    <label className="win-checkbox"><input type="checkbox" checked={fontSettings.underline} onChange={e => setFontSettings({...fontSettings, underline: e.target.checked})} /> Souligné</label>
                    <div style={{ marginTop: '10px' }}>
                      <label>Couleur:</label>
                      <div className="wlm-color-picker-container" style={{ position: 'relative' }}>
                        <div 
                          className="wlm-color-picker-selected" 
                          onClick={() => setShowColorDropdown(!showColorDropdown)}
                          style={{ display: 'flex', alignItems: 'center', background: 'white', border: '1px solid #abadb3', padding: '2px', cursor: 'pointer', fontSize: '11px', justifyContent: 'space-between' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <div className="color-box" style={{ backgroundColor: fontSettings.color, width: '12px', height: '12px', border: '1px solid #000' }}></div>
                            <span>{WLM_COLORS.find(c => c.hex === fontSettings.color)?.name || 'Couleur'}</span>
                          </div>
                          <span className="dropdown-arrow" style={{ fontSize: '8px', paddingRight: '2px' }}>▼</span>
                        </div>
                        {showColorDropdown && (
                          <div className="wlm-color-dropdown" style={{ position: 'absolute', top: '100%', left: 0, width: '100%', background: 'white', border: '1px solid #abadb3', maxHeight: '150px', overflowY: 'auto', zIndex: 100 }}>
                            {WLM_COLORS.map(color => (
                              <div 
                                key={color.hex} 
                                className="wlm-color-option"
                                onClick={() => {
                                  setFontSettings({...fontSettings, color: color.hex});
                                  setShowColorDropdown(false);
                                }}
                                style={{ display: 'flex', alignItems: 'center', padding: '2px 5px', cursor: 'pointer', gap: '5px', fontSize: '11px', background: fontSettings.color === color.hex ? '#0078d7' : 'transparent', color: fontSettings.color === color.hex ? 'white' : 'black' }}
                              >
                                <div className="color-box" style={{ backgroundColor: color.hex, width: '12px', height: '12px', border: '1px solid #000' }}></div>
                                <span>{color.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </fieldset>
                </div>
                <div className="win-sample-group">
                  <fieldset>
                    <legend>Aperçu</legend>
                    <div className="win-sample-box">
                      <span style={{ 
                        fontFamily: fontSettings.family, 
                        fontWeight: fontSettings.weight, 
                        fontStyle: fontSettings.style, 
                        color: fontSettings.color, 
                        fontSize: `${fontSettings.size}pt`, 
                        textDecoration: `${fontSettings.underline ? 'underline' : ''} ${fontSettings.strikeout ? 'line-through' : ''}`.trim() 
                      }}>AaBbYyZz</span>
                    </div>
                  </fieldset>
                </div>
              </div>
              <div className="win-modal-footer">
                <button className="win-btn" onClick={() => setShowFontModal(false)}>OK</button>
                <button className="win-btn" onClick={() => setShowFontModal(false)}>Annuler</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Choix d'un Clin d'œil (Wink) */}
      {showWinksModal && (
        <div className="modal-bg" onClick={() => setShowWinksModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>Choisir un Clin d'œil (Wink)</span><button className="win-close-btn" onClick={() => setShowWinksModal(false)}>✕</button></div>
            <div className="scene-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', padding: '20px' }}>
              {WINKS.map(w => (
                <div key={w.id} className="scene-thumb" style={{ height: '80px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }} onClick={() => handleSendWink(w.id)}>
                   <img src={`/assets/winks/${w.id}/${w.id}.png`} alt={w.name} style={{ height: '40px', width: 'auto', marginBottom: '5px' }} />
                  <div className="scene-name" style={{ fontSize: '9px', position: 'static', background: 'transparent' }}>{w.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modale: Changement de mot de passe */}
      {showPasswordModal && (
        <div className="modal-bg" onClick={() => setShowPasswordModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: '300px' }}>
            <div className="win-modal-header"><span>Changer le mot de passe</span><button className="win-close-btn" onClick={() => setShowPasswordModal(false)}>✕</button></div>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '20px' }}>
              <input id="old-password" type="password" placeholder="Ancien mot de passe" required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
              <input id="new-password" type="password" placeholder="Nouveau mot de passe" required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
              <button type="submit" className="win-btn" style={{ marginTop: '10px' }}>Valider</button>
            </form>
          </div>
        </div>
      )}

      {/* Interface d'appel Audio/Vidéo */}
      {activeCallId && (
        <VideoCall 
          socket={socket} 
          activeChatId={activeCallId} 
          myId={user?.id || 0} 
          contactName={contacts.find(c => c.id === activeCallId)?.nickname || 'Contact'} 
          callerName={myNickname || user?.username || 'Utilisateur'}
          isReceivingCall={isReceivingCall} 
          incomingSignal={callSignal} 
          audioOnly={isAudioOnly}
          iceCandidatesBuffer={iceCandidatesBuffer}
          onEndCall={handleEndCall}
        />
      )}

      {/* Modale: Options (Style MSN classique) */}
      {showOptionsModal && (
        <div className="modal-bg">
          <div className="modal-box wlm-options-modal" style={{ width: '550px' }}>
            <div className="win-modal-header">
              <span>Options</span>
              <button className="win-close-btn" onClick={() => setShowOptionsModal(false)}>✕</button>
            </div>
            
            <div className="options-body">
              <div className="options-sidebar">
                <div className="options-nav-item active">Personnel</div>
                <div className="options-nav-item">Disposition</div>
                <div className="options-nav-item">Messages</div>
                <div className="options-nav-item">Alertes</div>
                <div className="options-nav-item">Sons</div>
                <div className="options-nav-item">Sécurité</div>
                <div className="options-nav-item">Connexion</div>
              </div>
              
              <div className="options-content">
                <div className="options-section">
                  <div className="options-title">Personnel</div>
                  
                  <div className="options-subsection">
                    <label className="options-label">Surnom</label>
                    <div className="options-hint">Tapez le surnom sous lequel vous souhaitez apparaître :</div>
                    <input 
                      className="win-input" 
                      value={myNickname} 
                      onChange={e => setMyNickname(e.target.value)} 
                      style={{ width: '90%' }} 
                    />
                  </div>

                  <div className="options-subsection">
                    <div className="options-hint">Tapez le message perso sous lequel vous souhaitez apparaître :</div>
                    <input 
                      className="win-input" 
                      value={myPSM} 
                      onChange={e => setMyPSM(e.target.value)} 
                      style={{ width: '90%' }} 
                    />
                  </div>

                  <div className="options-subsection">
                    <label className="options-label">Statut</label>
                    <div className="options-checkbox-line">
                      <input 
                        type="checkbox" 
                        id="check-away" 
                        checked={enableAutoAway} 
                        onChange={e => {
                          setEnableAutoAway(e.target.checked);
                          localStorage.setItem('wlm_enable_auto_away', e.target.checked.toString());
                        }} 
                      />
                      <label htmlFor="check-away">Afficher le statut "Absent" après </label>
                      <input 
                        type="number" 
                        className="win-input-small" 
                        value={awayTimeout} 
                        onChange={e => {
                          const val = parseInt(e.target.value) || 1;
                          setAwayTimeout(val);
                          localStorage.setItem('wlm_away_timeout', val.toString());
                        }} 
                        style={{ width: '40px', textAlign: 'center', margin: '0 5px' }} 
                      />
                      <span> minutes d'inactivité</span>
                    </div>
                  </div>

                  <div className="options-subsection">
                    <label className="options-label">Webcam</label>
                    <div className="options-checkbox-line">
                      <input type="checkbox" id="check-webcam" defaultChecked />
                      <label htmlFor="check-webcam">Indiquer aux autres utilisateurs que je dispose d'une webcam</label>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="win-modal-footer">
              <button className="win-btn" onClick={() => { syncProfile({ nickname: myNickname, psm: myPSM }); setShowOptionsModal(false); }}>OK</button>
              <button className="win-btn" onClick={() => setShowOptionsModal(false)}>Annuler</button>
              <button className="win-btn" onClick={() => syncProfile({ nickname: myNickname, psm: myPSM })}>Appliquer</button>
            </div>
          </div>
        </div>
      )}

      {/* Menu Contextuel (Clic droit sur un contact) */}
      {contextMenu && (
        <div className="wlm-status-dropdown" style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 10000 }}>
          <div className="dropdown-item" onClick={() => openChat(contextMenu.contactId)}>Envoyer un message instantané</div>
          <div className="dropdown-item" onClick={() => handleClearHistory(contextMenu.contactId)}>Effacer l'historique de conversation</div>
          <div className="dropdown-item separator"></div>
          <div className="dropdown-item" onClick={() => handleDeleteContact(contextMenu.contactId)}>Supprimer</div>
          {contacts.find(c => c.id === contextMenu.contactId)?.blocked ? (
            <div className="dropdown-item" onClick={() => handleBlockContact(contextMenu.contactId, false)}>Débloquer</div>
          ) : (
            <div className="dropdown-item" onClick={() => handleBlockContact(contextMenu.contactId, true)}>Bloquer</div>
          )}
        </div>
      )}
    </div>
  );
};

export default App;
