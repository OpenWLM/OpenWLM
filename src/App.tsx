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
  decryptPrivateKeyVault,
  deriveZeroKnowledgeKeys,
  encryptFileBinary,
  decryptCustomEmoticon
} from './utils/Security';
import WinkPlayer from './components/WinkPlayer';
import VideoCall from './components/VideoCall';
import FileTransferCard, { type FileDataPayload, isImageFile } from './components/FileTransferCard';
import MorpionGame from './components/MorpionGame';
import CheckersGame from './components/CheckersGame';
import Puissance4Game from './components/Puissance4Game';
import CustomEmoticonsModal from './components/CustomEmoticonsModal';
import CustomEmoticonsDB, { type MyEmoticonRecord } from './utils/CustomEmoticonsDB';
import { onInstallAvailabilityChange, promptPWAInstall } from './pwa';
import { useI18n } from './i18n';
import { formatNickname } from './utils/NicknameFormatter';

/**
 * INTERFACES
 */

export interface CustomEmoticonPayload {
  assetId: string;
  key: string;       // Clé AES-GCM 256 en base64
  mime: string;      // image/png, image/gif, etc.
  width?: number;
  height?: number;
  animated?: number | boolean;
}

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
  isBot?: boolean;
}

export const SYSTEM_BOT_ID = -1;
export const SYSTEM_BOT_CONTACT: Contact = {
  id: SYSTEM_BOT_ID,
  username: 'openwlm',
  nickname: 'OpenWLM',
  psm: 'En ligne pour vos tests',
  status: 'online',
  avatar: '/assets/usertiles/robot.png',
  scene: '/assets/scenes/0002.png',
  blocked: 0,
  isBot: true
};

interface Message {
  id?: number | string;
  sender_id?: number;
  receiver_id?: number;
  senderId?: number;
  receiverId?: number;
  sender: string;
  text: string;
  time?: string;
  timestamp?: string | number;
  style?: any;
  audio?: string | null;
  type?: string;
  isWink?: boolean;
  _isPending?: boolean;
  clientMsgId?: string;
  fileData?: FileDataPayload;
  customEmoticons?: Record<string, CustomEmoticonPayload>;
}


const formatMessageTime = (rawTimestamp: string | number | undefined, fallbackTime?: string): string => {
  if (!rawTimestamp) return fallbackTime || '';
  try {
    let dateStr = String(rawTimestamp).trim();
    if (!dateStr.includes('T') && dateStr.includes(' ')) {
      dateStr = dateStr.replace(' ', 'T') + 'Z';
    } else if (dateStr.includes('T') && !dateStr.endsWith('Z')) {
      dateStr += 'Z';
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return fallbackTime || '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return fallbackTime || '';
  }
};

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
  ':)': 'regular_smile.png',
  ':-)': 'regular_smile.png',
  ':D': 'teeth_smile.png',
  ':-D': 'teeth_smile.png',
  ';)': 'wink_smile.png',
  ';-)': 'wink_smile.png',
  ':O': 'omg_smile.png',
  ':-O': 'omg_smile.png',
  ':P': 'tongue_smile.png',
  ':-P': 'tongue_smile.png',
  '(H)': 'shades_smile.png',
  ':@': 'angry_smile.png',
  ':-@': 'angry_smile.png',
  ':S': 'confused_smile.png',
  ':-S': 'confused_smile.png',
  ':$': 'red_smile.png',
  ':-$': 'red_smile.png',
  ':(': 'sad_smile.png',
  ':-(': 'sad_smile.png',
  ":'(": 'cry_smile.png',
  ':|': 'what_smile.png',
  ':-|': 'what_smile.png',
  '(A)': 'angel_smile.png',
  '8o|': 'angry.png',
  '8-|': 'glasses_happy.png',
  '+o(': 'sick.png',
  '<:o)': 'party.png',
  '|-)': 'Sleepy.png',
  '*-)': 'thinking.png',
  ':-#': 'shutup.png',
  ':-*': 'kiss.png',
  '^o)': 'eye-rolling.png',
  '8-)': 'glasses_happy.png',
  '(L)': 'heart.png',
  '(U)': 'broken_heart.png',
  '(M)': 'messenger.png',
  '(@)': 'cat.png',
  '(&)': 'dog.png',
  '(sn)': 'escargot.png',
  '(bah)': 'sheep.png',
  '(S)': 'moon.png',
  '(*)': 'star.png',
  '(#)': 'idk.png',
  '(R)': 'rose.png',
  '({)': 'guy_hug.png',
  '(})': 'girl_hug.png',
  '(K)': 'kiss.png',
  '(F)': 'rose.png',
  '(W)': 'wilted_rose.png',
  '(O)': 'clock.png',
  '(ip)': 'airplane.png',
  '(b)': 'beer_mug.png',
  '(d)': 'bowl.png',
  '(c)': 'coffee.png',
  '(co)': 'computer.png',
  '(e)': 'envelope.png',
  '(f)': 'film.png',
  '(g)': 'present.png',
  '(i)': 'lightbulb.png',
  '(l)': 'Lightning.png',
  '(m)': 'mobile.png',
  '(n)': 'note.png',
  '(p)': 'phone.png',
  '(pi)': 'pizza.png',
  '(pl)': 'plate.png',
  '(r)': 'rain.png',
  '(u)': 'umbrella.png',
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
  const { t } = useI18n();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [src]);

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
    <div className="wlm-voice-clip-player" onClick={togglePlay} title={t.chat.voiceClipClickToListen}>
      <div className={`play-pause-icon ${isPlaying ? 'pause' : 'play'}`}></div>
      <div className="voice-clip-info">
        <span className="voice-clip-text">{isPlaying ? t.chat.voiceClipPlaying : t.chat.voiceClipPlay}</span>
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
  const { t, language, setLanguage } = useI18n();

  const getStatusLabel = (id: string) => {
    switch (id) {
      case 'online': return t.status.online;
      case 'busy': return t.status.busy;
      case 'away': return t.status.away;
      case 'offline': return t.status.offline;
      default: return id;
    }
  };

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

  // --- SUPPORT PWA (INSTALLATION) ---
  const [canInstallPWA, setCanInstallPWA] = useState(false);
  useEffect(() => {
    const unsub = onInstallAvailabilityChange(setCanInstallPWA);
    return unsub;
  }, []);

  // --- ÉTAT DU PROFIL PERSONNEL ---
  const [myStatus, setMyStatus] = useState('online');
  const [myPSM, setMyPSM] = useState('Disponible');
  const [myNickname, setMyNickname] = useState('');
  const [myAvatar, setMyAvatar] = useState('/assets/usertiles/chess.png');
  const [myScene, setMyScene] = useState('/assets/scenes/0006.png');
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [isEditingPSM, setIsEditingPSM] = useState(false);

  // --- ÉTAT DE L'INACTIVITÉ (AUTO-AWAY) ---
  const [lastActivity, setLastActivity] = useState(() => Date.now());
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
  const [showCustomEmoticonsModal, setShowCustomEmoticonsModal] = useState(false);
  const [myCustomEmoticons, setMyCustomEmoticons] = useState<MyEmoticonRecord[]>([]);
  const [customEmoticonsMap, setCustomEmoticonsMap] = useState<Record<string, {
    assetId: string;
    url: string;
    shortcut: string;
    isAnimated?: number;
    width?: number;
    height?: number;
  }>>({});
  const myCustomShortcutsRef = useRef<Set<string>>(new Set());

  // --- ÉTAT DU COLLAGE DE CAPTURE D'ÉCRAN ---
  const [pastedImage, setPastedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const isSubmittingPasteRef = useRef(false);

  // --- RÉFÉRENCES ---
  const myStatusRef = useRef(myStatus);
  useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);
  
  

  /**
   * BASCULER LE MODE PRIVÉ (AVEC NOTIFICATION)
   */
  const togglePrivateMode = (chatId: number) => {
    if (chatId === SYSTEM_BOT_ID) {
      alert("La discussion avec OpenWLM est locale et n'est pas enregistrée sur le serveur.");
      return;
    }
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

      if (newUser.rememberMe) {
        localStorage.setItem('wlm_user', JSON.stringify(newUser));
      }
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

  // --- ÉTAT DES JEUX (ACTIVITÉS MSN : MORPION, DAMES & PUISSANCE 4) ---
  const [activeGame, setActiveGame] = useState<{
    opponentId: number;
    opponentName: string;
    mySymbol?: string;
    myColor?: 'white' | 'black' | 'red' | 'yellow';
    isMyTurn: boolean;
    gameType: string;
  } | null>(null);
  const [incomingGameInvite, setIncomingGameInvite] = useState<{
    from: number;
    fromName: string;
    gameType: string;
  } | null>(null);
  const [outgoingGameInvite, setOutgoingGameInvite] = useState<{
    target: number;
    targetName: string;
    gameType?: string;
  } | null>(null);
  const [showGamesMenu, setShowGamesMenu] = useState(false);
  const [isGameMinimized, setIsGameMinimized] = useState<boolean>(false);
  const [gameSummary, setGameSummary] = useState<{
    isMyTurn: boolean;
    myScore: number;
    opponentScore: number;
    winner: 'me' | 'opponent' | 'draw' | null;
  }>({
    isMyTurn: false,
    myScore: 0,
    opponentScore: 0,
    winner: null
  });

  // --- ÉTAT DES CONTACTS & MESSAGES ---
  const [contacts, setContacts] = useState<Contact[]>([]);
  const contactsRef = useRef<Contact[]>([]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  const isInitialContactsLoadRef = useRef(true);
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, contactId: number } | null>(null);
  const [messages, setMessages] = useState<Record<number, Message[]>>({});
  const [inputText, setInputText] = useState('');
  const [isGroupOpen, setIsGroupOpen] = useState(true);
  const [isOfflineGroupOpen, setIsOfflineGroupOpen] = useState(true);
  const [isServicesGroupOpen, setIsServicesGroupOpen] = useState(true);
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
  const loadingChatsRef = useRef<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contactEmail, setContactEmail] = useState('');

  // --- PURGE PROACTIVE DU STOCKAGE LOCAL (HYGIÈNE STRICTE) ---
  useEffect(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('wlm_priv_') || k.startsWith('wlm_keys_') || k.startsWith('wlm_pub_'))) {
          localStorage.removeItem(k);
        }
      }
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && (k.startsWith('wlm_priv_') || k.startsWith('wlm_keys_') || k.startsWith('wlm_pub_'))) {
          sessionStorage.removeItem(k);
        }
      }
    } catch (e) {
      console.warn("[Sécurité] Nettoyage stockage résiduel:", e);
    }
  }, []);

  /**
   * INITIALISATION ZERO-KNOWLEDGE LORS DE LA CONNEXION
   * 1. Reçoit loggedInUser et vaultKey (CryptoKey AES-GCM 256 bits non exportable).
   * 2. Si le coffre existe : déchiffre la clé privée RSA avec vaultKey.
   * 3. Si premier login : génère les clés RSA, chiffre la clé privée avec vaultKey et envoie le coffre au serveur.
   * 4. Stocke la clé privée RSA UNIQUEMENT en RAM (useState/useRef).
   */
  const handleUserLogin = async (loggedInUser: any, vaultKey: CryptoKey) => {
    if (loggedInUser.token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${loggedInUser.token}`;
    }

    try {
      let keys: { publicKeyJwk: any; privateKeyJwk: any } | null = null;

      if (loggedInUser.encrypted_private_key) {
        console.log("[Zero-Knowledge] Déchiffrement du coffre de clés privées...");
        const vault = typeof loggedInUser.encrypted_private_key === 'string'
          ? JSON.parse(loggedInUser.encrypted_private_key)
          : loggedInUser.encrypted_private_key;

        const privJwk = await decryptPrivateKeyVault(vault.encryptedKeyBase64, vault.ivBase64, vaultKey);
        if (!privJwk) {
          alert("Échec du déchiffrement du coffre de clés privées. Mot de passe incorrect ou coffre altéré.");
          return;
        }

        const pubJwk = typeof loggedInUser.public_key === 'string'
          ? JSON.parse(loggedInUser.public_key)
          : loggedInUser.public_key;

        keys = { publicKeyJwk: pubJwk, privateKeyJwk: privJwk };
      } else {
        console.log("[Zero-Knowledge] Génération de la première paire de clés RSA...");
        keys = await generateKeyPair();
        const vault = await encryptPrivateKeyVault(keys.privateKeyJwk, vaultKey);
        await axios.post('/api/user/keys', {
          userId: loggedInUser.id,
          publicKey: keys.publicKeyJwk,
          encryptedPrivateKey: vault
        });
        loggedInUser.public_key = keys.publicKeyJwk;
        loggedInUser.encrypted_private_key = vault;
      }

      setMyKeys(keys);
      setUser(loggedInUser);

      if (loggedInUser.rememberMe) {
        localStorage.setItem('wlm_user', JSON.stringify(loggedInUser));
      } else {
        localStorage.removeItem('wlm_user');
      }
    } catch (err) {
      console.error("[Zero-Knowledge] Erreur initialisation clés:", err);
      alert("Erreur lors de l'initialisation des clés de sécurité.");
    }
  };

  // --- GESTION DE LA SESSION UTILISATEUR ---
  useEffect(() => {
    const syncAndInit = async () => {
      if (!user || !myKeys) return;
      
      let currentUser = user;
      if (currentUser.token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${currentUser.token}`;
      }

      try {
        const res = await axios.get(`/api/user/me`);
        if (res.data && res.data.user) {
          currentUser = { ...user, ...res.data.user };
          setUser(currentUser);
          
          if (currentUser.global_private !== undefined) {
            setGlobalPrivateMode(currentUser.global_private === 1);
          }

          if (currentUser.rememberMe) {
            localStorage.setItem('wlm_user', JSON.stringify(currentUser));
          }
        }
      } catch (err) {
        console.warn("[Session] Impossible de synchroniser le profil:", err);
      }

      setMyNickname(currentUser.nickname || currentUser.username || 'Utilisateur');
      setMyPSM(currentUser.psm || 'Disponible');
      setMyAvatar(currentUser.avatar || '/assets/usertiles/chess.png');
      setMyScene(currentUser.scene || '/assets/scenes/0006.png');
      setMyStatus(currentUser.status || 'online');
    };

    syncAndInit();
  }, [user?.id, !!myKeys]);

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
   * ENREGISTREMENT ET DÉCHIFFREMENT ASYNCHRONE DES ÉMOTICÔNES PERSONNALISÉES REÇUES
   */
  const registerReceivedCustomEmoticons = useCallback(async (
    receivedMap: Record<string, CustomEmoticonPayload>
  ) => {
    if (!receivedMap || typeof receivedMap !== 'object') return;
    const token = user?.token || localStorage.getItem('token');

    for (const [shortcut, info] of Object.entries(receivedMap)) {
      if (!info || !info.assetId || !info.key) continue;

      // 1. Déjà en mémoire ?
      const existingUrl = CustomEmoticonsDB.getMemoryUrl(info.assetId);
      if (existingUrl) {
        setCustomEmoticonsMap(prev => {
          if (prev[shortcut]?.url === existingUrl) return prev;
          return {
            ...prev,
            [shortcut]: {
              assetId: info.assetId,
              url: existingUrl,
              shortcut,
              isAnimated: info.animated ? 1 : 0,
              width: info.width,
              height: info.height
            }
          };
        });
        continue;
      }

      // 2. Déjà dans le cache IndexedDB ?
      const cachedBlob = await CustomEmoticonsDB.getCachedAsset(info.assetId);
      if (cachedBlob) {
        const url = CustomEmoticonsDB.getOrCreateObjectUrl(info.assetId, cachedBlob);
        setCustomEmoticonsMap(prev => ({
          ...prev,
          [shortcut]: {
            assetId: info.assetId,
            url,
            shortcut,
            isAnimated: info.animated ? 1 : 0,
            width: info.width,
            height: info.height
          }
        }));
        continue;
      }

      // 3. Téléchargement de l'asset chiffré depuis le serveur (Zero-Knowledge) et déchiffrement local
      try {
        const res = await axios.get(`/api/emoticons/custom/asset/${info.assetId}`, {
          responseType: 'arraybuffer',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });

        if (res.data) {
          const decryptedBlob = await decryptCustomEmoticon(res.data, info.key, info.mime || 'image/png');
          if (decryptedBlob) {
            await CustomEmoticonsDB.saveCachedAsset(info.assetId, decryptedBlob, info.mime || 'image/png', info.key);
            const url = CustomEmoticonsDB.getOrCreateObjectUrl(info.assetId, decryptedBlob);
            setCustomEmoticonsMap(prev => ({
              ...prev,
              [shortcut]: {
                assetId: info.assetId,
                url,
                shortcut,
                isAnimated: info.animated ? 1 : 0,
                width: info.width,
                height: info.height
              }
            }));
          }
        }
      } catch (err) {
        console.warn("Échec téléchargement asset émoticône personnalisée:", info.assetId, err);
      }
    }
  }, [user?.token]);

  /**
   * CHARGEMENT ET SYNCHRONISATION DES ÉMOTICÔNES DU PROPRIÉTAIRE
   */
  const loadMyCustomEmoticons = useCallback(async () => {
    if (!user) return;
    try {
      await CustomEmoticonsDB.init();
      const localRecords = await CustomEmoticonsDB.getMyEmoticons();
      
      let serverRecords: any[] | null = null;
      const token = user.token || localStorage.getItem('token');
      if (token) {
        try {
          const res = await axios.get('/api/emoticons/custom/my', {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (res.data && res.data.success && Array.isArray(res.data.emoticons)) {
            serverRecords = res.data.emoticons;
          }
        } catch (err) {
          console.warn("Erreur chargement serveur émoticônes custom:", err);
        }
      }

      // Si la synchronisation serveur a réussi, purger localement les clés supprimées
      if (serverRecords !== null) {
        const serverIds = new Set(serverRecords.map(s => s.id));
        for (const local of localRecords) {
          if (!serverIds.has(local.id)) {
            await CustomEmoticonsDB.deleteMyEmoticon(local.id);
          }
        }
      }

      const merged: MyEmoticonRecord[] = [];
      const newMap: Record<string, { assetId: string; url: string; shortcut: string; isAnimated?: number; width?: number; height?: number }> = {};

      const listToProcess = serverRecords !== null ? serverRecords : localRecords;
      for (const item of listToProcess) {
        const local = localRecords.find(l => l.id === item.id);
        const keyBase64 = local?.keyBase64 || (item as any).keyBase64 || '';
        const record: MyEmoticonRecord = {
          id: item.id,
          shortcut: item.shortcut,
          keyBase64,
          mimeType: item.mime_type || item.mimeType || 'image/png',
          width: item.width || 0,
          height: item.height || 0,
          isAnimated: item.is_animated !== undefined ? item.is_animated : (item.isAnimated || 0),
          createdAt: item.created_at || item.createdAt || Date.now()
        };
        merged.push(record);

        let cachedBlob = await CustomEmoticonsDB.getCachedAsset(item.id);
        if (!cachedBlob && keyBase64 && token) {
          try {
            const assetRes = await axios.get(`/api/emoticons/custom/asset/${item.id}`, {
              responseType: 'arraybuffer',
              headers: { Authorization: `Bearer ${token}` }
            });
            if (assetRes.data) {
              const decrypted = await decryptCustomEmoticon(assetRes.data, keyBase64, record.mimeType);
              if (decrypted) {
                await CustomEmoticonsDB.saveCachedAsset(item.id, decrypted, record.mimeType, keyBase64);
                cachedBlob = decrypted;
              }
            }
          } catch (e) {
            // Ignorer silencieusement si non disponible
          }
        }

        if (cachedBlob) {
          const url = CustomEmoticonsDB.getOrCreateObjectUrl(item.id, cachedBlob);
          newMap[record.shortcut] = {
            assetId: record.id,
            url,
            shortcut: record.shortcut,
            isAnimated: record.isAnimated,
            width: record.width,
            height: record.height
          };
        }
      }

      setMyCustomEmoticons(merged);

      const newShortcutsSet = new Set(Object.keys(newMap));
      setCustomEmoticonsMap(prev => {
        const next = { ...prev };
        // Purger les anciens raccourcis du propriétaire qui n'existent plus
        for (const oldShortcut of myCustomShortcutsRef.current) {
          if (!newShortcutsSet.has(oldShortcut)) {
            delete next[oldShortcut];
          }
        }
        // Ajouter / mettre à jour les raccourcis actuels
        Object.assign(next, newMap);
        return next;
      });
      myCustomShortcutsRef.current = newShortcutsSet;
    } catch (err) {
      console.error("Erreur loadMyCustomEmoticons:", err);
    }
  }, [user]);

  const handleCustomEmoticonsChange = useCallback((deletedShortcut?: string) => {
    if (deletedShortcut) {
      myCustomShortcutsRef.current.delete(deletedShortcut);
      setCustomEmoticonsMap(prev => {
        if (!prev[deletedShortcut]) return prev;
        const next = { ...prev };
        delete next[deletedShortcut];
        return next;
      });
    }
    loadMyCustomEmoticons();
  }, [loadMyCustomEmoticons]);

  useEffect(() => {
    if (user?.id) {
      loadMyCustomEmoticons();
    }
  }, [user?.id, loadMyCustomEmoticons]);

  /**
   * DÉCHIFFREMENT D'UN TABLEAU DE MESSAGES
   */
  const decryptMessageArray = useCallback(async (msgs: any[], privateKey: any) => {
    const results: Message[] = [];
    for (const m of msgs) {
      let decryptedText = m.text;
      let decryptedAudio = m.audio;
      let decryptedStyle = m.style;
      let fileData: FileDataPayload | undefined = m.fileData;
      let payloadSender: string | undefined = undefined;

      try {
        const potentialJson = JSON.parse(m.text);
        if (potentialJson && (potentialJson.keyReceiver || potentialJson.keySender)) {
           const isSender = m.sender_id === user?.id || m.senderId === user?.id;
           const payload = await decryptMessagePayload<any>(potentialJson, privateKey, isSender);
           if (payload) {
             if (payload.type === 'file' && payload.fileId) {
               decryptedText = `[Fichier] ${payload.fileName || 'Fichier partagé'}`;
               fileData = payload;
             } else {
               decryptedText = payload.text;
             }
             if (payload.sender) payloadSender = payload.sender;
             if (payload.audio) decryptedAudio = payload.audio;
             if (payload.style) decryptedStyle = payload.style;
             if (payload.customEmoticons) {
               registerReceivedCustomEmoticons(payload.customEmoticons);
             }
           } else {
             decryptedText = "[!] Message illisible (E2E)";
           }
        }
      } catch { /* Pas du JSON chiffré */ }

      const isSender = m.sender_id === user?.id || m.senderId === user?.id;
      const formattedTime = formatMessageTime(m.timestamp, m.time);
      const contactObj = contactsRef.current.find(c => c.id === (m.sender_id || m.senderId));
      const contactResolvedName = contactObj ? (contactObj.nickname || contactObj.username) : null;

      const finalSender = isSender
        ? (myNickname || user?.nickname || user?.username || 'Moi')
        : (contactResolvedName || payloadSender || m.sender_name || (m.sender && m.sender !== 'Contact' ? m.sender : null) || 'Contact');

      results.push({ 
        ...m, 
        id: m.id,
        sender_id: m.sender_id || m.senderId,
        senderId: m.sender_id || m.senderId,
        receiver_id: m.receiver_id || m.receiverId,
        receiverId: m.receiver_id || m.receiverId,
        text: decryptedText, 
        audio: decryptedAudio,
        style: decryptedStyle ? (typeof decryptedStyle === 'string' ? JSON.parse(decryptedStyle) : decryptedStyle) : null,
        sender: finalSender,
        time: formattedTime,
        timestamp: m.timestamp,
        fileData: fileData
      });
    }
    return results;
  }, [user?.id, user?.nickname, user?.username, myNickname]);

  /**
   * CHARGEMENT DE L'HISTORIQUE D'UNE CONVERSATION (UNIFIÉ SANS DOUBLON)
   */
  const loadChatHistory = useCallback(async (chatId: number) => {
    const keys = myKeysRef.current;
    if (!user || chatId === 0) return;

    // L'Assistant OpenWLM est un service 100% local (hors réseau et hors BDD)
    if (chatId === SYSTEM_BOT_ID) {
      setMessages(prev => {
        if (prev[SYSTEM_BOT_ID] && prev[SYSTEM_BOT_ID].length > 0) return prev;
        const welcomeMsg: Message = {
          senderId: SYSTEM_BOT_ID,
          receiverId: user.id,
          sender: 'OpenWLM',
          text: "Bonjour ! Vous pouvez envoyer un message pour tester l'écho, ou utiliser les boutons ci-dessous pour tester les sons, le Wizz, les émoticônes et le Morpion.",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: new Date().toISOString()
        };
        return { ...prev, [SYSTEM_BOT_ID]: [welcomeMsg] };
      });
      return;
    }

    if (!keys) return;
    if (loadingChatsRef.current.has(chatId)) return;
    loadingChatsRef.current.add(chatId);

    try {
      // 1. Préchargement du cache local rapide (IndexedDB)
      try {
        const cached = await LocalDB.getMessages<Message>(`${user.id}_${chatId}`, keys.privateKeyJwk);
        if (cached && cached.length > 0) {
          const decryptedCached = await decryptMessageArray(cached, keys.privateKeyJwk);
          setMessages(prev => {
            if (!prev[chatId] || prev[chatId].length === 0) {
              return { ...prev, [chatId]: decryptedCached };
            }
            return prev;
          });
        }
      } catch (err) {
        console.warn("Erreur lecture cache local:", err);
      }

      // 2. Synchronisation avec l'historique officiel du serveur (source de vérité)
      try {
        const res = await axios.get(`/api/messages/${user.id}/${chatId}`);
        if (Array.isArray(res.data)) {
          const serverMsgs = await decryptMessageArray(res.data, keys.privateKeyJwk);
          const validServerMsgs = serverMsgs.filter(m => m.text !== "[!] Message illisible (E2E)");

          setMessages(prev => {
            const currentMsgs = prev[chatId] || [];
            const serverIds = new Set(validServerMsgs.map(m => m.id).filter(Boolean));
            const serverClientIds = new Set(validServerMsgs.map(m => m.clientMsgId).filter(Boolean));
            const pendingMsgs = currentMsgs.filter(m => 
              m._isPending && 
              (!m.id || !serverIds.has(m.id)) && 
              (!m.clientMsgId || !serverClientIds.has(m.clientMsgId))
            );
            return { ...prev, [chatId]: [...validServerMsgs, ...pendingMsgs] };
          });

          // Remplacer le cache local avec l'historique officiel propre
          await LocalDB.setHistory(`${user.id}_${chatId}`, validServerMsgs, keys.publicKeyJwk);
        }
      } catch (err) {
        console.warn(`Erreur récupération messages serveur pour ${chatId}:`, err);
      }
    } catch (err) {
      console.error(`Erreur chargement historique pour ${chatId}:`, err);
    } finally {
      loadingChatsRef.current.delete(chatId);
    }
  }, [user, decryptMessageArray]);

  /**
   * CHARGEMENT AUTOMATIQUE DE L'HISTORIQUE AU DÉMARRAGE (POUR LES ONGLETS OUVERTS)
   */
  useEffect(() => {
    if (user && myKeys && openChatIds.length > 0) {
      openChatIds.forEach(id => {
        loadChatHistory(id);
      });
    }
  }, [user, !!myKeys, JSON.stringify(openChatIds), loadChatHistory]);

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
        const senderId = data.senderId || data.sender_id;
        const isSender = senderId === user.id;
        let decryptedData = { ...data };
        let fileData = data.fileData;
        let payloadSender: string | undefined = undefined;

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
              const payload = await decryptMessagePayload<any>(parsedE2e, currentKeys.privateKeyJwk, isSender);
              if (payload) {
                 decryptedData = { ...data, ...payload };
                 if (payload.type === 'file' && payload.fileId) {
                   fileData = payload;
                   decryptedData.text = `[Fichier] ${payload.fileName || 'Fichier partagé'}`;
                 }
                 if (payload.sender) payloadSender = payload.sender;
                 if (payload.customEmoticons) {
                   registerReceivedCustomEmoticons(payload.customEmoticons);
                 }
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

        // Résolution précise du nom réel de l'expéditeur (Carnet de contacts > Payload E2EE > Socket Server)
        const contactFromList = contactsRef.current.find(c => c.id === senderId);
        const contactResolvedName = contactFromList ? (contactFromList.nickname || contactFromList.username) : null;
        const finalSenderName = isSender
          ? (myNickname || user?.nickname || user?.username || 'Moi')
          : (contactResolvedName || payloadSender || decryptedData.sender || data.sender || data.sender_name || 'Contact');

        // Mise à jour de l'interface
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        setActiveChatId(prev => prev === 0 ? senderId : prev);

        const formattedTime = formatMessageTime(decryptedData.timestamp, decryptedData.time);
        const finalMsg: Message = { 
          ...decryptedData, 
          id: decryptedData.id,
          sender_id: senderId,
          senderId: senderId,
          receiver_id: user?.id,
          receiverId: user?.id,
          sender: finalSenderName,
          time: formattedTime,
          timestamp: decryptedData.timestamp || new Date().toISOString(),
          fileData: fileData || (decryptedData.type === 'file' && decryptedData.fileId ? decryptedData : undefined)
        };

        setMessages(prev => {
          const currentMsgs = prev[senderId] || [];
          if (finalMsg.id && currentMsgs.some(m => m.id === finalMsg.id)) {
            return prev;
          }
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
        const contactId = Number(data.userId ?? data.id);
        if (!contactId) return;

        // Ne pas jouer le son pour la session de l'utilisateur connecté lui-même
        if (contactId === user?.id) {
          if (data.status) setMyStatus(data.status);
          return;
        }

        setContacts(prev => {
          const prevContact = prev.find(c => c.id === contactId);
          if (prevContact) {
            const isNowOnline = data.status && data.status !== 'offline';
            const wasOffline = prevContact.status === 'offline';
            if (isNowOnline && wasOffline) {
              console.log(`[Audio] Contact connecté (${prevContact.nickname || prevContact.username}) -> online.mp3`);
              SoundManager.play('ONLINE');
            }
            if (data.global_private !== undefined) {
               prevContact.global_private = data.global_private;
            }
          }
          return prev.map(c => c.id === contactId ? { ...c, ...data, id: contactId } : c);
        });
      });

      // Invitation acceptée
      newSocket.on('contact_accepted', () => {
        refreshData();
      });

      // --- ÉVÉNEMENTS JEUX & ACTIVITÉS MSN (MORPION) ---
      newSocket.on('game_invite_received', (data: { from: number; fromName: string; gameType: string }) => {
        setIncomingGameInvite(data);
        try { SoundManager.play('ONLINE'); } catch {}
      });

      newSocket.on('game_started', (data: { opponentId: number; opponentName: string; mySymbol?: string; myColor?: 'white' | 'black' | 'red' | 'yellow'; isMyTurn: boolean; gameType: string }) => {
        setIncomingGameInvite(null);
        setOutgoingGameInvite(null);
        setActiveGame(data);
        setIsGameMinimized(false);
        setGameSummary({
          isMyTurn: data.isMyTurn,
          myScore: 0,
          opponentScore: 0,
          winner: null
        });
      });

      newSocket.on('game_declined', (data: { from: number; fromName: string }) => {
        setOutgoingGameInvite(null);
        alert(`${data.fromName} a décliné l'invitation à jouer.`);
      });

      newSocket.on('game_user_offline', () => {
        setOutgoingGameInvite(null);
        alert("Ce contact n'est pas en ligne pour jouer actuellement.");
      });

      setSocket(newSocket);
      return () => { newSocket.disconnect(); };
    }
  }, [user?.id]);

  /**
   * CHARGEMENT DE L'HISTORIQUE DU CHAT ACTIF SI NON CHARGÉ
   */
  useEffect(() => {
    if (user && myKeys && activeChatId !== 0 && (!messages[activeChatId] || messages[activeChatId].length === 0)) {
      loadChatHistory(activeChatId);
    }
  }, [activeChatId, user, !!myKeys, loadChatHistory]);

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
        if (!isInitialContactsLoadRef.current) {
          // Détection d'un contact qui vient de se connecter lors d'une synchronisation périodique
          resContacts.data.forEach((newC: any) => {
            const oldC = contactsRef.current.find(c => c.id === newC.id);
            if (oldC && oldC.status === 'offline' && newC.status && newC.status !== 'offline') {
              console.log(`[Audio] Contact ${newC.nickname || newC.username} devenu en ligne via refreshData -> online.mp3`);
              SoundManager.play('ONLINE');
            }
          });
        } else {
          isInitialContactsLoadRef.current = false;
        }

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

    // --- INTERCEPTION DE L'ASSISTANT OPENWLM (TESTS LOCAUX 100% CLIENT) ---
    if (activeChatId === SYSTEM_BOT_ID) {
      const userText = sanitize(inputText);
      const nowIso = new Date().toISOString();
      const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const userMsg: Message = {
        senderId: user?.id,
        receiverId: SYSTEM_BOT_ID,
        sender: myNickname || user?.nickname || 'Moi',
        text: userText,
        style: { ...fontSettings },
        time: formattedTime,
        timestamp: nowIso
      };

      setMessages(prev => ({
        ...prev,
        [SYSTEM_BOT_ID]: [...(prev[SYSTEM_BOT_ID] || []), userMsg]
      }));
      setInputText('');

      const lower = userText.trim().toLowerCase();
      if (lower === '/help' || lower === '/?' || lower === 'aide') {
        handleAssistantAction('help');
        return;
      }
      if (lower === '/wizz') {
        handleNudge(false);
        return;
      }
      if (lower === '/sons' || lower === '/sound' || lower === '/audio') {
        handleAssistantAction('sons');
        return;
      }
      if (lower === '/emo' || lower === '/emoticones' || lower === '/emojis') {
        handleAssistantAction('emo');
        return;
      }
      if (lower === '/morpion' || lower === '/game' || lower === '/jeu') {
        handleAssistantAction('morpion');
        return;
      }
      if (lower === '/p4' || lower === '/puissance4' || lower === '/connect4') {
        handleAssistantAction('puissance4');
        return;
      }

      // Écho normal
      setTimeout(() => {
        try { SoundManager.play('NEW_MESSAGE'); } catch {}

        let echoNotice = `Écho : ${userText}`;
        const hasCustomEmo = myCustomEmoticons.some(e => userText.includes(e.shortcut));
        if (hasCustomEmo) {
          echoNotice += " (émoticône personnalisée reçue)";
        }

        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user?.id,
              sender: 'OpenWLM',
              text: echoNotice,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: new Date().toISOString()
            }
          ]
        }));
      }, 400);
      return;
    }

    if (!socket) { console.error("Socket non prêt"); return; }
    if (!myKeys) { console.error("Clés E2E non prêtes"); return; }
    
    // On récupère la clé publique du destinataire pour le chiffrement E2E
    const contactPubKey = await getPublicKey(activeChatId);
    if (!contactPubKey) {
      alert("Ce contact doit se connecter au moins une fois pour activer la discussion sécurisée.");
      return;
    }

    try {
      // Détecter les émoticônes personnalisées utilisées dans le message (Moindre privilège V1)
      const customEmoticonsToSend: Record<string, CustomEmoticonPayload> = {};
      for (const emo of myCustomEmoticons) {
        if (emo.keyBase64 && inputText.includes(emo.shortcut)) {
          customEmoticonsToSend[emo.shortcut] = {
            assetId: emo.id,
            key: emo.keyBase64,
            mime: emo.mimeType,
            width: emo.width,
            height: emo.height,
            animated: emo.isAnimated
          };
        }
      }

      const unencryptedPayload: any = { 
        text: sanitize(inputText), 
        sender: myNickname, 
        style: { ...fontSettings }, 
        type: 'text' 
      };

      if (Object.keys(customEmoticonsToSend).length > 0) {
        unencryptedPayload.customEmoticons = customEmoticonsToSend;
      }
      
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
      
      const clientMsgId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const nowIso = new Date().toISOString();
      const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Ajout local immédiat pour la fluidité (optimistic UI)
      const myLocalMsg: Message = { 
        ...unencryptedPayload, 
        id: clientMsgId,
        clientMsgId,
        senderId: user?.id,
        sender_id: user?.id,
        receiverId: activeChatId,
        receiver_id: activeChatId,
        sender: myNickname || user?.nickname || 'Moi', 
        time: formattedTime,
        timestamp: nowIso,
        _isPending: true,
        customEmoticons: Object.keys(customEmoticonsToSend).length > 0 ? customEmoticonsToSend : undefined
      };

      setMessages(prev => ({ 
        ...prev, 
        [activeChatId]: [...(prev[activeChatId] || []), myLocalMsg] 
      }));

      setInputText('');

      socket.emit('send_message', msgData, (ack?: { success?: boolean, id?: number | string, timestamp?: string }) => {
        if (ack?.id) {
          myLocalMsg.id = ack.id;
          myLocalMsg._isPending = false;
          if (ack.timestamp) myLocalMsg.timestamp = ack.timestamp;

          setMessages(prev => {
            const currentMsgs = prev[activeChatId] || [];
            return {
              ...prev,
              [activeChatId]: currentMsgs.map(m => m.clientMsgId === clientMsgId ? { ...m, id: ack.id, _isPending: false, timestamp: ack.timestamp || m.timestamp } : m)
            };
          });

          if (myKeysRef.current) {
            LocalDB.saveMessage(`${user?.id}_${activeChatId}`, myLocalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
          }
        }
      });

    } catch (e) {
      console.error("Échec du chiffrement:", e);
      alert("Erreur lors du chiffrement du message.");
    }
  };

  /**
   * ENVOI D'UN FICHIER CHIFFRÉ DE BOUT EN BOUT (E2EE)
   * Fichier chiffré stocké sur le serveur, accessible pendant 4H maximum via URL + Token
   * Déchiffré localement dans le navigateur du destinataire avec sa clé privée RSA
   */
  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 o';
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  };

  const getExtensionForMime = (mime: string): string => {
    const mimeLower = (mime || '').toLowerCase();
    if (mimeLower === 'image/png') return 'png';
    if (mimeLower === 'image/jpeg' || mimeLower === 'image/jpg') return 'jpg';
    if (mimeLower === 'image/webp') return 'webp';
    if (mimeLower === 'image/gif') return 'gif';
    if (mimeLower === 'image/bmp') return 'bmp';
    if (mimeLower === 'image/svg+xml') return 'svg';
    if (mimeLower === 'image/tiff') return 'tiff';
    const parts = mimeLower.split('/');
    return parts[1] ? parts[1].replace('+xml', '') : 'png';
  };

  /**
   * ENVOI D'UN FICHIER CHIFFRÉ DE BOUT EN BOUT (E2EE)
   * Chiffré localement avec AES-256-GCM + enveloppe RSA-OAEP
   * Réutilisé pour le sélecteur de fichier et le collage direct de captures d'écran
   */
  const sendFile = useCallback(async (file: File): Promise<void> => {
    if (!file) return;
    if (!socket) { alert("Connexion au serveur non établie."); return; }
    if (!myKeys) { alert("Clés E2E non prêtes."); return; }
    if (!activeChatId) { alert("Veuillez sélectionner un contact."); return; }
    if (activeChatId === SYSTEM_BOT_ID) {
      alert("OpenWLM est un contact de test. Pour envoyer des fichiers, sélectionnez un contact réel.");
      return;
    }

    const MAX_SIZE = 100 * 1024 * 1024; // 100 Mo max
    if (file.size > MAX_SIZE) {
      alert("Le fichier dépasse la taille maximale autorisée (100 Mo).");
      return;
    }

    const contactPubKey = await getPublicKey(activeChatId);
    if (!contactPubKey) {
      alert("Ce contact doit se connecter au moins une fois pour activer le transfert sécurisé.");
      return;
    }

    try {
      // 1. Lire le fichier sous forme binaire
      const fileBuffer = await file.arrayBuffer();

      // 2. Chiffrer le fichier avec AES-GCM 256 bits et envelopper la clé AES avec RSA-OAEP
      const { encryptedBlob, fileKeys } = await encryptFileBinary(fileBuffer, contactPubKey, myKeys.publicKeyJwk);

      // 3. Téléverser le blob chiffré sur le serveur (Zero-Knowledge)
      const formData = new FormData();
      formData.append('file', encryptedBlob, file.name);
      formData.append('receiverId', activeChatId.toString());
      formData.append('originalName', file.name);
      formData.append('fileType', file.type || 'application/octet-stream');

      const res = await axios.post('/api/files/upload', formData, {
        headers: {
          Authorization: `Bearer ${user?.token}`,
          'Content-Type': 'multipart/form-data'
        }
      });

      if (!res.data.success) {
        throw new Error(res.data.error || "Erreur serveur lors de l'envoi du fichier.");
      }

      // 4. Préparer le payload E2EE contenant les métadonnées et clés de déchiffrement
      const senderDisplayName = myNickname || user?.nickname || user?.username || 'Moi';
      const filePayload: FileDataPayload = {
        type: 'file',
        fileId: res.data.fileId,
        token: res.data.token,
        downloadUrl: res.data.downloadUrl,
        expiresAt: res.data.expiresAt,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        fileKeys,
        sender: senderDisplayName,
        senderId: user?.id
      };

      const e2eData = await encryptMessagePayload(filePayload, contactPubKey, myKeys.publicKeyJwk);

      const msgData = {
        senderId: user?.id,
        receiverId: activeChatId,
        text: JSON.stringify(e2eData),
        style: null,
        audio: null,
        type: 'file',
        isPrivate: globalPrivateMode || !!isPrivateMode[activeChatId]
      };

      const clientMsgId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const nowIso = new Date().toISOString();
      const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const myLocalMsg: Message = {
        id: clientMsgId,
        clientMsgId,
        senderId: user?.id,
        sender_id: user?.id,
        receiverId: activeChatId,
        receiver_id: activeChatId,
        sender: senderDisplayName,
        text: `[Fichier] ${file.name}`,
        type: 'file',
        fileData: filePayload,
        time: formattedTime,
        timestamp: nowIso,
        _isPending: true
      };

      setMessages(prev => ({
        ...prev,
        [activeChatId]: [...(prev[activeChatId] || []), myLocalMsg]
      }));

      socket.emit('send_message', msgData, (ack?: { success?: boolean, id?: number | string, timestamp?: string }) => {
        if (ack?.id) {
          myLocalMsg.id = ack.id;
          myLocalMsg._isPending = false;
          if (ack.timestamp) myLocalMsg.timestamp = ack.timestamp;

          setMessages(prev => {
            const currentMsgs = prev[activeChatId] || [];
            return {
              ...prev,
              [activeChatId]: currentMsgs.map(m => m.clientMsgId === clientMsgId ? { ...m, id: ack.id, _isPending: false, timestamp: ack.timestamp || m.timestamp } : m)
            };
          });

          if (myKeysRef.current) {
            LocalDB.saveMessage(`${user?.id}_${activeChatId}`, myLocalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
          }
        }
      });
    } catch (err: unknown) {
      console.error("Erreur lors de l'envoi du fichier:", err);
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
      const serverError = axiosErr.response?.data?.error;
      if (axiosErr.response?.status === 413 || (serverError && /100\s*Mo|taille|large/i.test(serverError))) {
        alert("Échec de l'envoi : le fichier dépasse la taille maximale autorisée (100 Mo).");
      } else if (serverError) {
        alert(`Échec de l'envoi : ${serverError}`);
      } else if (axiosErr.message) {
        alert(`Échec de l'envoi : ${axiosErr.message}`);
      } else {
        alert("Une erreur est survenue lors du chiffrement ou de l'envoi du fichier.");
      }
    }
  }, [socket, myKeys, activeChatId, user, myNickname, globalPrivateMode, isPrivateMode]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await sendFile(file);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  /**
   * COLLAGE DIRECT DE CAPTURE D'ÉCRAN (CLIPBOARD SCREENSHOT)
   */
  const handleCancelPastedImage = useCallback(() => {
    setPastedImage(prev => {
      if (prev?.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return null;
    });
  }, []);

  const handleConfirmPastedImage = useCallback(async () => {
    if (!pastedImage || isSubmittingPasteRef.current) return;
    isSubmittingPasteRef.current = true;
    const { file, previewUrl } = pastedImage;
    URL.revokeObjectURL(previewUrl);
    setPastedImage(null);
    try {
      await sendFile(file);
    } finally {
      isSubmittingPasteRef.current = false;
    }
  }, [pastedImage, sendFile]);

  // Raccourcis clavier pour la modale de confirmation (Entrée = Valider, Échap = Annuler)
  useEffect(() => {
    if (!pastedImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelPastedImage();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleConfirmPastedImage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pastedImage, handleCancelPastedImage, handleConfirmPastedImage]);

  // Nettoyage de l'URL blob si changement de conversation ou démontage
  useEffect(() => {
    return () => {
      if (pastedImage?.previewUrl) {
        URL.revokeObjectURL(pastedImage.previewUrl);
      }
    };
  }, [pastedImage]);

  useEffect(() => {
    if (pastedImage) {
      if (pastedImage.previewUrl) URL.revokeObjectURL(pastedImage.previewUrl);
      setPastedImage(null);
    }
  }, [activeChatId]);

  // Gestionnaire de détection de collage (presse-papiers image vs texte)
  const handlePaste = useCallback((e: React.ClipboardEvent | ClipboardEvent) => {
    if (e.defaultPrevented) return;
    if (!activeChatId || activeChatId === SYSTEM_BOT_ID) return;

    // Si une autre modale est ouverte, ne pas intercepter
    if (
      showAddContactModal ||
      showSceneModal ||
      showAvatarModal ||
      showPasswordModal ||
      showBgModal ||
      showWinksModal ||
      showAllEmoticonsModal ||
      showCustomEmoticonsModal ||
      showFontModal ||
      showOptionsModal
    ) {
      return;
    }

    // Si l'utilisateur colle dans un autre champ texte que le chat (ex: recherche, email...)
    const activeEl = document.activeElement as HTMLElement | null;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') &&
      !activeEl.classList.contains('chat-textarea')
    ) {
      return;
    }

    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    let imageItem: DataTransferItem | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
        imageItem = items[i];
        break; // V1 : limiter à la première image trouvée
      }
    }

    // Si aucun élément image : NE PAS appeler preventDefault -> laisser le collage texte natif fonctionner
    if (!imageItem) return;

    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;

    const ext = getExtensionForMime(blob.type);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const rawName = blob.name || '';
    const isGenericName = !rawName || rawName === 'image.png' || rawName === 'blob' || rawName === 'screenshot.png';
    const fileName = isGenericName ? `capture_${timestampStr}.${ext}` : rawName;

    const file = new File([blob], fileName, { type: blob.type || 'image/png' });

    // Nettoyer l'ancienne preview éventuelle
    setPastedImage(prev => {
      if (prev?.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return null;
    });

    const previewUrl = URL.createObjectURL(file);
    setPastedImage({ file, previewUrl });
  }, [
    activeChatId,
    showAddContactModal,
    showSceneModal,
    showAvatarModal,
    showPasswordModal,
    showBgModal,
    showWinksModal,
    showAllEmoticonsModal,
    showCustomEmoticonsModal,
    showFontModal,
    showOptionsModal
  ]);

  // Écouter le collage au niveau global pour la fenêtre de discussion active
  useEffect(() => {
    if (!activeChatId) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      handlePaste(e);
    };
    window.addEventListener('paste', onWindowPaste);
    return () => {
      window.removeEventListener('paste', onWindowPaste);
    };
  }, [activeChatId, handlePaste]);

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
      if (activeChatId === SYSTEM_BOT_ID) {
        SoundManager.play('NUDGE');
        if (!isNudging) {
          setIsNudging(true);
          setTimeout(() => setIsNudging(false), 2000);
        }
        setMessages(prev => ({ 
          ...prev, 
          [SYSTEM_BOT_ID]: [...(prev[SYSTEM_BOT_ID] || []), { text: "Vous venez d'envoyer un Wizz !", sender: 'Système' }] 
        }));

        setTimeout(() => {
          SoundManager.play('NUDGE');
          setIsNudging(true);
          setTimeout(() => setIsNudging(false), 2000);
          setMessages(prev => ({ 
            ...prev, 
            [SYSTEM_BOT_ID]: [
              ...(prev[SYSTEM_BOT_ID] || []), 
              { text: "Vous venez de recevoir un Wizz !", sender: 'Système' },
              { 
                senderId: SYSTEM_BOT_ID,
                receiverId: user?.id,
                text: "Wizz bien reçu.", 
                sender: 'OpenWLM',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: new Date().toISOString()
              }
            ] 
          }));
        }, 1500);
        return;
      }

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
      if (mediaRecorder.stream) {
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
      }
      mediaRecorder.stop();
      setIsRecording(false);
      setMediaRecorder(null);
    }
  };

  const handleVoiceClip = async () => {
    if (activeChatId === SYSTEM_BOT_ID) {
      alert("Les clips vocaux sont réservés aux échanges avec des contacts réels.");
      return;
    }
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
          stream.getTracks().forEach(t => t.stop());
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

              const clientMsgId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
              const nowIso = new Date().toISOString();
              const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

              const myLocalMsg: Message = {
                ...unencryptedPayload,
                id: clientMsgId,
                clientMsgId,
                senderId: user?.id,
                sender_id: user?.id,
                receiverId: activeChatId,
                receiver_id: activeChatId,
                sender: myNickname || user?.nickname || 'Moi',
                time: formattedTime,
                timestamp: nowIso,
                _isPending: true
              };

              setMessages(prev => ({
                ...prev,
                [activeChatId]: [...(prev[activeChatId] || []), myLocalMsg]
              }));

              if (socket) {
                socket.emit('send_message', msgData, (ack?: { success?: boolean, id?: number | string, timestamp?: string }) => {
                  if (ack?.id) {
                    myLocalMsg.id = ack.id;
                    myLocalMsg._isPending = false;
                    if (ack.timestamp) myLocalMsg.timestamp = ack.timestamp;

                    setMessages(prev => {
                      const currentMsgs = prev[activeChatId] || [];
                      return {
                        ...prev,
                        [activeChatId]: currentMsgs.map(m => m.clientMsgId === clientMsgId ? { ...m, id: ack.id, _isPending: false, timestamp: ack.timestamp || m.timestamp } : m)
                      };
                    });

                    if (myKeysRef.current) {
                      LocalDB.saveMessage(`${user?.id}_${activeChatId}`, myLocalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
                    }
                  }
                });
              }
            } catch (err) {
              console.error("Échec chiffrement clip vocal:", err);
            }
          };
        };
        
        recorder.start();
        setMediaRecorder(recorder);
        setIsRecording(true);
      } catch { 
        alert("Impossible d'accéder au microphone."); 
      }
    } else {
      if (mediaRecorder?.stream) {
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
      }
      mediaRecorder?.stop();
      setIsRecording(false);
      setMediaRecorder(null);
    }
  };

  /**
   * CHANGEMENT DE MOT DE PASSE (ZERO-KNOWLEDGE STRICT)
   * 1. Dérive oldAuthKeyHex et oldVaultKey depuis l'ancien mot de passe
   * 2. Déchiffre la clé privée RSA avec oldVaultKey (si nécessaire)
   * 3. Dérive newAuthKeyHex et newVaultKey depuis le nouveau mot de passe
   * 4. Re-chiffre la clé privée RSA avec newVaultKey -> newEncryptedPrivateKey
   * 5. Envoie { oldAuthKeyHex, newAuthKeyHex, newEncryptedPrivateKey }
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
   * RÉINITIALISATION DE LA SESSION
   */
  const handleResetE2EKeys = async () => {
    if (window.confirm("Attention : cela va fermer votre session. Vos anciens messages nécessiteront votre mot de passe pour être déchiffrés. Continuer ?")) {
      handleLogout('Réinitialisation manuelle de la session');
    }
  };

  /**
   * DÉCONNEXION (PURGE COMPLÈTE DE LA MÉMOIRE VIVE)
   */
  const handleLogout = async (reason?: string) => {
    if (reason) console.warn("[Session] Déconnexion:", reason); 
    const currentToken = localStorage.getItem('token');
    if (socket) {
      socket.emit('manual_disconnect');
    }
    // SÉCURITÉ : Révocation du token côté serveur via l'endpoint dédié
    if (currentToken) {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${currentToken}` }
        });
      } catch (e) {
        console.warn('[Logout] Erreur appel /api/logout:', e);
      }
    }
    // SÉCURITÉ : Purger le token JWT côté client
    localStorage.removeItem('token');
    localStorage.removeItem('wlm_user'); 
    localStorage.removeItem('wlm_open_chats');
    localStorage.removeItem('wlm_active_chat');
    // SÉCURITÉ : Purger le cache IndexedDB des émoticônes personnalisées (clés + assets déchiffrés)
    try { await CustomEmoticonsDB.clearAll(); } catch (e) { console.warn('[Logout] Erreur purge CustomEmoticonsDB:', e); }
    setMyKeys(null);
    setUser(null);
    window.location.reload(); 
  };

  /**
   * LANCER UN APPEL (AUDIO OU VIDÉO)
   */
  const handleStartCall = (audioOnly: boolean) => {
    if (!activeChatId || !user) return;
    if (activeChatId === SYSTEM_BOT_ID) {
      alert("Les appels audio/vidéo nécessitent un contact humain réel connecté.");
      return;
    }
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
   * GESTION DES JEUX MULTI-JOUEURS (MORPION, DAMES & PUISSANCE 4)
   */
  const handleInviteGame = (gameType: string = 'checkers') => {
    if (!activeChatId || !user) return;

    // Invitation de jeu contre OpenWLM (mode solo local)
    if (activeChatId === SYSTEM_BOT_ID) {
      if (gameType === 'morpion') {
        setActiveGame({
          opponentId: SYSTEM_BOT_ID,
          opponentName: 'OpenWLM',
          mySymbol: 'X',
          isMyTurn: true,
          gameType: 'morpion'
        });
        setIsGameMinimized(false);
        setShowGamesMenu(false);
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user.id,
              sender: 'OpenWLM',
              text: "Partie de Morpion lancée. À vous de jouer (X).",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: new Date().toISOString()
            }
          ]
        }));
      } else if (gameType === 'puissance4') {
        setActiveGame({
          opponentId: SYSTEM_BOT_ID,
          opponentName: 'OpenWLM',
          mySymbol: 'R',
          myColor: 'red',
          isMyTurn: true,
          gameType: 'puissance4'
        });
        setIsGameMinimized(false);
        setShowGamesMenu(false);
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user.id,
              sender: 'OpenWLM',
              text: "Partie de Puissance 4 lancée. À vous de jouer (Rouge 🔴).",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: new Date().toISOString()
            }
          ]
        }));
      } else {
        alert("OpenWLM prend en charge le Morpion et le Puissance 4 pour les tests solo.");
        setShowGamesMenu(false);
      }
      return;
    }

    if (!socket) return;
    const contact = contacts.find(c => c.id === activeChatId);
    if (!contact || contact.status === 'offline') {
      const gameLabel = gameType === 'checkers' ? 'au Jeu de dames' : (gameType === 'puissance4' ? 'au Puissance 4' : 'au Morpion');
      alert(`Ce contact doit être en ligne pour jouer ${gameLabel}.`);
      return;
    }

    socket.emit('game_invite', { target: activeChatId, gameType });
    setOutgoingGameInvite({ target: activeChatId, targetName: contact.nickname || contact.username, gameType });
    setShowGamesMenu(false);
  };

  /**
   * ACTIONS ET COMMANDES D'OPENWLM (TESTS LOCAUX SANS RÉSEAU)
   */
  const handleAssistantAction = (action: 'emo' | 'wizz' | 'sons' | 'morpion' | 'puissance4' | 'help') => {
    if (action === 'wizz') {
      handleNudge(false);
      return;
    }

    if (action === 'morpion') {
      handleInviteGame('morpion');
      return;
    }

    if (action === 'puissance4') {
      handleInviteGame('puissance4');
      return;
    }

    const nowIso = new Date().toISOString();
    const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let botResponseText = '';
    if (action === 'emo') {
      botResponseText = ":)  :D  ;)  :P  (H)  :@  :$  :O  (A)  :S  (L)  (K)\n(Émoticônes classiques reconnues)";
    } else if (action === 'sons') {
      botResponseText = "Test des sons en cours... (connexion, message, wizz)";
      try {
        SoundManager.play('ONLINE');
        setTimeout(() => {
          SoundManager.play('NEW_MESSAGE');
        }, 1000);
        setTimeout(() => {
          SoundManager.play('NUDGE');
          setIsNudging(true);
          setTimeout(() => setIsNudging(false), 2000);
        }, 2200);
      } catch (e) {
        console.warn("Erreur lecture son:", e);
      }
    } else if (action === 'help') {
      botResponseText = "Commandes disponibles :\n• /emo : tester les émoticônes\n• /wizz : envoyer un Wizz\n• /sons : tester les sons\n• /morpion : jouer au Morpion\n• /puissance4 (ou /p4) : jouer au Puissance 4\n• Tout autre texte : écho direct";
    }

    if (botResponseText) {
      setTimeout(() => {
        try { SoundManager.play('NEW_MESSAGE'); } catch {}
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user?.id,
              sender: 'OpenWLM',
              text: botResponseText,
              time: formattedTime,
              timestamp: nowIso
            }
          ]
        }));
      }, 300);
    }
  };

  const handleAcceptGameInvite = () => {
    if (!incomingGameInvite || !socket) return;
    socket.emit('game_accept', { target: incomingGameInvite.from, gameType: incomingGameInvite.gameType });
    setIncomingGameInvite(null);
  };

  const handleDeclineGameInvite = () => {
    if (!incomingGameInvite || !socket) return;
    socket.emit('game_decline', { target: incomingGameInvite.from });
    setIncomingGameInvite(null);
  };

  const handleCancelOutgoingInvite = () => {
    if (!outgoingGameInvite || !socket) return;
    socket.emit('game_quit', { target: outgoingGameInvite.target });
    setOutgoingGameInvite(null);
  };

  const handleQuitActiveGame = () => {
    if (activeGame && socket) {
      socket.emit('game_quit', { target: activeGame.opponentId });
    }
    setActiveGame(null);
    setIsGameMinimized(false);
  };

  /**
   * GESTION DES DISCUSSIONS OUVERTES
   */
  const openChat = async (id: number) => {
    if (!openChatIds.includes(id)) {
      setOpenChatIds(prev => [...prev, id]);

      // Synchronisation automatique du mode privé si actif en local
      if (id !== SYSTEM_BOT_ID && (globalPrivateMode || isPrivateMode[id]) && socket) {
        socket.emit('toggle_private_mode', {
          senderId: user?.id,
          receiverId: id,
          isPrivate: true,
          senderNickname: myNickname
        });
      }
    }
    setActiveChatId(id);
    loadChatHistory(id);
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
    
    // 1. Émoticônes personnalisées (E2EE) - Triées par longueur décroissante
    const customShortcuts = Object.keys(customEmoticonsMap).sort((a, b) => b.length - a.length);
    customShortcuts.forEach(shortcut => {
      const emoInfo = customEmoticonsMap[shortcut];
      if (!emoInfo || !emoInfo.url) return; // Fallback texte brut si l'asset n'est pas encore disponible

      const newParts: (string | React.ReactNode)[] = [];
      parts.forEach(part => {
        if (typeof part === 'string') {
          const split = part.split(shortcut);
          split.forEach((s, i) => {
            if (s !== '') newParts.push(s);
            if (i < split.length - 1) {
              newParts.push(
                <img 
                  key={`custom-${shortcut}-${i}`} 
                  src={emoInfo.url} 
                  className="custom-emoticon" 
                  alt={shortcut} 
                  title={shortcut} 
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

    // 2. Émoticônes de base (Standard) - Triées par longueur décroissante
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
                  key={`std-${shortcut}-${i}`} 
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

  // Redirection vers l'authentification si aucun utilisateur n'est connecté ou si les clés ne sont pas en mémoire
  if (!user || !myKeys) {
    return <Auth onLogin={handleUserLogin} initialUsername={user?.username || ''} />;
  }

  // Détermination du contact actif pour l'affichage de la discussion
  const activeContact = (activeChatId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === activeChatId)) || { 
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
          {canInstallPWA && (
            <button 
              className="pwa-install-btn" 
              onClick={() => promptPWAInstall()}
              title={t.roster.installPWATooltip}
            >
              📥 {t.roster.installPWA}
            </button>
          )}
        </div>

        {/* En-tête Profil (Avatar, Nom, PSM) */}
        <div className="wlm-header-main">
          <div className="header-scene" style={{ backgroundImage: `url(${myScene})` }}></div>
          <div className="folded-corner" onClick={() => setShowSceneModal(true)} title={t.roster.changeSceneTooltip}></div>
          
          <div className="header-content-inner">
            <div className={`wlm-avatar-glass ${myStatus}`} onClick={() => setShowAvatarModal(true)} style={{ cursor: 'pointer', position: 'relative' }}>
              <img src={myAvatar} alt="Avatar" />
              {globalPrivateMode && (
                <div className="padlock-badge" title={t.chat.privateModeActive} style={{ bottom: '-2px', right: '-2px' }}>🔒</div>
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
                  <span className="nickname-display" onClick={() => setIsEditingNickname(true)} title={t.roster.editTooltip}>{formatNickname(myNickname)}</span>
                )}
                
                <span className="status-trigger" onClick={(e) => { e.stopPropagation(); setShowStatusMenu(!showStatusMenu); }}>
                  <span className="status-label">({getStatusLabel(myStatus)}) ▼</span>
                </span>

                {/* Menu déroulant de Statut et Options */}
                {showStatusMenu && (
                  <div className="wlm-status-dropdown">
                    {STATUS_OPTIONS.map(opt => (
                      <div key={opt.id} className="dropdown-item" onClick={() => { setMyStatus(opt.id); setShowStatusMenu(false); syncProfile({ status: opt.id }); }}>
                        <div className={`status-icon-box ${opt.id}`}></div>{getStatusLabel(opt.id)}
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
                      {globalPrivateMode ? t.roster.globalPrivateOn : t.roster.globalPrivateOff}
                    </div>
                    <div className="dropdown-item" onClick={() => { setShowOptionsModal(true); setShowStatusMenu(false); }}>{t.roster.optionsMenu}</div>
                    <div className="dropdown-item" onClick={() => { setLanguage(language === 'fr' ? 'en' : 'fr'); setShowStatusMenu(false); }}>
                      🌐 {language === 'fr' ? 'English (EN)' : 'Français (FR)'}
                    </div>
                    <div className="dropdown-item" onClick={() => handleLogout()}>{t.auth.logout}</div>
                    <div className="dropdown-item separator"></div>
                    <div className="dropdown-item" onClick={() => { setShowAvatarModal(true); setShowStatusMenu(false); }}>{t.roster.changeAvatar}</div>
                    <div className="dropdown-item" onClick={() => { setShowSceneModal(true); setShowStatusMenu(false); }}>{t.roster.changeScene}</div>
                    <div className="dropdown-item" onClick={() => { setIsEditingNickname(true); setShowStatusMenu(false); }}>{t.roster.changeNickname}</div>
                    <div className="dropdown-item" onClick={() => { setShowPasswordModal(true); setShowStatusMenu(false); }}>{t.roster.changePasswordMenu}</div>
                    <div className="dropdown-item" onClick={handleResetE2EKeys} style={{color:'red'}}>{t.roster.resetE2EKeys}</div>
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
                <div className="user-psm-display" onClick={() => setIsEditingPSM(true)} title={t.roster.editTooltip}>
                  {formatNickname(myPSM) || t.roster.defaultPsm}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Barre d'actions rapides (Recherche, Ajout contact) */}
        <div className="wlm-actions-bar">
          <div className="search-wrapper">
            <input type="text" placeholder={t.common.search} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <i className="search-magnifier">🔍</i>
          </div>
          <div className="actions-icons-right">
            <span onClick={() => setShowAddContactModal(true)} style={{cursor:'pointer'}} title={t.roster.addContact}>👤+</span> 
            <span title={t.roster.organizationTooltip}>▤</span> 
            <span title={t.roster.messagesTooltip}>✉️</span>
          </div>
        </div>

        {/* Liste des Contacts (Roster) */}
        <div className="contact-roster">
          {/* Invitations en attente */}
          {pendingInvites.length > 0 && (
            <div className="pending-section">
               <div className="group-header">{t.roster.pendingInvites} ({pendingInvites.length})</div>
               {pendingInvites.map(invite => (
                 <div key={invite.id} className="contact-row pending">
                    <div className="status-square offline"></div>
                    <div className="contact-name-txt" style={{flex: 1, marginLeft: '10px'}}>{formatNickname(invite.nickname || invite.username)}</div>
                    <div style={{display:'flex', gap:'5px', marginRight: '10px'}}>
                      <button className="win-btn mini" onClick={() => handleAcceptInvite(invite.id)}>{t.roster.accept}</button>
                      <button className="win-btn mini secondary" onClick={() => handleDeclineInvite(invite.id)}>{t.roster.decline}</button>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {/* Contacts en ligne */}
          <div className="group-header" onClick={() => setIsGroupOpen(!isGroupOpen)}>
            <span style={{ transform: isGroupOpen ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
            {t.roster.onlineGroup} ({onlineContacts.length})
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
                {formatNickname(contact.nickname || contact.username)} 
                {contact.psm && <span className="contact-psm-txt"> - {formatNickname(contact.psm)}</span>}
              </div>
            </div>
          ))}

          {/* Contacts hors ligne ou bloqués */}
          <div className="group-header" onClick={() => setIsOfflineGroupOpen(!isOfflineGroupOpen)}>
            <span style={{ transform: isOfflineGroupOpen ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
            {t.roster.offlineGroup} ({offlineContacts.length})
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
                {formatNickname(contact.nickname || contact.username)} 
                {contact.psm && <span className="contact-psm-txt"> - {formatNickname(contact.psm)}</span>} 
                {contact.blocked ? <span style={{fontSize:'10px', marginLeft: '5px'}}>{t.roster.blockedSuffix}</span> : ''}
              </div>
            </div>
          ))}

          {/* Bot (Repliable, sobre et fidèle à WLM) */}
          <div className="group-header" onClick={() => setIsServicesGroupOpen(!isServicesGroupOpen)}>
            <span style={{ transform: isServicesGroupOpen ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: '8px', marginRight: '5px' }}>▼</span>
            {t.roster.botSection} (1)
          </div>
          {isServicesGroupOpen && (
            <div 
              className={`contact-row ${activeChatId === SYSTEM_BOT_ID ? 'active' : ''}`}
              onClick={() => openChat(SYSTEM_BOT_ID)}
              title={t.bot.tooltip}
            >
              <div className="status-square online"></div>
              <div className="contact-name-txt" style={{ display: 'flex', alignItems: 'center', gap: '3px', overflow: 'hidden' }}>
                <span style={{ fontWeight: 600 }}>{t.bot.name}</span>
                <span className="wlm-bot-badge">{t.bot.badge}</span>
                <span className="contact-psm-txt"> - {t.bot.status}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- FENÊTRE DE CONVERSATION --- */}
      <div className={`conversation-window ${isNudging ? 'wlm-nudge' : ''}`}>
        {activeChatId === 0 ? (
          /* État vide si aucune discussion n'est sélectionnée */
          <div className="empty-chat-state">
            <div className="msn-butterfly giant"></div>
            <div className="welcome-text">{t.roster.emptyStateTitle}</div>
            <div className="sub-welcome">{t.roster.emptyStateSubtitle}</div>
            <div style={{ marginTop: '16px' }}>
              <button 
                type="button" 
                className="win-btn"
                onClick={() => openChat(SYSTEM_BOT_ID)}
                style={{ padding: '6px 14px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 600 }}
              >
                <span>🤖</span>
                <span>{t.roster.startTestChat}</span>
              </button>
            </div>
            <div style={{ fontSize: '11px', color: '#777', marginTop: '10px' }}>
              {t.roster.emptyStateBotHint}
            </div>
          </div>
        ) : (
          <>
            {/* Barre d'onglets pour les discussions ouvertes */}
            <div className="chat-tabs-bar">
              <div className="mobile-back-btn" onClick={() => setActiveChatId(0)}>◀</div>
              {openChatIds.map(id => {
                const contact = id === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === id);
                return (
                  <div 
                    key={id} 
                    className={`chat-tab status-${contact?.status || 'online'} ${activeChatId === id ? 'active' : ''}`} 
                    onClick={() => setActiveChatId(id)}
                  >
                    <span className="tab-name">
                      {contact?.isBot ? '🤖 ' : ''}{formatNickname(contact?.nickname || contact?.username || 'Discussion')}{activeGame?.opponentId === id ? ' 🎮' : ''}
                    </span>
                    <span className="chat-tab-close" onClick={(e) => closeChat(e, id)}>✕</span>
                  </div>
                );
              })}
            </div>

            {/* Barre d'actions du chat (Haut) */}
            <div className="chat-top-actions">
              <span onClick={() => fileInputRef.current?.click()} style={{cursor:'pointer'}} title={t.chat.filesTooltip}>{t.chat.files}</span>
              <span onClick={() => setShowBgModal(true)} style={{cursor:'pointer'}}>{t.chat.background}</span>
              <span onClick={() => handleStartCall(false)} style={{cursor:'pointer'}}>{t.chat.video}</span>
              <span onClick={() => handleStartCall(true)} style={{cursor:'pointer'}}>{t.chat.call}</span>
              <div className="wlm-games-menu-wrapper">
                <span 
                  onClick={() => setShowGamesMenu(prev => !prev)} 
                  style={{ cursor: 'pointer', fontWeight: showGamesMenu ? 'bold' : 'normal' }}
                  title={t.chat.gamesMenuTooltip}
                >
                  {t.chat.gamesMenu}
                </span>
                {showGamesMenu && (
                  <>
                    <div 
                      className="wlm-menu-backdrop" 
                      onClick={(e) => { e.stopPropagation(); setShowGamesMenu(false); }} 
                    />
                    <div className="wlm-games-dropdown" onClick={e => e.stopPropagation()}>
                      <div 
                        className="wlm-game-menu-item" 
                        onClick={() => handleInviteGame('puissance4')}
                        title={t.games.puissance4Title.replace('{name}', activeContact.nickname || activeContact.username || '')}
                      >
                        <span className="msn-game-icon">🔴</span>
                        <span>{t.games.puissance4}</span>
                      </div>
                      <div 
                        className="wlm-game-menu-item" 
                        onClick={() => handleInviteGame('checkers')}
                        title={t.games.checkersTitle.replace('{name}', activeContact.nickname || activeContact.username || '')}
                      >
                        <span className="msn-game-icon">⚪</span>
                        <span>{t.games.checkers}</span>
                      </div>
                      <div 
                        className="wlm-game-menu-item" 
                        onClick={() => handleInviteGame('morpion')}
                        title={t.games.morpionTitle.replace('{name}', activeContact.nickname || activeContact.username || '')}
                      >
                        <span className="msn-game-icon">🎮</span>
                        <span>{t.games.morpion}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <span onClick={() => handleInviteGame('checkers')} style={{cursor:'pointer'}} title={t.games.checkersTitle.replace('{name}', activeContact.nickname || activeContact.username || '')}>{t.chat.activities}</span>
              {activeGame && activeGame.opponentId === activeChatId && isGameMinimized && (
                <span 
                  onClick={() => setIsGameMinimized(false)} 
                  style={{ cursor: 'pointer', color: '#0055aa', fontWeight: 'bold' }}
                  title={t.chat.resumeTooltip}
                >
                  {activeGame.gameType === 'checkers' 
                    ? t.chat.resumeCheckers 
                    : (activeGame.gameType === 'puissance4' ? t.chat.resumePuissance4 : t.chat.resumeMorpion)}
                </span>
              )}

              <span
                onClick={() => {
                  if (globalPrivateMode) {
                    alert(t.chat.privateModeGlobalAlert);
                  } else {
                    togglePrivateMode(activeChatId);
                  }
                }}
                style={{ cursor: 'pointer', fontWeight: (globalPrivateMode || isPrivateMode[activeChatId]) ? 'bold' : 'normal', color: (globalPrivateMode || isPrivateMode[activeChatId]) ? '#00FF00' : 'inherit' }}
                title={t.chat.privateModeTooltip}
              >
                {t.chat.privateMode}
              </span>
              </div>

            {/* Vue scindée : Chat à gauche, Jeu à droite */}
            <div className="conversation-split-view" onPaste={handlePaste}>
              <div className="conversation-chat-column">
                {/* Zone principale de discussion */}
                <div className="chat-main-area" style={convBg ? { backgroundImage: `url(/assets/backgrounds/${convBg})`, backgroundSize: 'cover' } : {}}>
               
               {/* En-tête de la discussion (Avatar & PSM du contact) */}
               <div className="conv-header-area" style={{ backgroundImage: `url(${activeContact.scene})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                  <div className="conv-header-overlay"></div>
                  <div className="conv-header-content" style={{ display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                     <div className={`conv-avatar-box ${activeContact.status || 'online'}`} style={{ position: 'relative' }}>
                       <img src={activeContact.avatar} alt="Avatar" />
                       {(globalPrivateMode || isPrivateMode[activeChatId]) && (
                         <div className="padlock-badge" title={t.chat.privateModeActive}>🔒</div>
                       )}
                     </div>
                     <div className="conv-info">
                        <div className="conv-name">
                          {formatNickname(activeContact.nickname || activeContact.username)}
                          {activeContact.id === SYSTEM_BOT_ID && <span className="wlm-bot-badge">{t.bot.badge}</span>}
                          <span style={{fontSize:'12px', fontWeight:'normal', marginLeft: '10px'}}>
                            ({(activeContact.status === 'offline' || !activeContact.id) ? t.status.offline : t.status.online})
                          </span>
                        </div>
                        <div className="conv-psm">{formatNickname(activeContact.psm) || ((activeContact.status === 'offline' || !activeContact.id) ? '' : t.status.online)}</div>
                     </div>
                  </div>
               </div>

                {/* Bannière d'invitation à un jeu reçu */}
                {incomingGameInvite && incomingGameInvite.from === activeChatId && (
                  <div className="wlm-game-invite-banner">
                    <div className="wlm-game-invite-info">
                      <span className="wlm-game-invite-icon">
                        {incomingGameInvite.gameType === 'checkers' ? '⚪' : (incomingGameInvite.gameType === 'puissance4' ? '🔴' : '🎮')}
                      </span>
                      <div className="wlm-game-invite-text">
                        <span className="wlm-game-invite-title">
                          {incomingGameInvite.gameType === 'checkers' 
                            ? t.games.inviteCheckersTitle 
                            : (incomingGameInvite.gameType === 'puissance4' ? t.games.invitePuissance4Title : t.games.inviteMorpionTitle)}
                        </span>
                        <span className="wlm-game-invite-sub">{formatNickname(t.games.inviteLivePrompt.replace('{name}', incomingGameInvite.fromName))}</span>
                      </div>
                    </div>
                    <div className="wlm-game-invite-actions">
                      <button className="btn-game-accept" onClick={handleAcceptGameInvite}>{t.roster.accept}</button>
                      <button className="btn-game-decline" onClick={handleDeclineGameInvite}>{t.roster.decline}</button>
                    </div>
                  </div>
                )}

                {/* Bannière d'invitation à un jeu envoyé */}
                {outgoingGameInvite && outgoingGameInvite.target === activeChatId && (
                  <div className="wlm-game-invite-banner">
                    <div className="wlm-game-invite-info">
                      <span className="wlm-game-invite-icon">⏳</span>
                      <div className="wlm-game-invite-text">
                        <span className="wlm-game-invite-title">
                          {outgoingGameInvite.gameType === 'checkers' 
                            ? t.games.invitePendingCheckers 
                            : (outgoingGameInvite.gameType === 'puissance4' ? t.games.invitePendingPuissance4 : t.games.invitePendingMorpion)}
                        </span>
                        <span className="wlm-game-invite-sub">{formatNickname(t.games.inviteSentWaiting.replace('{name}', outgoingGameInvite.targetName))}</span>
                      </div>
                    </div>
                    <div className="wlm-game-invite-actions">
                      <button className="btn-game-decline" onClick={handleCancelOutgoingInvite}>{t.common.cancel}</button>
                    </div>
                  </div>
                )}
                {/* Barre de jeu réduite (permet de discuter tout en suivant la partie) */}
                {activeGame && activeGame.opponentId === activeChatId && isGameMinimized && (
                  <div 
                    className={`wlm-game-docked-pill ${gameSummary.isMyTurn ? 'docked-pill-my-turn' : ''}`}
                    onClick={() => setIsGameMinimized(false)}
                    title={t.games.dockedExpand}
                  >
                    <div className="docked-pill-info">
                      <span className="docked-pill-icon">
                        {activeGame.gameType === 'checkers' ? '⚪' : (activeGame.gameType === 'puissance4' ? '🔴' : '🎮')}
                      </span>
                      <div className="docked-pill-texts">
                        <span className="docked-pill-title">
                          {formatNickname(t.games.dockedTitle.replace('{game}', activeGame.gameType === 'checkers' ? t.games.checkers : (activeGame.gameType === 'puissance4' ? t.games.puissance4 : t.games.morpion)).replace('{name}', activeGame.opponentName))}
                        </span>
                        <span className="docked-pill-score">
                          {t.games.dockedScore.replace('{myScore}', gameSummary.myScore.toString()).replace('{opponentScore}', gameSummary.opponentScore.toString())}
                        </span>
                      </div>
                      <span className={`docked-pill-badge ${gameSummary.isMyTurn ? 'badge-my-turn' : 'badge-wait'}`}>
                        {gameSummary.winner 
                          ? (gameSummary.winner === 'me' ? t.games.dockedWon : gameSummary.winner === 'opponent' ? t.games.dockedLost : t.games.dockedDraw)
                          : (gameSummary.isMyTurn ? t.games.dockedYourTurn : formatNickname(t.games.dockedOpponentTurn.replace('{name}', activeGame.opponentName)))}
                      </span>
                    </div>
                    <div className="docked-pill-actions" onClick={e => e.stopPropagation()}>
                      <button 
                        className="btn-docked-restore" 
                        onClick={() => setIsGameMinimized(false)}
                        title={t.games.dockedExpand}
                      >
                        {t.games.dockedExpand}
                      </button>
                      <button 
                        className="btn-docked-quit" 
                        onClick={handleQuitActiveGame}
                        title={t.games.quitGameTitle}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}

               {/* Historique des messages (Scrollable) */}
               <div className="chat-log-scroll">
                  {(messages[activeChatId] || []).map((m, i) => {
                    const isSender = m.sender_id === user?.id || m.senderId === user?.id || m.sender === myNickname;
                    const activeContact = activeChatId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === activeChatId);
                    const senderDisplayName = isSender 
                      ? (myNickname || user?.nickname || user?.username || 'Moi')
                      : (m.sender && m.sender !== 'Contact' ? m.sender : (activeContact?.nickname || activeContact?.username || m.sender || 'Contact'));

                    const isImage = isImageFile(m.fileData);
                    const fileHeaderLabel = isSender
                      ? (isImage ? t.chat.youSentImage : t.chat.youSentFile)
                      : (isImage ? t.chat.contactSentImage.replace('{name}', senderDisplayName) : t.chat.contactSentFile.replace('{name}', senderDisplayName));

                    return (
                    <div key={i} className="msg-line">
                       {m.sender === 'Système' ? (
                         <div className="msg-system">{m.text}</div>
                       ) : (
                         <>
                           <div className={`msg-name ${isSender ? 'me' : ''}`}>
                             {m.fileData ? formatNickname(fileHeaderLabel) : <>{formatNickname(senderDisplayName)} {t.chat.says}</>}
                           </div>
                           {m.fileData ? (
                             <FileTransferCard 
                               fileData={m.fileData} 
                               myPrivateKey={myKeys?.privateKeyJwk} 
                               isSender={isSender} 
                             />
                           ) : m.audio ? (
                             <VoiceClipPlayer src={m.audio} />
                           ) : (
                             renderMessageContent(m.text, m.style)
                           )}
                         </>
                       )}
                    </div>
                  );
                  })}
                  <div ref={chatEndRef} />
               </div>

               {/* Actions rapides de test pour OpenWLM */}
               {activeChatId === SYSTEM_BOT_ID && (
                 <div className="wlm-bot-quick-actions">
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('emo')} title={t.bot.chipEmoticons}>
                     {t.bot.chipEmoticons}
                   </button>
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('wizz')} title={t.bot.chipWizz}>
                     {t.bot.chipWizz}
                   </button>
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('sons')} title={t.bot.chipSounds}>
                     {t.bot.chipSounds}
                   </button>
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('morpion')} title={t.bot.chipMorpion}>
                     {t.bot.chipMorpion}
                   </button>
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('puissance4')} title={t.bot.chipPuissance4}>
                     {t.bot.chipPuissance4}
                   </button>
                   <button type="button" className="wlm-chip-btn" onClick={() => handleAssistantAction('help')} title={t.bot.chipHelp}>
                     {t.bot.chipHelp}
                   </button>
                 </div>
               )}

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
                        onPaste={handlePaste}
                        placeholder={t.chat.typeMessagePlaceholder} 
                     />
                     
                     {/* Barre d'outils du chat (Émoticônes, Winks, Wizz, Voice) */}
                     <div className="chat-toolbar" style={{ position: 'relative' }}>
                        <span className="tool-icon" title={t.chat.emoticonsTooltip} onClick={() => setShowEmoticonMenu(!showEmoticonMenu)}>
                          <img src="/assets/icons/emoticon_official.svg" style={{width:'32px', cursor:'pointer'}} alt={t.chat.emoticonsTooltip} />
                        </span>
                        
                        {showEmoticonMenu && (
                          <div className="emoticon-popup">
                            <div className="emoticon-popup-header">
                              <span>{t.chat.emoticonsTooltip}</span>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <span className="tout-afficher" onClick={() => { setShowCustomEmoticonsModal(true); setShowEmoticonMenu(false); }} title={t.chat.manageEmoticons}>
                                  + {t.chat.myEmoticons}
                                </span>
                                <span className="tout-afficher" onClick={() => { setShowAllEmoticonsModal(true); setShowEmoticonMenu(false); }}>
                                  {t.chat.emoticonsAll}
                                </span>
                              </div>
                            </div>

                            {/* Section: Mes émoticônes (si l'utilisateur en possède) */}
                            {myCustomEmoticons.length > 0 && (
                              <div className="emoticon-section" style={{ maxHeight: '110px', overflowY: 'auto' }}>
                                <div className="emoticon-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span>{t.chat.myEmoticons} ({myCustomEmoticons.length})</span>
                                  <span 
                                    style={{ fontSize: '10px', color: '#004b8d', cursor: 'pointer', textDecoration: 'underline' }}
                                    onClick={() => { setShowCustomEmoticonsModal(true); setShowEmoticonMenu(false); }}
                                  >
                                    {t.chat.manageEmoticons}
                                  </span>
                                </div>
                                <div className="emoticon-grid">
                                  {myCustomEmoticons.slice(0, 15).map((emo) => {
                                    const emoUrl = customEmoticonsMap[emo.shortcut]?.url;
                                    return (
                                      <div 
                                        key={emo.id} 
                                        className="emoticon-item" 
                                        title={emo.shortcut} 
                                        onClick={() => { setInputText(prev => prev + emo.shortcut); setShowEmoticonMenu(false); }}
                                      >
                                        {emoUrl ? (
                                          <img src={emoUrl} alt={emo.shortcut} className="custom-emoticon" />
                                        ) : (
                                          <span style={{ fontSize: '9px' }}>...</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            <div className="emoticon-section">
                              <div className="emoticon-section-title">{t.chat.standardEmoticons}</div>
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

                        <span className="tool-icon" title={t.chat.winksTooltip} onClick={() => setShowWinksModal(true)}>
                          <img src="/assets/icons/wink_official.svg" style={{width:'32px', cursor:'pointer'}} alt={t.chat.winksTooltip} />
                        </span>
                        
                        <span className="tool-icon" title={t.chat.nudgeTooltip} onClick={() => handleNudge(false)}>
                          <img src="/assets/icons/wizz_reconstructed.svg" style={{width:'36px', cursor:'pointer'}} alt={t.chat.nudgeTooltip} />
                        </span>
                        
                        <span className={`tool-icon ${isRecording ? 'recording' : ''}`} title={isRecording ? t.chat.stopAndSend : t.chat.voiceClip} onClick={handleVoiceClip}>
                          <img src="/assets/icons/voice_clip_official.svg" style={{width:'32px', cursor:'pointer'}} alt={t.chat.voiceClip} />
                        </span>
                        
                        {isRecording && (
                          <span className="tool-icon" title={t.chat.cancelRecording} onClick={handleCancelVoiceClip} style={{ color: 'red', fontWeight: 'bold', fontSize: '20px' }}>✕</span>
                        )}

                        <span className="tool-icon" title={t.chat.filesTooltip} onClick={() => fileInputRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg style={{width:'22px', height:'22px', cursor:'pointer'}} viewBox="0 0 24 24" fill="none" stroke="#004b8d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                        </span>

                        <input 
                          type="file" 
                          ref={fileInputRef} 
                          style={{ display: 'none' }} 
                          onChange={handleFileSelect} 
                        />
                        
                        <span className="tool-icon" title={t.chat.fontTooltip} style={{ fontSize: '14px', fontWeight: 'bold', color: '#004b8d', cursor:'pointer' }} onClick={() => setShowFontModal(true)}>A/B</span>
                     </div>
                  </div>
               </div>
            </div>
          </div>

          {/* Colonne latérale de jeu (Morpion ou Jeu de dames) */}
          {activeGame && (
            <div 
              className={`conversation-game-column ${isGameMinimized ? 'minimized' : ''}`}
              style={{
                display: (activeGame.opponentId === activeChatId && !isGameMinimized) ? 'flex' : 'none'
              }}
            >
              {activeGame.gameType === 'checkers' ? (
                <CheckersGame
                  socket={socket}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  myColor={(activeGame.myColor === 'white' || activeGame.myColor === 'black') ? activeGame.myColor : (activeGame.mySymbol === 'W' ? 'white' : 'black')}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={() => {
                    setActiveGame(null);
                    setIsGameMinimized(false);
                  }}
                  onMinimize={() => setIsGameMinimized(true)}
                  onGameStateChange={(summary) => setGameSummary(summary)}
                />
              ) : activeGame.gameType === 'puissance4' ? (
                <Puissance4Game
                  socket={activeGame.opponentId === SYSTEM_BOT_ID ? null : socket}
                  isBotOpponent={activeGame.opponentId === SYSTEM_BOT_ID}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  myColor={activeGame.myColor === 'yellow' ? 'yellow' : 'red'}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={() => {
                    setActiveGame(null);
                    setIsGameMinimized(false);
                  }}
                  onMinimize={() => setIsGameMinimized(true)}
                  onGameStateChange={(summary) => setGameSummary(summary)}
                />
              ) : (
                <MorpionGame
                  socket={activeGame.opponentId === SYSTEM_BOT_ID ? null : socket}
                  isBotOpponent={activeGame.opponentId === SYSTEM_BOT_ID}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  initialSymbol={(activeGame.mySymbol as 'X' | 'O') || 'X'}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={() => {
                    setActiveGame(null);
                    setIsGameMinimized(false);
                  }}
                  onMinimize={() => setIsGameMinimized(true)}
                  onGameStateChange={(summary) => setGameSummary(summary)}
                />
              )}
            </div>
          )}
        </div>
      </>
        )}
      </div>

      {/* --- MODALES --- */}

      {/* Modale: Confirmation d'envoi d'une capture d'écran collée */}
      {pastedImage && (
        <div className="modal-bg" onClick={handleCancelPastedImage}>
          <div className="wlm-paste-modal" onClick={e => e.stopPropagation()}>
            <div className="wlm-paste-modal-header">
              <div className="wlm-paste-title-area">
                <span className="wlm-paste-icon">📷</span>
                <span className="wlm-paste-title">{t.modals.pastedImageTitle}</span>
              </div>
              <button 
                type="button" 
                className="win-close-btn" 
                onClick={handleCancelPastedImage} 
                title={`${t.common.close} (Esc)`}
              >
                ✕
              </button>
            </div>

            <div className="wlm-paste-modal-body">
              <div className="wlm-paste-prompt">
                {t.modals.pastedImagePrompt.replace('{name}', (() => {
                  const activeContact = activeChatId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT : contacts.find(c => c.id === activeChatId);
                  return activeContact?.nickname || activeContact?.username || 'contact';
                })())}
              </div>

              <div className="wlm-paste-preview-container">
                <div className="wlm-paste-thumbnail-box">
                  <img 
                    src={pastedImage.previewUrl} 
                    alt="Preview" 
                    className="wlm-paste-thumbnail" 
                  />
                </div>
                <div className="wlm-paste-meta-box">
                  <div className="wlm-paste-filename" title={pastedImage.file.name}>
                    📁 {pastedImage.file.name}
                  </div>
                  <div className="wlm-paste-filesize">
                    {t.modals.sizeLabel} <strong>{formatFileSize(pastedImage.file.size)}</strong>
                  </div>
                  <div className="wlm-paste-type">
                    {t.modals.formatLabel} {pastedImage.file.type || 'image/png'}
                  </div>
                  <div className="wlm-paste-hint">
                    {t.modals.e2eeExpiryHint}
                  </div>
                </div>
              </div>
            </div>

            <div className="wlm-paste-modal-footer">
              <button 
                type="button" 
                className="win-btn win-btn-primary" 
                onClick={handleConfirmPastedImage}
                autoFocus
              >
                {t.chat.send}
              </button>
              <button 
                type="button" 
                className="win-btn" 
                onClick={handleCancelPastedImage}
              >
                {t.common.cancel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Toutes les émoticônes */}
      {showAllEmoticonsModal && (
        <div className="modal-bg" onClick={() => setShowAllEmoticonsModal(false)}>
          <div className="modal-box emoticons-all-modal" onClick={e => e.stopPropagation()} style={{ width: '440px' }}>
            <div className="win-modal-header">
              <span>{t.modals.allEmoticonsTitle}</span>
              <button className="win-close-btn" onClick={() => setShowAllEmoticonsModal(false)}>✕</button>
            </div>
            
            <div style={{ padding: '12px 16px', maxHeight: '420px', overflowY: 'auto' }}>
              {/* Section Mes émoticônes */}
              <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #d0e0ee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#004b8d' }}>
                    {t.chat.myEmoticons} ({myCustomEmoticons.length})
                  </span>
                  <button 
                    type="button" 
                    className="win-btn" 
                    style={{ fontSize: '10px', padding: '2px 8px' }}
                    onClick={() => { setShowCustomEmoticonsModal(true); setShowAllEmoticonsModal(false); }}
                  >
                    {t.modals.addManageBtn}
                  </button>
                </div>
                {myCustomEmoticons.length === 0 ? (
                  <div style={{ fontSize: '11px', color: '#888', fontStyle: 'italic', padding: '6px 0' }}>
                    {t.chat.noCustomEmoticons}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
                    {myCustomEmoticons.map((emo) => {
                      const emoUrl = customEmoticonsMap[emo.shortcut]?.url;
                      return (
                        <div 
                          key={emo.id} 
                          className="emoticon-item-large" 
                          title={emo.shortcut} 
                          onClick={() => { setInputText(prev => prev + emo.shortcut); setShowAllEmoticonsModal(false); }}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', padding: '4px', border: '1px solid #e0eaf2', borderRadius: '4px' }}
                        >
                          {emoUrl ? (
                            <img src={emoUrl} alt={emo.shortcut} style={{ width: '24px', height: '24px', objectFit: 'contain' }} />
                          ) : (
                            <span style={{ fontSize: '10px' }}>...</span>
                          )}
                          <span style={{ fontSize: '9px', color: '#444', marginTop: '2px', maxWidth: '50px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emo.shortcut}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Section Émoticônes standard */}
              <div>
                <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#004b8d', marginBottom: '8px' }}>
                  {t.chat.standardEmoticons}
                </div>
                <div className="emoticon-all-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '10px' }}>
                  {EMOTICONS_LIST.map((emo, idx) => (
                    <div key={idx} className="emoticon-item-large" title={emo.shortcut} onClick={() => { setInputText(prev => prev + emo.shortcut); setShowAllEmoticonsModal(false); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                      <img src={`/assets/emoticons/${emo.file}`} alt={emo.shortcut} style={{ width: '19px', height: '19px' }} />
                      <span style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>{emo.shortcut}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ marginTop: '10px', padding: '10px 14px', borderTop: '1px solid #ddd', textAlign: 'right', background: '#f5f5f5' }}>
              <button className="win-btn" onClick={() => setShowAllEmoticonsModal(false)}>{t.common.close}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Gestionnaire des émoticônes personnalisées (E2EE) */}
      <CustomEmoticonsModal 
        isOpen={showCustomEmoticonsModal}
        onClose={() => setShowCustomEmoticonsModal(false)}
        userToken={user?.token}
        onEmoticonsChange={handleCustomEmoticonsChange}
        onSelectEmoticon={(shortcut) => {
          setInputText(prev => prev + shortcut);
          setShowCustomEmoticonsModal(false);
        }}
      />

      {/* Modale: Choix du décor (Scène) */}
      {showSceneModal && (
        <div className="modal-bg" onClick={() => setShowSceneModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>{t.modals.changeSceneTitle}</span><button className="win-close-btn" onClick={() => setShowSceneModal(false)}>✕</button></div>
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
            <div className="win-modal-header"><span>{t.modals.addContactTitle}</span><button className="win-close-btn" onClick={() => setShowAddContactModal(false)}>✕</button></div>
            <div className="auth-field" style={{ padding: '20px' }}>
              <label>{t.modals.contactEmailLabel}</label>
              <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder={t.modals.contactEmailPlaceholder || "pseudo@openwlm.dev"} style={{ width: '100%', marginTop: '5px' }} />
            </div>
            <div style={{ marginTop: '20px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '0 20px 20px' }}>
              <button className="win-btn" onClick={handleInvite}>{t.common.ok}</button>
              <button className="win-btn" onClick={() => setShowAddContactModal(false)}>{t.common.cancel}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Modifier l'arrière-plan de la discussion */}
      {showBgModal && (
        <div className="modal-bg" onClick={() => setShowBgModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>{t.modals.changeBgTitle}</span><button className="win-close-btn" onClick={() => setShowBgModal(false)}>✕</button></div>
            <div className="scene-grid">
              {CONV_BACKGROUNDS.map(bg => (
                <div key={bg.id} className="scene-thumb" onClick={() => { setConvBg(bg.file); setShowBgModal(false); }}>
                  {bg.file ? <img src={`/assets/backgrounds/${bg.file}`} alt={bg.name} /> : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f0f0' }}>{t.modals.bgNone}</div>}
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
            <div className="win-modal-header"><span>{t.modals.chooseAvatarTitle}</span><button className="win-close-btn" onClick={() => setShowAvatarModal(false)}>✕</button></div>
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
            <div className="win-modal-header"><span>{t.modals.changeFontTitle}</span><button className="win-close-btn" onClick={() => setShowFontModal(false)}>✕</button></div>
            <div className="win-modal-body">
              <div className="win-font-grid">
                <div className="win-field-col">
                  <label>{t.modals.fontFamily}</label>
                  <input type="text" readOnly value={fontSettings.family} className="win-input-preview" />
                  <div className="win-list-box">
                    {['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Comic Sans MS', 'Courier New', 'Times New Roman'].map(f => (
                      <div key={f} className={`win-list-item ${fontSettings.family === f ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, family: f})}>{f}</div>
                    ))}
                  </div>
                </div>
                <div className="win-field-col">
                  <label>{t.modals.fontStyle}</label>
                  <input type="text" readOnly value={fontSettings.weight === 'bold' ? (fontSettings.style === 'italic' ? t.modals.styleBoldItalic : t.modals.styleBold) : (fontSettings.style === 'italic' ? t.modals.styleItalic : t.modals.styleNormal)} className="win-input-preview" />
                  <div className="win-list-box">
                    <div className={`win-list-item ${fontSettings.weight === 'normal' && fontSettings.style === 'normal' ? 'selected' : ''}`} onClick={() => setFontSettings({...fontSettings, weight: 'normal', style: 'normal'})}>{t.modals.styleNormal}</div>
                    <div className={`win-list-item ${fontSettings.style === 'italic' && fontSettings.weight === 'normal' ? 'selected' : ''}`} style={{ fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, style: 'italic', weight: 'normal'})}>{t.modals.styleItalic}</div>
                    <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'normal' ? 'selected' : ''}`} style={{ fontWeight: 'bold' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'normal'})}>{t.modals.styleBold}</div>
                    <div className={`win-list-item ${fontSettings.weight === 'bold' && fontSettings.style === 'italic' ? 'selected' : ''}`} style={{ fontWeight: 'bold', fontStyle: 'italic' }} onClick={() => setFontSettings({...fontSettings, weight: 'bold', style: 'italic'})}>{t.modals.styleBoldItalic}</div>
                  </div>
                </div>
                <div className="win-field-col">
                  <label>{t.modals.fontSize}</label>
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
                    <legend>{t.modals.fontEffects}</legend>
                    <label className="win-checkbox"><input type="checkbox" checked={fontSettings.strikeout} onChange={e => setFontSettings({...fontSettings, strikeout: e.target.checked})} /> {t.modals.strikeout}</label>
                    <label className="win-checkbox"><input type="checkbox" checked={fontSettings.underline} onChange={e => setFontSettings({...fontSettings, underline: e.target.checked})} /> {t.modals.underline}</label>
                    <div style={{ marginTop: '10px' }}>
                      <label>{t.modals.fontColor}</label>
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
                    <legend>{t.modals.fontPreview}</legend>
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
                <button className="win-btn" onClick={() => setShowFontModal(false)}>{t.common.ok}</button>
                <button className="win-btn" onClick={() => setShowFontModal(false)}>{t.common.cancel}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modale: Choix d'un Clin d'œil (Wink) */}
      {showWinksModal && (
        <div className="modal-bg" onClick={() => setShowWinksModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header"><span>{t.modals.chooseWinkTitle}</span><button className="win-close-btn" onClick={() => setShowWinksModal(false)}>✕</button></div>
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
            <div className="win-modal-header"><span>{t.modals.changePasswordTitle}</span><button className="win-close-btn" onClick={() => setShowPasswordModal(false)}>✕</button></div>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '20px' }}>
              <input id="old-password" type="password" placeholder={t.modals.oldPasswordPlaceholder} required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
              <input id="new-password" type="password" placeholder={t.modals.newPasswordPlaceholder} required className="user-name-input" style={{ width: '100%', padding: '5px' }} />
              <button type="submit" className="win-btn" style={{ marginTop: '10px' }}>{t.modals.validateBtn}</button>
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
              <span>{t.settings.optionsTitle}</span>
              <button className="win-close-btn" onClick={() => setShowOptionsModal(false)}>✕</button>
            </div>
            
            <div className="options-body">
              <div className="options-sidebar">
                <div className="options-nav-item active">{t.settings.tabPersonal}</div>
                <div className="options-nav-item">{t.settings.tabLayout}</div>
                <div className="options-nav-item">{t.settings.tabMessages}</div>
                <div className="options-nav-item">{t.settings.tabAlerts}</div>
                <div className="options-nav-item">{t.settings.tabSounds}</div>
                <div className="options-nav-item">{t.settings.tabSecurity}</div>
                <div className="options-nav-item">{t.settings.tabConnection}</div>
              </div>
              
              <div className="options-content">
                <div className="options-section">
                  <div className="options-title">{t.settings.tabPersonal}</div>
                  
                  <div className="options-subsection">
                    <label className="options-label">{t.auth.nicknameLabel.replace(':', '')}</label>
                    <div className="options-hint">{t.settings.nicknameSub}</div>
                    <input 
                      className="win-input" 
                      value={myNickname} 
                      onChange={e => setMyNickname(e.target.value)} 
                      style={{ width: '90%' }} 
                    />
                  </div>

                  <div className="options-subsection">
                    <div className="options-hint">{t.settings.psmSub}</div>
                    <input 
                      className="win-input" 
                      value={myPSM} 
                      onChange={e => setMyPSM(e.target.value)} 
                      style={{ width: '90%' }} 
                    />
                  </div>

                  <div className="options-subsection">
                    <label className="options-label">{t.common.language}</label>
                    <div style={{ marginTop: '5px' }}>
                      <select 
                        value={language} 
                        onChange={e => setLanguage(e.target.value as 'fr' | 'en')}
                        className="wlm-auth-select"
                        style={{ width: '160px', padding: '3px 6px' }}
                      >
                        <option value="fr">{t.common.french}</option>
                        <option value="en">{t.common.english}</option>
                      </select>
                    </div>
                  </div>

                  <div className="options-subsection">
                    <label className="options-label">{t.settings.statusSection}</label>
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
                      <label htmlFor="check-away">{t.settings.autoAwayPrefix}</label>
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
                      <span>{t.settings.autoAwaySuffix}</span>
                    </div>
                  </div>

                  <div className="options-subsection">
                    <label className="options-label">{t.settings.webcamSection}</label>
                    <div className="options-checkbox-line">
                      <input type="checkbox" id="check-webcam" defaultChecked />
                      <label htmlFor="check-webcam">{t.settings.webcamCheckbox}</label>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="win-modal-footer">
              <button className="win-btn" onClick={() => { syncProfile({ nickname: myNickname, psm: myPSM }); setShowOptionsModal(false); }}>{t.common.ok}</button>
              <button className="win-btn" onClick={() => setShowOptionsModal(false)}>{t.common.cancel}</button>
              <button className="win-btn" onClick={() => syncProfile({ nickname: myNickname, psm: myPSM })}>{t.common.apply}</button>
            </div>
          </div>
        </div>
      )}

      {/* Menu Contextuel (Clic droit sur un contact) */}
      {contextMenu && (
        <div className="wlm-status-dropdown" style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 10000 }}>
          <div className="dropdown-item" onClick={() => openChat(contextMenu.contactId)}>{t.roster.contextSendIM}</div>
          <div className="dropdown-item" onClick={() => handleClearHistory(contextMenu.contactId)}>{t.roster.contextClearHistory}</div>
          <div className="dropdown-item separator"></div>
          <div className="dropdown-item" onClick={() => handleDeleteContact(contextMenu.contactId)}>{t.roster.contextDelete}</div>
          {contacts.find(c => c.id === contextMenu.contactId)?.blocked ? (
            <div className="dropdown-item" onClick={() => handleBlockContact(contextMenu.contactId, false)}>{t.roster.contextUnblock}</div>
          ) : (
            <div className="dropdown-item" onClick={() => handleBlockContact(contextMenu.contactId, true)}>{t.roster.contextBlock}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default App;
