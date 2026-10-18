import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import Auth from './components/Auth';
import './WLM.css';
import SoundManager from './utils/SoundManager';
import LocalDB from './utils/LocalDB';
import { 
  sanitize, 
  generateKeyPair, 
  encryptPrivateKeyVault, 
  decryptPrivateKeyVault,
  deriveZeroKnowledgeKeys,
  encryptFileBinary,
  decryptCustomEmoticon,
  importPrivateCryptoKey,
  importPrivateKeyForSigning,
  calculatePublicKeyFingerprint,
  formatSafetyNumber
} from './utils/Security';
import E2EEKeyStorage from './utils/E2EEKeyStorage';
import { type EnvelopeStatus } from './utils/MessageEnvelope';
import { useMessageCrypto } from './hooks/useMessageCrypto';
import { useContacts } from './hooks/useContacts';
import { useGames } from './hooks/useGames';
import { useCalls } from './hooks/useCalls';
import { useWinksAndNudge } from './hooks/useWinksAndNudge';
import { useProfile } from './hooks/useProfile';
import { useNotifications } from './hooks/useNotifications';
import VerifiedContactsStorage, { type VerifiedContactRecord } from './utils/VerifiedContactsStorage';
import WinkPlayer from './components/WinkPlayer';
import VideoCall from './components/VideoCall';
import { type FileDataPayload } from './components/FileTransferCard';
import MorpionGame from './components/MorpionGame';
import CheckersGame from './components/CheckersGame';
import Puissance4Game from './components/Puissance4Game';
import MinesweeperGame from './components/MinesweeperGame';
import CustomEmoticonsModal from './components/CustomEmoticonsModal';
import { SceneModal } from './components/SceneModal';
import { AvatarModal } from './components/AvatarModal';
import { WinksModal } from './components/WinksModal';
import { BgModal } from './components/BgModal';
import { PasswordModal } from './components/PasswordModal';
import { getExistingPushSubscription, closeCallPushNotifications } from './utils/PushNotificationManager';
import { AddContactModal } from './components/AddContactModal';
import { FontModal, type FontSettings } from './components/FontModal';
import { AllEmoticonsModal } from './components/AllEmoticonsModal';
import { OptionsModal } from './components/OptionsModal';
import { ContactRoster } from './components/ContactRoster';
import { ChatTabsBar } from './components/ChatTabsBar';
import { ChatToolbar } from './components/ChatToolbar';
import { ChatMessageLog } from './components/ChatMessageLog';
import { ChatWindow } from './components/ChatWindow';
import CustomEmoticonsDB, { type MyEmoticonRecord } from './utils/CustomEmoticonsDB';
import { onInstallAvailabilityChange, promptPWAInstall } from './pwa';
import { useI18n } from './i18n';
import { formatNickname } from './utils/NicknameFormatter';
import DesktopToastContainer from './components/DesktopToast';
import AeroConfirmDialog from './components/AeroConfirmDialog';
import {
  decideNotificationType,
  showSystemNotification,
  getSystemNotificationPermission
} from './utils/NotificationManager';
import { reorderChatTabs, sanitizeOpenChatIds } from './utils/TabUtils';
import { resolveMessageSide } from './utils/MessageIdentity';
import {
  loadConversationBackgrounds,
  setConversationBackground
} from './utils/ConversationBackgrounds';
import {
  type User,
  type Contact,
  type Message,
  type CustomEmoticonPayload,
  SYSTEM_BOT_ID,
  SYSTEM_BOT_CONTACT
} from './types';
import {
  loadOpenChatIds,
  saveOpenChatIds,
  loadActiveChatId,
  saveActiveChatId,
  loadPrivateModes,
  savePrivateModes,
  loadGlobalPrivateMode,
  saveGlobalPrivateMode,
  sanitizeUserForStorage,
  loadPreferredStatus,
  savePreferredStatus,
  isPresenceStatus
} from './utils/profileStorage';
import { useAppPrefs, getAppPrefs, setPresenceForSounds } from './utils/appPrefs';
import { mergeServerHistory, cacheableHistory, withLocalOnly } from './utils/historyMerge';

axios.defaults.withCredentials = true;

// Icône d'un type de jeu (invitations, barre réduite)
const gameIcon = (gameType?: string) =>
  gameType === 'checkers' ? '⚪' : gameType === 'puissance4' ? '🔴' : gameType === 'minesweeper' ? '💣' : '🎮';

/**
 * INTERFACES (types de domaine partagés, cf. src/types.ts)
 */

/** Taille max. d'un message sur la socket (le serveur borne les trames à 1 Mo). */
const MAX_SOCKET_MESSAGE_CHARS = 900_000;
/** Délai d'attente de l'accusé du serveur avant de considérer l'envoi comme échoué. */
const SEND_ACK_TIMEOUT_MS = 15_000;
/** Clips vocaux : débit d'encodage et durée maximale (≈ 650 Ko une fois chiffrés). */
const VOICE_CLIP_BITRATE = 32_000;
const VOICE_CLIP_MAX_MS = 90_000;

/** Verdicts pour lesquels un contenu est affiché (les deux derniers avec avertissement). */
// Seuls les messages signés et vérifiés sont affichés ; tout le reste est refusé.
const DISPLAYABLE_AUTH: ReadonlySet<EnvelopeStatus> = new Set<EnvelopeStatus>(['verified']);


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

/**
 * CONSTANTES DE CONFIGURATION
 */

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

/* ============================================================================
 * CHAMP DE SAISIE RICHE (émoticônes rendues en image PENDANT la frappe)
 *
 * Le champ est un contentEditable : le texte est la source de vérité, mais un
 * raccourci complété (`:D`, `:)`, `(L)`, émoticônes perso…) est converti en une
 * vraie balise <img> inline. Comme dans les messages, l'image occupe donc sa
 * largeur réelle et pousse le texte (plus de chevauchement), avec le même
 * `vertical-align` que les bulles (`inline-emoticon`).
 *
 * `data-shortcut` sur chaque <img> permet de reconstruire le texte exact pour
 * l'envoi (sérialisation), et de gérer le curseur en "unités texte".
 * ========================================================================== */

interface EmoticonShortcut { shortcut: string; src: string; custom: boolean }
type RichToken = { text: string } | { shortcut: string; src: string; custom: boolean };

const hasShortcutKey = (t: RichToken): t is Extract<RichToken, { shortcut: string }> => 'shortcut' in t;

// Zero-width space : ancre invisible pour le curseur après un saut de ligne
// final (un `\n` en fin de nœud texte se comporte mal dans un contentEditable).
// Il est retiré de toute sérialisation, donc jamais envoyé.
const RICH_ZWSP = '\u200B';
const stripRichZwsp = (s: string) => s.split(RICH_ZWSP).join('');

function buildRichTokens(text: string, shortcuts: EmoticonShortcut[]): RichToken[] {
  const tokens: RichToken[] = [];
  let buffer = '';
  let i = 0;
  while (i < text.length) {
    let matched: EmoticonShortcut | null = null;
    for (const s of shortcuts) {
      if (s.shortcut && text.startsWith(s.shortcut, i)) { matched = s; break; }
    }
    if (matched) {
      if (buffer) { tokens.push({ text: buffer }); buffer = ''; }
      tokens.push({ shortcut: matched.shortcut, src: matched.src, custom: matched.custom });
      i += matched.shortcut.length;
    } else {
      buffer += text[i];
      i += 1;
    }
  }
  if (buffer) tokens.push({ text: buffer });
  return tokens;
}

/** Longueur d'un nœud en "unités texte" (une image vaut son raccourci, un <br> vaut 1). */
function richNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return stripRichZwsp(node.nodeValue || '').length;
  if (node.nodeName === 'IMG') return (node as HTMLElement).getAttribute('data-shortcut')?.length || 0;
  if (node.nodeName === 'BR') return 1;
  let len = 0;
  node.childNodes.forEach((c) => { len += richNodeLength(c); });
  return len;
}

/** Texte brut (raccourcis) correspondant au contenu du champ. */
function serializeRich(root: Node): string {
  let out = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) out += stripRichZwsp(node.nodeValue || '');
    else if (node.nodeName === 'IMG') out += (node as HTMLElement).getAttribute('data-shortcut') || '';
    else if (node.nodeName === 'BR') out += '\n';
    else if (node.nodeName === 'DIV' || node.nodeName === 'P') {
      const inner = serializeRich(node);
      if (out && !out.endsWith('\n')) out += '\n';
      out += inner;
    } else out += serializeRich(node);
  });
  return out;
}

/** Position du curseur, exprimée en unités texte. */
function getRichCaretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return serializeRich(root).length;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return serializeRich(root).length;
  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) { offset += stripRichZwsp((node.nodeValue || '').slice(0, range.startOffset)).length; }
      else if (node.nodeName === 'IMG' || node.nodeName === 'BR') { /* reste sur l'offset courant */ }
      else {
        let acc = 0;
        for (let i = 0; i < range.startOffset && i < node.childNodes.length; i++) acc += richNodeLength(node.childNodes[i]);
        offset += acc;
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'IMG' || node.nodeName === 'BR') {
      offset += richNodeLength(node);
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return offset;
}

/** Place le curseur à une position exprimée en unités texte. */
function setRichCaretOffset(root: HTMLElement, offset: number): void {
  const range = document.createRange();
  let acc = 0;
  let placed = false;
  const walk = (node: Node) => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || '';
      const len = stripRichZwsp(value).length;
      if (offset <= acc + len) {
        const target = offset - acc;
        let idx = 0;
        let count = 0;
        if (target > 0) {
          while (idx < value.length) {
            if (value[idx] !== RICH_ZWSP) { count += 1; if (count === target) { idx += 1; break; } }
            idx += 1;
          }
        }
        range.setStart(node, idx);
        placed = true;
        return;
      }
      acc += len;
      return;
    }
    if (node.nodeName === 'IMG') {
      const len = richNodeLength(node);
      if (offset <= acc + len) { range.setStartAfter(node); placed = true; return; }
      acc += len;
      return;
    }
    if (node.nodeName === 'BR') { acc += 1; return; }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  if (!placed) { range.selectNodeContents(root); range.collapse(false); }
  else range.collapse(true);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}

function createRichEmoticonImg(shortcut: string, src: string, custom: boolean): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  img.setAttribute('data-shortcut', shortcut);
  img.setAttribute('alt', shortcut);
  img.setAttribute('title', shortcut);
  img.className = custom ? 'custom-emoticon custom-emoticon-inline' : 'inline-emoticon';
  img.draggable = false;
  return img;
}

function renderRichTokens(root: HTMLElement, tokens: RichToken[]): void {
  const frag = document.createDocumentFragment();
  let endsWithNewline = false;
  for (const t of tokens) {
    if (hasShortcutKey(t)) {
      frag.appendChild(createRichEmoticonImg(t.shortcut, t.src, t.custom));
      endsWithNewline = false;
    } else if (t.text) {
      frag.appendChild(document.createTextNode(t.text));
      endsWithNewline = t.text.endsWith('\n');
    }
  }
  // Ancre invisible pour le curseur si le texte se termine par un saut de ligne.
  if (endsWithNewline) frag.appendChild(document.createTextNode(RICH_ZWSP));
  root.replaceChildren(frag);
}

/**
 * COMPOSANTS AUXILIAIRES
 */

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
  const [user, setUser] = useState<User | null>(null);
  const [isAuthInitializing, setIsAuthInitializing] = useState<boolean>(true);
  const [isDeviceRemembered, setIsDeviceRemembered] = useState<boolean>(false);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);

  // --- ÉTAT SOCKET & NAVIGATION ---
  const [socket, setSocket] = useState<Socket | null>(null);
  const [openChatIds, setOpenChatIds] = useState<number[]>(loadOpenChatIds);
  const [activeChatId, setActiveChatId] = useState<number>(loadActiveChatId);
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // --- ÉTAT DE VÉRIFICATION LOCALE DE SÉCURITÉ (PAR APPAREIL / NAVIGATEUR) ---
  // Stocké dans le coffre-fort d'appareil local IndexedDB ('WLM_DeviceVault_v1')
  const [verifiedContacts, setVerifiedContacts] = useState<Record<number, VerifiedContactRecord>>({});

  useEffect(() => {
    let isMounted = true;
    const initVerifiedContacts = async () => {
      try {
        await VerifiedContactsStorage.migrateFromLocalStorage();
        const records = await VerifiedContactsStorage.getAll();
        if (isMounted) {
          setVerifiedContacts(records);
        }
      } catch (err) {
        console.warn('[VerifiedContacts] Échec initialisation:', err);
      }
    };
    initVerifiedContacts();
    return () => { isMounted = false; };
  }, []);

  // Alerte si la clé d'un contact a changé par rapport à l'empreinte connue
  const [keyAlertContactId, setKeyAlertContactId] = useState<number | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState<boolean>(false);
  const [safetyModalContactId, setSafetyModalContactId] = useState<number | null>(null);
  const [activeFingerprint, setActiveFingerprint] = useState<string>('');
  const [myFingerprint, setMyFingerprint] = useState<string>('');

  // --- ÉTAT DU GLISSER-DÉPOSER DES ONGLETS DE DISCUSSION ---
  const [draggedTabId, setDraggedTabId] = useState<number | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<'left' | 'right' | null>(null);

  // --- SUPPORT PWA (INSTALLATION) ---
  const [canInstallPWA, setCanInstallPWA] = useState(false);
  useEffect(() => {
    const unsub = onInstallAvailabilityChange(setCanInstallPWA);
    return unsub;
  }, []);

  // --- ÉTAT DES MODALES & MENUS ---
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showResetE2EModal, setShowResetE2EModal] = useState(false);
  const [resetE2EPassword, setResetE2EPassword] = useState('');
  const [resetE2EError, setResetE2EError] = useState<string | null>(null);
  const [isResettingE2E, setIsResettingE2E] = useState(false);
  const [showBgModal, setShowBgModal] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showWinksModal, setShowWinksModal] = useState(false);
  const [showEmoticonMenu, setShowEmoticonMenu] = useState(false);
  const [showAllEmoticonsModal, setShowAllEmoticonsModal] = useState(false);
  const [showFontModal, setShowFontModal] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
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
  
  // Champ de saisie riche (contentEditable) : émoticônes rendues pendant la frappe
  const chatInputRef = useRef<HTMLDivElement>(null);

  // Fermer le menu émoticônes lors d'un clic / toucher à l'extérieur
  const emoticonContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showEmoticonMenu) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (emoticonContainerRef.current && !emoticonContainerRef.current.contains(e.target as Node)) {
        setShowEmoticonMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showEmoticonMenu]);


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
    if (activeContact?.their_private === 1 && !isPrivateMode[chatId]) {
      alert("Ce contact a activé le mode privé pour cette conversation. Vous ne pouvez pas le désactiver.");
      return;
    }
    const newState = !isPrivateMode[chatId];
    setIsPrivateMode(prev => ({ ...prev, [chatId]: newState }));
    privacyToggledAtRef.current[chatId] = Date.now();
    // Le contact peut garder la conversation privée de son côté
    const stillPrivate = newState || activeContact?.their_private === 1;

    // Notification système locale
    const systemMsg = {
      senderId: 0,
      receiverId: chatId,
      text: newState || !stillPrivate
        ? `Vous avez ${newState ? 'activé' : 'désactivé'} le mode privé. Les messages ${newState ? 'ne seront plus' : 'seront à nouveau'} enregistrés.`
        : `Vous avez désactivé le mode privé, mais votre contact le garde actif : les messages ne sont toujours pas enregistrés.`,
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

  // --- ÉTAT DES INTERACTIONS (Enregistrement vocal) ---
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const cancelRecordingRef = useRef(false);

  // --- ÉTAT DES MESSAGES & CONVERSATIONS ---
  const [messages, setMessages] = useState<Record<number, Message[]>>({});
  // Messages non lus par conversation : onglet qui clignote, contact mis en avant, titre de la page
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});

  // Messages courants lisibles hors rendu (fusion de l'historique avant écriture du cache local)
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [inputText, setInputText] = useState('');
  // Brouillons non envoyés, un par conversation (le champ de saisie est partagé entre onglets)
  const draftsRef = useRef<Record<number, string>>({});
  // Conversation à laquelle appartient le contenu actuel du champ (null = ne pas sauvegarder)
  const draftChatIdRef = useRef<number | null>(activeChatId);
  const inputTextRef = useRef(inputText);
  const [isGroupOpen, setIsGroupOpen] = useState(true);
  const [isOfflineGroupOpen, setIsOfflineGroupOpen] = useState(true);
  const [isServicesGroupOpen, setIsServicesGroupOpen] = useState(true);
  const [conversationBackgrounds, setConversationBackgrounds] = useState<Record<number, string>>(loadConversationBackgrounds);
  const [isPrivateMode, setIsPrivateMode] = useState<Record<number, boolean>>(loadPrivateModes);
  
  const [globalPrivateMode, setGlobalPrivateMode] = useState(() => {
    if (user && user.global_private !== undefined) return user.global_private === 1;
    return loadGlobalPrivateMode();
  });

  // Sauvegarde persistante du mode privé global
  useEffect(() => {
    saveGlobalPrivateMode(globalPrivateMode);
  }, [globalPrivateMode]);

  // Horodatage du dernier basculement local par conversation : évite qu'un
  // rafraîchissement des contacts parti AVANT l'écriture serveur n'annule le clic.
  const privacyToggledAtRef = useRef<Record<number, number>>({});

  // Sauvegarde persistante du mode privé
  useEffect(() => {
    savePrivateModes(isPrivateMode);
  }, [isPrivateMode]);

  const isPrivateModeRef = useRef(isPrivateMode);
  useEffect(() => { isPrivateModeRef.current = isPrivateMode; }, [isPrivateMode]);
  

  // --- ÉTAT DE LA SÉCURITÉ (E2E) ---
  const [publicKeysCache, setPublicKeysCache] = useState<Record<number, any>>({});
  const [myKeys, setMyKeys] = useState<{ publicKeyJwk: any; privateKeyJwk: any; privateKey?: CryptoKey; signingKey?: CryptoKey | null } | null>(null);
  const myKeysRef = useRef<{ publicKeyJwk: any; privateKeyJwk: any; privateKey?: CryptoKey; signingKey?: CryptoKey | null } | null>(null);
  useEffect(() => { myKeysRef.current = myKeys; }, [myKeys]);

  // ---- MESSAGES SIGNÉS (enveloppe v2) ----------------------------------------------
  // Référence toujours à jour vers getPublicKey (défini plus bas) : les handlers socket
  // sont enregistrés une seule fois et ne doivent pas capturer un cache figé.
  const getPublicKeyRef = useRef<(contactId: number, forceRefresh?: boolean) => Promise<JsonWebKey | null | undefined>>(async () => null);

  // Primitive E2EE (scellement, authentification, anti-rejeu, anti-rétrogradation).
  // Extraites dans un hook dédié ; les références sont injectées pour rester à jour.
  const {
    seenMidsRef,
    authenticateIncoming,
    sealForContact
  } = useMessageCrypto({
    myKeysRef,
    getPublicKeyRef,
    userId: user?.id,
    signingKeyMissingMessage: t.chat.signingKeyMissing
  });

  // Calcul automatique de ma propre empreinte locale de sécurité dès chargement des clés
  useEffect(() => {
    if (myKeys?.publicKeyJwk) {
      calculatePublicKeyFingerprint(myKeys.publicKeyJwk)
        .then(fp => setMyFingerprint(fp))
        .catch(console.error);
    }
  }, [myKeys]);

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

  // Domaine contacts (roster, invitations, menu contextuel) — extrait dans un hook dédié.
  const {
    contacts,
    setContacts,
    contactsRef,
    pendingInvites,
    searchQuery,
    setSearchQuery,
    contextMenu,
    setContextMenu,
    clearConfirmContactId,
    setClearConfirmContactId,
    clearNotice,
    setClearNotice,
    refreshData,
    handleBlockContact,
    handleDeleteContact,
    handleClearHistory,
    performClearHistory,
    handleContextMenu,
    handleInvite,
    handleAcceptInvite,
    handleDeclineInvite
  } = useContacts({
    user,
    setPublicKeysCache,
    setMessages,
    activeChatId,
    setActiveChatId,
    setOpenChatIds,
    setConversationBackgrounds,
    contactEmail,
    setContactEmail,
    setShowAddContactModal,
    clearHistoryErrorText: t.roster.clearHistoryError
  });

  // MODE PRIVÉ PAR CONVERSATION : l'état persisté côté serveur (renvoyé avec la liste
  // des contacts, rafraîchie au chargement puis périodiquement) fait autorité. On
  // resynchronise ainsi après une reconnexion sans dépendre des événements en direct.
  useEffect(() => {
    setIsPrivateMode(prev => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      contacts.forEach(c => {
        if (c.my_private === undefined) return;
        if (now - (privacyToggledAtRef.current[c.id] || 0) < 5000) return;
        const v = c.my_private === 1;
        if (!!prev[c.id] !== v) { next[c.id] = v; changed = true; }
      });
      return changed ? next : prev;
    });
  }, [contacts]);

  // Mode privé EFFECTIF par conversation (même règle que le serveur) : mon mode global,
  // celui du contact, ma préférence de conversation ou la sienne.
  const effectivePrivateModes = useMemo(() => {
    const map: Record<number, boolean> = { ...isPrivateMode };
    contacts.forEach(c => {
      map[c.id] = globalPrivateMode || !!isPrivateMode[c.id] || c.global_private === 1 || c.their_private === 1;
    });
    return map;
  }, [contacts, isPrivateMode, globalPrivateMode]);

  // Domaine jeux (partie active, invitations, reprise) — extrait dans un hook dédié.
  const {
    activeGame,
    setActiveGame,
    incomingGameInvite,
    setIncomingGameInvite,
    outgoingGameInvite,
    setOutgoingGameInvite,
    resumableGames,
    showGamesMenu,
    setShowGamesMenu,
    isGameMinimized,
    setIsGameMinimized,
    gameSummary,
    setGameSummary,
    refreshResumableGames,
    handleGameClose,
    handleGameMinimize,
    handleGameStateChange,
    handleInviteGame,
    handleAcceptGameInvite,
    handleDeclineGameInvite,
    handleCancelOutgoingInvite,
    handleQuitActiveGame
  } = useGames({
    socket,
    user,
    activeChatId,
    contacts,
    setMessages
  });

  // Domaine appels (WebRTC) — extrait dans un hook dédié.
  const {
    activeCallId,
    setActiveCallId,
    isReceivingCall,
    setIsReceivingCall,
    callSignal,
    setCallSignal,
    isAudioOnly,
    setIsAudioOnly,
    handleStartCall,
    handleEndCall
  } = useCalls({ user, activeChatId });

  // Domaine profil (identité, auto-absence, sécurité du compte) — hook dédié.
  const {
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
  } = useProfile({
    user,
    setUser,
    myKeysRef,
    setShowPasswordModal,
    setIsDeviceRemembered,
    setPersistenceNotice,
    forgetDeviceSuccessText: t.auth.forgetDeviceSuccess
  });

  // Traductions courantes lisibles depuis les handlers socket (enregistrés une fois par session)
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Statut courant lisible hors rendu (handshake socket à la reconnexion)
  const myStatusLiveRef = useRef(myStatus);
  useEffect(() => {
    myStatusLiveRef.current = myStatus;
    setPresenceForSounds(myStatus); // Options → Sons : « couper les sons en Occupé »
  }, [myStatus]);

  // Préférences locales (Options → Disposition, Messages, Sons)
  const appPrefs = useAppPrefs();

  // Conversation affichée ET fenêtre au premier plan : ses messages sont lus
  useEffect(() => {
    const markRead = () => {
      const id = activeChatIdRef.current;
      if (!id || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      setUnreadCounts(prev => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
    };
    markRead();
    window.addEventListener('focus', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [activeChatId]);

  // Titre de la page : nombre de messages non lus, comme une fenêtre qui clignote
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((n, c) => n + c, 0);
    document.title = total > 0 ? `(${total}) OpenWLM` : 'OpenWLM';
  }, [unreadCounts]);

  // Domaine clins d'œil & Wizz — extrait dans un hook dédié.
  const {
    activeWink,
    setActiveWink,
    winkCounter,
    setWinkCounter,
    isNudging,
    setIsNudging,
    handleSendWink,
    handleNudge,
    handleWinkFinish
  } = useWinksAndNudge({
    socket,
    user,
    activeChatId,
    myNickname,
    myKeys,
    getPublicKey: (id, force) => getPublicKeyRef.current(id, force),
    sealForContact,
    globalPrivateMode,
    isPrivateMode,
    setMessages,
    setShowWinksModal,
    winkNotSentNetworkText: t.chat.winkNotSentNetwork,
    winkNotSentOfflineText: t.chat.winkNotSentOffline
  });

  // Domaine notifications (toasts, notifications système, Web Push) — hook dédié.
  const {
    enableDesktopToasts,
    setEnableDesktopToasts,
    toasts,
    addToast,
    dismissToast,
    handleToastOpenChat,
    systemPermission,
    prepromptDismissed,
    setPrepromptDismissed,
    permissionAttempted,
    testAlertFeedback,
    pushStatus,
    pushTestFeedback,
    handleRequestPermission,
    handleTestAlert,
    handleTestPush
  } = useNotifications({
    user,
    showOptionsModal,
    setOpenChatIds,
    setActiveChatId
  });

  // --- PURGE PROACTIVE DU STOCKAGE LOCAL (HYGIÈNE STRICTE) ---
  useEffect(() => {
    try {
      const FORBIDDEN_STORAGE_KEYS = [
        'token',
        'encrypted_private_key',
        'encryptedPrivateKey',
        'vault',
        'vaultKey',
        'privateKey',
        'privateKeyJwk',
        'privateCryptoKey',
        'public_key',
        'publicKey'
      ];
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (
          k.startsWith('wlm_priv_') || 
          k.startsWith('wlm_keys_') || 
          k.startsWith('wlm_pub_') ||
          k.startsWith('wlm_vault_') ||
          FORBIDDEN_STORAGE_KEYS.includes(k)
        )) {
          localStorage.removeItem(k);
        }
      }
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && (
          k.startsWith('wlm_priv_') || 
          k.startsWith('wlm_keys_') || 
          k.startsWith('wlm_pub_') ||
          k.startsWith('wlm_vault_') ||
          FORBIDDEN_STORAGE_KEYS.includes(k)
        )) {
          sessionStorage.removeItem(k);
        }
      }

      // Vérifier et nettoyer wlm_user s'il contient des champs interdits
      const rawUser = localStorage.getItem('wlm_user');
      if (rawUser) {
        try {
          const parsed = JSON.parse(rawUser);
          if (parsed && typeof parsed === 'object') {
            const sanitized = sanitizeUserForStorage(parsed);
            if (Object.keys(parsed).some(k => !['id', 'username', 'nickname', 'avatar', 'scene', 'status', 'rememberMe'].includes(k))) {
              localStorage.setItem('wlm_user', JSON.stringify(sanitized));
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn("[Sécurité] Nettoyage stockage résiduel:", e);
    }
  }, []);

  // --- RESTAURATION DE LA SESSION PERSISTANTE E2EE AU DÉMARRAGE ---
  useEffect(() => {
    let isCancelled = false;

    const restorePersistentSession = async () => {
      try {
        const savedUserStr = localStorage.getItem('wlm_user');

        if (!savedUserStr) {
          if (!isCancelled) setIsAuthInitializing(false);
          return;
        }

        const savedUser: Partial<User> = JSON.parse(savedUserStr);
        if (!savedUser || !savedUser.id || !savedUser.rememberMe) {
          if (!isCancelled) setIsAuthInitializing(false);
          return;
        }

        // 1. Tenter de synchroniser la session avec le serveur via le cookie HttpOnly
        let sessionToken = '';
        let serverUser: any = null;
        try {
          const res = await axios.get('/api/user/me');
          if (res.data && res.data.success && res.data.user) {
            serverUser = res.data.user;
            sessionToken = res.data.token || '';
          }
        } catch (authErr) {
          console.warn("[E2EE Session] Session serveur expirée ou invalide:", authErr);
        }

        if (!serverUser) {
          console.warn("[E2EE Session] Session expirée ou invalide côté serveur.");
          localStorage.removeItem('wlm_user');
          if (!isCancelled) setIsAuthInitializing(false);
          return;
        }

        if (sessionToken) {
          axios.defaults.headers.common['Authorization'] = `Bearer ${sessionToken}`;
        }

        // 2. Tenter de récupérer les clés E2EE persistées dans IndexedDB
        const keyRes = await E2EEKeyStorage.getKeys(savedUser.id);
        if (keyRes.success && keyRes.data) {
          const { publicKeyJwk, privateCryptoKey } = keyRes.data;

          // Vérification de concordance avec la clé publique du profil serveur
          let isKeyMatch = true;
          if (serverUser.public_key) {
            try {
              const serverPub = typeof serverUser.public_key === 'string'
                ? JSON.parse(serverUser.public_key)
                : serverUser.public_key;
              if (JSON.stringify(serverPub) !== JSON.stringify(publicKeyJwk)) {
                console.warn("[E2EE Session] Clé locale désynchronisée de la clé publique serveur.");
                isKeyMatch = false;
              }
            } catch {
              isKeyMatch = false;
            }
          }

          // Enregistrements d'appareil antérieurs à la signature des messages : pas de clé
          // RSA-PSS. Sans elle, impossible d'envoyer des messages signés → reconnexion
          // (le mot de passe permet de la recréer depuis le coffre).
          if (isKeyMatch && !keyRes.data.signingCryptoKey) {
            console.warn("[E2EE Session] Clé de signature absente de cet appareil : reconnexion requise.");
            isKeyMatch = false;
          }

          if (isKeyMatch) {
            console.log("[E2EE Session] Session et clés restaurées avec succès depuis cet appareil.");
            if (!isCancelled) {
              setMyKeys({
                publicKeyJwk,
                privateKey: privateCryptoKey,
                privateKeyJwk: privateCryptoKey as any,
                signingKey: keyRes.data.signingCryptoKey ?? null
              });
              setUser({ ...serverUser, token: sessionToken, rememberMe: true });
              setIsDeviceRemembered(true);
            }
            localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage({ ...serverUser, rememberMe: true })));
          } else {
            console.warn("[E2EE Session] Clés locales périmées, nettoyage de la persistance.");
            await E2EEKeyStorage.removeKeys(savedUser.id);
            localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage({ ...serverUser, rememberMe: false })));
            if (!isCancelled) {
              setUser({ ...serverUser, token: sessionToken, rememberMe: false });
              setIsDeviceRemembered(false);
            }
          }
        } else {
          console.warn("[E2EE Session] Clés locales introuvables ou corrompues:", keyRes.error);
          localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage({ ...serverUser, rememberMe: false })));
          if (!isCancelled) {
            setUser({ ...serverUser, token: sessionToken, rememberMe: false });
            setIsDeviceRemembered(false);
          }
        }
      } catch (err) {
        console.error("[E2EE Session] Erreur lors de la restauration de la session:", err);
        localStorage.removeItem('wlm_user');
      } finally {
        if (!isCancelled) {
          setIsAuthInitializing(false);
        }
      }
    };

    restorePersistentSession();

    return () => {
      isCancelled = true;
    };
  }, []);

  // Auto-effacement du message de notification de persistance après 8s
  useEffect(() => {
    if (!persistenceNotice) return;
    const timer = setTimeout(() => {
      setPersistenceNotice(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [persistenceNotice]);

  /**
   * INITIALISATION ZERO-KNOWLEDGE LORS DE LA CONNEXION
   * 1. Reçoit loggedInUser et vaultKey (CryptoKey AES-GCM 256 bits non exportable).
   * 2. Déchiffre ou génère la paire de clés RSA.
   * 3. Importe la clé privée RSA en CryptoKey NON EXTRACTIBLE (extractable: false).
   * 4. Si rememberMe est coché : tente la persistance sécurisée dans IndexedDB.
   *    EXIGENCE ABSOLUE : Si la persistance échoue, la connexion RÉUSSIT quand même sans blocage.
   */
  const handleUserLogin = async (loggedInUser: any, vaultKey: CryptoKey, authKeyHex: string) => {
    // Statut CHOISI sur l'écran de connexion (pas le statut renvoyé par le serveur) : devient
    // la préférence de ce compte sur cet appareil
    if (isPresenceStatus(loggedInUser?.loginStatus)) savePreferredStatus(loggedInUser.id, loggedInUser.loginStatus);
    if (loggedInUser.token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${loggedInUser.token}`;
    }

    try {
      let pubJwk: JsonWebKey;
      let privJwk: JsonWebKey | null = null;

      if (loggedInUser.encrypted_private_key) {
        console.log("[Zero-Knowledge] Déchiffrement du coffre de clés privées...");
        const vault = typeof loggedInUser.encrypted_private_key === 'string'
          ? JSON.parse(loggedInUser.encrypted_private_key)
          : loggedInUser.encrypted_private_key;

        privJwk = await decryptPrivateKeyVault(vault.encryptedKeyBase64, vault.ivBase64, vaultKey);
        if (!privJwk) {
          alert("Échec du déchiffrement du coffre de clés privées. Mot de passe incorrect ou coffre altéré.");
          return;
        }

        pubJwk = typeof loggedInUser.public_key === 'string'
          ? JSON.parse(loggedInUser.public_key)
          : loggedInUser.public_key;
      } else {
        console.log("[Zero-Knowledge] Génération de la première paire de clés RSA...");
        const keyPair = await generateKeyPair();
        pubJwk = keyPair.publicKeyJwk;
        privJwk = keyPair.privateKeyJwk;

        const vault = await encryptPrivateKeyVault(privJwk, vaultKey);
        // Preuve du mot de passe exigée par le serveur, même pour la première installation
        await axios.post('/api/user/keys', {
          userId: loggedInUser.id,
          publicKey: pubJwk,
          encryptedPrivateKey: vault,
          authKeyHex
        });
        loggedInUser.public_key = pubJwk;
        loggedInUser.encrypted_private_key = vault;
      }

      // Importation de la clé privée en CryptoKey native NON EXTRACTIBLE (protection anti-XSS)
      const privateCryptoKey = await importPrivateCryptoKey(privJwk, false);
      // Clé de signature (RSA-PSS) dérivée du MÊME matériel RSA — également non extractible.
      // Sert à authentifier la signalisation des appels (anti-MITM). Peut être null si non supporté.
      const signingKey = await importPrivateKeyForSigning(privJwk);

      const keys = {
        publicKeyJwk: pubJwk,
        privateKey: privateCryptoKey,
        privateKeyJwk: privateCryptoKey as any,
        signingKey
      };

      // 1. Initialisation de la session en mémoire vive
      setMyKeys(keys);
      setUser(loggedInUser);

      // 2. Gestion de la persistance locale sur cet appareil
      if (loggedInUser.rememberMe) {
        try {
          const saveRes = await E2EEKeyStorage.saveKeys(
            loggedInUser.id,
            loggedInUser.username,
            pubJwk,
            privateCryptoKey,
            signingKey ?? undefined
          );

          if (saveRes.success) {
            localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage({ ...loggedInUser, rememberMe: true })));
            setIsDeviceRemembered(true);
            setPersistenceNotice(t.auth.deviceRememberedSuccess);
          } else {
            console.warn("[E2EE Storage] Échec persistance locale:", saveRes.error);
            // EXIGENCE UX ABSOLUE : La connexion n'est JAMAIS bloquée par l'échec de persistance
            localStorage.removeItem('wlm_user');
            setIsDeviceRemembered(false);
            setPersistenceNotice(t.auth.rememberPersistenceFailed);
          }
        } catch (saveErr) {
          console.warn("[E2EE Storage] Exception persistance locale:", saveErr);
          localStorage.removeItem('wlm_user');
          setIsDeviceRemembered(false);
          setPersistenceNotice(t.auth.rememberPersistenceFailed);
        }
      } else {
        // Case non cochée : purge stricte de tout stockage durable pour cet utilisateur
        try {
          await E2EEKeyStorage.removeKeys(loggedInUser.id);
        } catch {}
        localStorage.removeItem('wlm_user');
        setIsDeviceRemembered(false);
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
          if (res.data.token) {
            currentUser.token = res.data.token;
            axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
          }
          setUser(currentUser);
          
          if (currentUser.global_private !== undefined) {
            setGlobalPrivateMode(currentUser.global_private === 1);
          }

          if (currentUser.rememberMe) {
            localStorage.setItem('wlm_user', JSON.stringify(sanitizeUserForStorage(currentUser)));
          }
        }
      } catch (err) {
        const r = (err as { response?: { status?: number; data?: { code?: string } } }).response;
        if (r?.status === 401 && r.data?.code === 'session_revoked') {
          // Session révoquée depuis un autre appareil : retour à l'écran de connexion
          await handleLogoutRef.current?.('session_revoked', { local: true });
          return;
        }
        console.warn("[Session] Impossible de synchroniser le profil:", err);
      }

      setMyNickname(currentUser.nickname || currentUser.username || 'Utilisateur');
      setMyPSM(currentUser.psm || 'Disponible');
      setMyAvatar(currentUser.avatar || '/assets/usertiles/chess.png');
      setMyScene(currentUser.scene || '/assets/scenes/0006.png');
      // Statut : dernier choix manuel mémorisé sur CET appareil (jamais l'absence automatique) ;
      // sans préférence locale (autre appareil, stockage vidé), on garde le statut actuel du
      // serveur s'il est en ligne (choisi sur un autre appareil encore connecté), sinon
      // « Disponible ». Le serveur (et donc les contacts) est aligné s'il diffère.
      const serverStatus = isPresenceStatus(currentUser.status) && currentUser.status !== 'offline' ? currentUser.status : null;
      const storedStatus = loadPreferredStatus(currentUser.id);
      const wantedStatus = storedStatus ?? serverStatus ?? 'online';
      // Première session sur cet appareil : on mémorise le statut adopté, pour qu'un futur
      // redémarrage pendant une absence automatique revienne bien à ce statut (l'absence
      // automatique n'est jamais mémorisée)
      if (!storedStatus) savePreferredStatus(currentUser.id, wantedStatus);
      setMyStatus(wantedStatus);
      if (currentUser.status !== wantedStatus) {
        axios.post('/api/user/update', { userId: currentUser.id, status: wantedStatus }).catch(() => { /* resynchronisé à la reconnexion */ });
      }
    };

    syncAndInit();
  }, [user?.id, !!myKeys]);

    /**
   * PERSISTENCE DE LA NAVIGATION
   */
  useEffect(() => {
    saveOpenChatIds(openChatIds);
  }, [openChatIds]);

  useEffect(() => {
    saveActiveChatId(activeChatId);
  }, [activeChatId]);

  /**
   * ASSAINISSEMENT DES ONGLETS OUVERTS LORS DE LA RESTAURATION
   * Si des contacts enregistrés dans localStorage n'existent plus lors du rechargement,
   * ils sont filtrés proprement sans altérer l'ordre des onglets valides.
   */
  useEffect(() => {
    if (contacts && contacts.length > 0) {
      setOpenChatIds(prev => {
        const contactIds = contacts.map(c => c.id);
        const sanitized = sanitizeOpenChatIds(prev, contactIds, SYSTEM_BOT_ID);
        if (sanitized.length !== prev.length) {
          return sanitized;
        }
        return prev;
      });
    }
  }, [contacts]);

  useEffect(() => {
    if (activeChatId !== 0 && activeChatId !== SYSTEM_BOT_ID && contacts && contacts.length > 0) {
      if (!contacts.some(c => c.id === activeChatId)) {
        setActiveChatId(openChatIds.length > 0 ? openChatIds[0] : 0);
      }
    }
  }, [contacts, activeChatId, openChatIds]);

  /**
   * ENREGISTREMENT ET DÉCHIFFREMENT ASYNCHRONE DES ÉMOTICÔNES PERSONNALISÉES REÇUES
   */
  const registerReceivedCustomEmoticons = useCallback(async (
    receivedMap: Record<string, CustomEmoticonPayload>
  ) => {
    if (!receivedMap || typeof receivedMap !== 'object') return;
    const token = user?.token;

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
            await CustomEmoticonsDB.saveCachedAsset(info.assetId, decryptedBlob, info.mime || 'image/png');
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
      // Le cookie HttpOnly suffit : user.token est souvent absent
      const token = user.token;
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
      try {
        const res = await axios.get('/api/emoticons/custom/my', { headers: authHeaders });
        if (res.data && res.data.success && Array.isArray(res.data.emoticons)) {
          serverRecords = res.data.emoticons;
        }
      } catch (err) {
        console.warn("Erreur chargement serveur émoticônes custom:", err);
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
        if (!cachedBlob && keyBase64) {
          try {
            const assetRes = await axios.get(`/api/emoticons/custom/asset/${item.id}`, {
              responseType: 'arraybuffer',
              headers: authHeaders
            });
            if (assetRes.data) {
              const decrypted = await decryptCustomEmoticon(assetRes.data, keyBase64, record.mimeType);
              if (decrypted) {
                await CustomEmoticonsDB.saveCachedAsset(item.id, decrypted, record.mimeType);
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
  const decryptMessageArray = useCallback(async (msgs: any[]) => {
    const results: Message[] = [];
    const seenInHistory = new Set<string>();
    for (const m of msgs) {
      let decryptedText = '';
      let decryptedAudio: string | null = null;
      let decryptedStyle: any = null;
      let fileData: FileDataPayload | undefined;

      // AUTHENTIFICATION + DÉCHIFFREMENT (enveloppe signée v2). Les anciens messages
      // (v1, avant les signatures) restent lisibles mais sont signalés « non vérifiés ».
      const opened = await authenticateIncoming(
        m.text,
        Number(m.sender_id ?? m.senderId),
        Number(m.receiver_id ?? m.receiverId),
        Number(user?.id)
      );
      // Anti-rejeu : un même message signé n'apparaît qu'une fois dans l'historique
      if (opened.mid) {
        if (seenInHistory.has(opened.mid)) continue;
        seenInHistory.add(opened.mid);
        seenMidsRef.current.add(opened.mid);
      }
      const payload = DISPLAYABLE_AUTH.has(opened.status) ? (opened.payload as any) : null;
      if (payload) {
        if (payload.type === 'file' && payload.fileId) {
          decryptedText = `[Fichier] ${payload.fileName || 'Fichier partagé'}`;
          fileData = payload;
        } else {
          decryptedText = payload.text ?? '';
        }
        if (payload.audio) decryptedAudio = payload.audio;
        if (payload.style) decryptedStyle = payload.style;
        if (payload.customEmoticons) {
          registerReceivedCustomEmoticons(payload.customEmoticons);
        }
      }

      const isSender = resolveMessageSide(m, user?.id) === 'self';
      const formattedTime = formatMessageTime(m.timestamp, m.time);
      const contactObj = contactsRef.current.find(c => c.id === (m.sender_id || m.senderId));
      const contactResolvedName = contactObj ? (contactObj.nickname || contactObj.username) : null;

      const finalSender = isSender
        ? (myNickname || user?.nickname || user?.username || 'Moi')
        : (contactResolvedName || m.sender_name || (m.sender && m.sender !== 'Contact' ? m.sender : null) || 'Contact');

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
        fileData: fileData,
        delivery_status: m.delivery_status || 'sent',
        type: payload?.type || 'text',
        _auth: opened.status,
        mid: opened.mid
      });
    }
    return results;
  }, [user?.id, user?.nickname, user?.username, myNickname, authenticateIncoming]);

  /**
   * CHARGEMENT DE L'HISTORIQUE D'UNE CONVERSATION (UNIFIÉ SANS DOUBLON)
   */
  const loadChatHistory = useCallback(async (chatId: number, opts?: { incremental?: boolean }) => {
    // incremental : rattrapage après coupure — on AJOUTE seulement les messages manquants
    // sans remplacer la liste (qui peut contenir des messages privés ou système locaux).
    const incremental = !!opts?.incremental;
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
      // Copie locale lue au préchargement : base de la fusion si aucun rendu n'a encore
      // reporté ces messages dans messagesRef (sinon ils manqueraient dans la copie réécrite)
      let cachedBase: Message[] = [];
      // 1. Préchargement du cache local rapide (IndexedDB) — sauf si l'option est désactivée
      if (!incremental && getAppPrefs().messages.keepLocalHistory) try {
        const cached = await LocalDB.getMessages<Message>(`${user.id}_${chatId}`, keys.privateKeyJwk);
        if (cached && cached.length > 0) {
          // Le cache local contient des messages DÉJÀ authentifiés et déchiffrés (chiffrés
          // localement) : on ne les ré-ouvre pas. Seules les entrées vérifiées sont reprises ;
          // celles d'un ancien client (sans verdict, ou non signées) attendent la synchro
          // serveur ci-dessous, qui les refusera si elles ne sont pas signées.
          const decryptedCached: Message[] = cached
            .filter(m => m._auth === 'verified')
            .map(m => ({ ...m, time: formatMessageTime(m.timestamp, m.time) }));
          cachedBase = decryptedCached;
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
          const serverMsgs = await decryptMessageArray(res.data);
          // Les messages indéchiffrables (ex. chiffrés pour une ancienne clé) restent masqués ;
          // les messages rejetés (signature invalide, texte clair) sont AFFICHÉS comme tels.
          const validServerMsgs = serverMsgs.filter(m => m._auth !== 'undecryptable');

          if (incremental) {
            setMessages(prev => {
              const currentMsgs = prev[chatId] || [];
              const knownIds = new Set(currentMsgs.map(m => m.id).filter(Boolean));
              const knownMids = new Set(currentMsgs.map(m => m.mid).filter(Boolean));
              const serverById = new Map(validServerMsgs.filter(m => m.id).map(m => [m.id, m]));
              let changed = false;
              // Statuts (remis / lu) mis à jour pendant la coupure
              const updated = currentMsgs.map(m => {
                const srv = m.id ? serverById.get(m.id) : undefined;
                if (srv && srv.delivery_status && srv.delivery_status !== m.delivery_status) {
                  changed = true;
                  return { ...m, delivery_status: srv.delivery_status };
                }
                return m;
              });
              const missing = validServerMsgs.filter(m =>
                (!m.id || !knownIds.has(m.id)) && (!m.mid || !knownMids.has(m.mid))
              );
              if (missing.length === 0 && !changed) return prev;
              return { ...prev, [chatId]: [...updated, ...missing] };
            });
          } else {
            // Historique serveur + ce qui n'existe que sur l'appareil (messages privés, lignes
            // système, envois en cours) : rien de local n'est plus écrasé par le rechargement
            const baseFor = (current: Message[] | undefined) => withLocalOnly(current || [], cachedBase);
            setMessages(prev => ({ ...prev, [chatId]: mergeServerHistory(baseFor(prev[chatId]), validServerMsgs) }));
            // Copie locale chiffrée : historique serveur ET messages privés (sinon perdus au
            // rechargement, puisque le serveur ne les a jamais eus). Calculée avec la même base
            // que l'affichage, copie lue au préchargement comprise.
            if (getAppPrefs().messages.keepLocalHistory) {
              const merged = mergeServerHistory(baseFor(messagesRef.current[chatId]), validServerMsgs);
              await LocalDB.setHistory(`${user.id}_${chatId}`, cacheableHistory(merged), keys.publicKeyJwk);
            }
          }
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
  // Seuls les onglets NOUVELLEMENT ouverts sont chargés : recharger tous les onglets à
  // chaque ouverture effaçait les messages locaux (mode privé, lignes système) des autres.
  const autoLoadedChatsRef = useRef<Set<number>>(new Set());
  useEffect(() => { autoLoadedChatsRef.current = new Set(); }, [user?.id]);
  useEffect(() => {
    const loaded = autoLoadedChatsRef.current;
    loaded.forEach(id => { if (!openChatIds.includes(id)) loaded.delete(id); });
    if (user && myKeys && openChatIds.length > 0) {
      openChatIds.forEach(id => {
        if (loaded.has(id)) return;
        loaded.add(id);
        loadChatHistory(id);
      });
    }
  }, [user, !!myKeys, JSON.stringify(openChatIds), loadChatHistory]);

  /**
   * RATTRAPAGE APRÈS COUPURE
   * Un message reçu pendant que le socket était coupé (mobile en veille, réseau perdu)
   * est bien stocké côté serveur mais n'est jamais poussé en direct : sans rattrapage,
   * il n'apparaissait qu'en rouvrant la conversation. On recharge donc l'historique des
   * onglets ouverts à chaque reconnexion du socket et au retour au premier plan.
   */
  const openChatIdsRef = useRef(openChatIds);
  useEffect(() => { openChatIdsRef.current = openChatIds; }, [openChatIds]);
  const lastResyncRef = useRef(0);

  // Conversations NON ouvertes ayant reçu des messages pendant la coupure (ou avant la
  // connexion) : on ouvre leurs onglets, comme le ferait un message reçu en direct.
  const fetchPendingConversations = useCallback(async () => {
    if (!user) return;
    try {
      const res = await axios.get('/api/conversations/pending');
      if (!Array.isArray(res.data)) return;
      const ids: number[] = res.data
        .map((r: { contactId?: unknown }) => Number(r.contactId))
        .filter((id: number) => Number.isInteger(id) && id > 0);
      if (ids.length === 0) return;
      setOpenChatIds(prev => {
        const added = ids.filter(id => !prev.includes(id));
        return added.length > 0 ? [...prev, ...added] : prev;
      });
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        setActiveChatId(prev => (prev === 0 ? ids[0] : prev));
      }
    } catch (err) {
      console.warn("[Sync] Impossible de récupérer les conversations en attente:", err);
    }
  }, [user]);

  // Au démarrage de la session (clés E2EE prêtes)
  useEffect(() => {
    if (user && myKeys) fetchPendingConversations();
  }, [user, myKeys, fetchPendingConversations]);

  const resyncOpenChats = useCallback((force = false) => {
    const now = Date.now();
    // visibilitychange + pageshow arrivent souvent ensemble : un seul rechargement
    if (!force && now - lastResyncRef.current < 1500) return;
    lastResyncRef.current = now;
    const ids = new Set(openChatIdsRef.current);
    if (activeChatIdRef.current) ids.add(activeChatIdRef.current);
    ids.forEach(id => { if (id !== SYSTEM_BOT_ID) loadChatHistory(id, { incremental: true }); });
    fetchPendingConversations();
  }, [loadChatHistory, fetchPendingConversations]);
  const resyncOpenChatsRef = useRef(resyncOpenChats);
  // Appel en cours ou en sonnerie, lisible depuis les handlers socket
  const activeCallIdRef = useRef<number | null>(null);
  useEffect(() => { activeCallIdRef.current = activeCallId; }, [activeCallId]);
  // Déconnexion lisible depuis les handlers socket (enregistrés une fois par session)
  const handleLogoutRef = useRef<((reason?: string, opts?: { local?: boolean }) => Promise<void>) | null>(null);
  useEffect(() => { resyncOpenChatsRef.current = resyncOpenChats; }, [resyncOpenChats]);

  useEffect(() => {
    if (!user) return;
    const onVisible = () => { if (document.visibilityState === 'visible') resyncOpenChatsRef.current(); };
    const onResume = () => resyncOpenChatsRef.current();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [user]);

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
      // Statut demandé au serveur à chaque (re)connexion : préférence mémorisée à la
      // première connexion de la session, puis le statut courant (absence auto comprise).
      let socketConnectedOnce = false;
      const newSocket = io({
        auth: (cb) => cb({
          token: user.token,
          // Sans préférence locale : rien n'est imposé, le serveur garde le statut en cours
          status: socketConnectedOnce ? myStatusLiveRef.current : (loadPreferredStatus(user.id) ?? undefined)
        })
      });
      newSocket.on('connect', () => { socketConnectedOnce = true; });

      let hasConnectedOnce = false;
      // Fenêtre de silence après notre propre (re)connexion : les contacts qui se
      // reconnectent en masse (ex. redémarrage du serveur) ne déclenchent pas une rafale.
      let signInQuietUntil = Date.now() + 10000;
      // SESSION RÉVOQUÉE (« Déconnecter mes autres sessions », changement de mot de passe,
      // déconnexion sur un autre appareil) : le serveur coupe la connexion temps réel. Un autre
      // onglet du MÊME navigateur partage le cookie, qui vient peut-être d'être renouvelé : on
      // vérifie donc la session avant tout. Valide → simple reconnexion ; révoquée → retour à
      // l'écran de connexion, sans appeler /api/logout (qui révoquerait la session des autres).
      let checkingSession = false;
      const verifySessionOrLogout = async () => {
        if (checkingSession) return;
        checkingSession = true;
        try {
          await axios.get('/api/user/me');
          if (!newSocket.connected) newSocket.connect();
        } catch (err) {
          const r = (err as { response?: { status?: number; data?: { code?: string } } }).response;
          if (r?.status === 401 && r.data?.code === 'session_revoked') {
            await handleLogoutRef.current?.('session_revoked', { local: true });
          }
        } finally {
          checkingSession = false;
        }
      };
      newSocket.on('session_revoked', () => { verifySessionOrLogout(); });
      newSocket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
        if (err?.data?.code === 'session_revoked') verifySessionOrLogout();
      });

      newSocket.on('connect', () => {
        signInQuietUntil = Date.now() + 10000;
        refreshResumableGames();
        // Reconnexion : récupérer ce qui a été reçu pendant la coupure
        if (hasConnectedOnce) resyncOpenChatsRef.current(true);
        hasConnectedOnce = true;
      });

      // Réception d'un message (texte ou audio, éventuellement chiffré)
      newSocket.on('receive_message', async (data) => {
        const senderId = data.senderId || data.sender_id;
        const isSender = resolveMessageSide({ senderId, sender_id: senderId }, user.id) === 'self';
        // AUTHENTIFICATION + DÉCHIFFREMENT (enveloppe signée v2)
        const myIdNum = Number(user.id);
        const senderIdNum = Number(senderId);
        const opened = await authenticateIncoming(data.text, senderIdNum, Number(data.receiverId ?? data.receiver_id), myIdNum);
        const authStatus: EnvelopeStatus = opened.status;
        if (authStatus !== 'verified') {
          console.warn(`[Security] Message ${data.id ?? ''} de ${senderIdNum} : ${authStatus}${opened.reason ? ' (' + opened.reason + ')' : ''}`);
        }

        // Anti-rejeu : un même message signé (mid) n'est accepté qu'une fois
        if (opened.mid) {
          if (seenMidsRef.current.has(opened.mid)) {
            console.warn(`[Security] Message rejoué ignoré (mid ${opened.mid}).`);
            return;
          }
          seenMidsRef.current.add(opened.mid);
        }

        // Seuls les champs de contenu du payload sont repris (sanitizeDecryptedPayload) :
        // il ne peut pas écraser id, senderId, timestamp, delivery_status…
        const payload = DISPLAYABLE_AUTH.has(authStatus) ? (opened.payload as any) : null;
        let decryptedData: any = { ...data, text: '', audio: null, style: null };
        let fileData: FileDataPayload | undefined;
        if (payload) {
          decryptedData = { ...decryptedData, ...payload };
          if (payload.type === 'file' && payload.fileId) {
            fileData = payload;
            decryptedData.text = `[Fichier] ${payload.fileName || 'Fichier partagé'}`;
          }
          if (payload.customEmoticons) {
            registerReceivedCustomEmoticons(payload.customEmoticons);
          }
        }

        // MULTI-SESSION : si le message vient d'une autre session du compte courant (isSender),
        // la conversation concernée est celle du destinataire, pas la nôtre.
        const receiverId = data.receiverId ?? data.receiver_id;
        const conversationContactId: number = isSender ? receiverId : senderId;

        // Résolution précise du nom réel de l'expéditeur (Carnet de contacts > Payload E2EE > Socket Server)
        const contactFromList = contactsRef.current.find(c => c.id === conversationContactId);
        const contactResolvedName = contactFromList ? (contactFromList.nickname || contactFromList.username) : null;
        const finalSenderName = isSender
          ? (myNickname || user?.nickname || user?.username || 'Moi')
          : (contactResolvedName || data.sender || data.sender_name || 'Contact');

        // Mise à jour de l'interface
        setOpenChatIds(prev => prev.includes(conversationContactId) ? prev : [...prev, conversationContactId]);
        if (!isSender && typeof window !== 'undefined' && window.innerWidth <= 768) {
          setActiveChatId(prev => prev === 0 ? conversationContactId : prev);
        }

        const formattedTime = formatMessageTime(decryptedData.timestamp, decryptedData.time);
        const finalMsg: Message = { 
          ...decryptedData, 
          id: decryptedData.id,
          sender_id: senderId,
          senderId: senderId,
          receiver_id: isSender ? receiverId : user?.id,
          receiverId: isSender ? receiverId : user?.id,
          sender: finalSenderName,
          time: formattedTime,
          timestamp: decryptedData.timestamp || new Date().toISOString(),
          fileData: fileData || (decryptedData.type === 'file' && decryptedData.fileId ? decryptedData : undefined),
          _auth: authStatus,
          mid: opened.mid
        };

        setMessages(prev => {
          const currentMsgs = prev[conversationContactId] || [];
          if (finalMsg.id && currentMsgs.some(m => m.id === finalMsg.id)) {
            return prev;
          }
          return {
            ...prev,
            [conversationContactId]: [...currentMsgs, finalMsg]
          };
        });

        // Sauvegarde locale dans IndexedDB (Chiffré)
        if (myKeysRef.current) {
          if (getAppPrefs().messages.keepLocalHistory) LocalDB.saveMessage(`${user?.id}_${conversationContactId}`, finalMsg, myKeysRef.current.publicKeyJwk).catch(console.error);
        }

        // Accusé de réception ("remis") émis par la session destinataire vers le serveur
        if (!isSender && finalMsg.id) {
          newSocket.emit('message_delivered', {
            messageId: finalMsg.id,
            senderId: senderId,
            isPrivate: !!decryptedData.isPrivate
          });

          // Si la conversation est activement ouverte, visible et focalisée : accusé de lecture immédiat
          const isAppFocused = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
          if (activeChatIdRef.current === senderId && isAppFocused) {
            newSocket.emit('message_read', {
              contactId: senderId,
              lastReadMessageId: finalMsg.id,
              isPrivate: !!decryptedData.isPrivate
            });
          }
        }

        // Message envoyé depuis une autre de nos sessions : synchronisation silencieuse
        // (pas de son, pas de wizz/wink rejoué, pas de notification).
        if (isSender) return;

        // Déclenchement des actions spéciales si chiffré
        if (decryptedData.type === 'wink' && decryptedData.winkId) {
          handleSendWink(decryptedData.winkId, true, senderId);
        } else if (decryptedData.type === 'nudge') {
          handleNudge(true, senderId);
        } else {
          SoundManager.play('NEW_MESSAGE');
        }

        // --- GESTION DES NOTIFICATIONS (TOAST DESKTOP & SYSTÈME) ---
        const isAppVisible = typeof document !== 'undefined' && 
                             document.visibilityState === 'visible' && 
                             document.hasFocus();

        // Non lu tant que la conversation n'est pas affichée sous les yeux de l'utilisateur
        if (!(isAppVisible && activeChatIdRef.current === conversationContactId)) {
          setUnreadCounts(prev => ({ ...prev, [conversationContactId]: (prev[conversationContactId] || 0) + 1 }));
        }
        const isDesktop = typeof window !== 'undefined' && window.innerWidth > 768;
        const hasSystemPermission = typeof Notification !== 'undefined' && Notification.permission === 'granted';

        const decision = decideNotificationType({
          isSender,
          senderId,
          activeChatId: activeChatIdRef.current,
          isAppVisible,
          isDesktop,
          hasSystemPermission
        });

        let previewText = decryptedData.text || '';
        if (decryptedData.type === 'file' && fileData) {
          previewText = `📎 [Fichier] ${fileData.fileName || 'Fichier partagé'}`;
        } else if (decryptedData.audio || decryptedData.type === 'audio') {
          previewText = `🎵 [Message vocal]`;
        } else if (decryptedData.type === 'wink') {
          previewText = `😉 [Clin d'œil]`;
        } else if (decryptedData.type === 'nudge') {
          previewText = `💥 [Wizz !]`;
        }

        const contactAvatar = contactFromList?.avatar || (senderId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : '/assets/usertiles/chess.png');

        if (decision === 'system') {
          showSystemNotification({
            title: `${finalSenderName} - OpenWLM`,
            body: previewText,
            icon: contactAvatar,
            tag: `openwlm-chat-${senderId}`,
            onClick: () => {
              setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
              setActiveChatId(senderId);
            }
          });
        } else if (decision === 'in-app') {
          addToast({
            senderId,
            senderName: finalSenderName,
            avatar: contactAvatar,
            text: previewText,
            actionText: t.settings.toastAction || 'a envoyé un message :'
          });
        }

      });

      // Réception d'un Wizz
      newSocket.on('receive_wizz', (data) => {
        const senderId = data.senderId;
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        if (typeof window !== 'undefined' && window.innerWidth <= 768) {
          setActiveChatId(prev => (prev === 0 ? senderId : prev));
        }
        handleNudge(true, senderId);

        const isAppVisible = typeof document !== 'undefined' && 
                             document.visibilityState === 'visible' && 
                             document.hasFocus();
        const isDesktop = typeof window !== 'undefined' && window.innerWidth > 768;
        const hasSystemPermission = typeof Notification !== 'undefined' && Notification.permission === 'granted';

        const decision = decideNotificationType({
          isSender: false,
          senderId,
          activeChatId: activeChatIdRef.current,
          isAppVisible,
          isDesktop,
          hasSystemPermission
        });

        const contactFromList = contactsRef.current.find(c => c.id === senderId);
        const senderName = contactFromList ? (contactFromList.nickname || contactFromList.username) : 'Contact';
        const contactAvatar = contactFromList?.avatar || '/assets/usertiles/chess.png';

        if (decision === 'system') {
          showSystemNotification({
            title: `${senderName} - OpenWLM`,
            body: `💥 [Wizz !]`,
            icon: contactAvatar,
            tag: `openwlm-chat-${senderId}`,
            onClick: () => {
              setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
              setActiveChatId(senderId);
            }
          });
        } else if (decision === 'in-app') {
          addToast({
            senderId,
            senderName,
            avatar: contactAvatar,
            text: `💥 [Wizz !]`,
            actionText: t.settings.toastAction || 'a envoyé un message :'
          });
        }
      });

      // Réception d'un Clin d'œil
      newSocket.on('receive_wink', (data) => {
        const senderId = data.senderId;
        setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
        setActiveChatId(prev => (prev === 0 ? senderId : prev));
        handleSendWink(data.winkId, true, senderId);
      });

      // Synchronisation du Mode Privé
      // Le contact a changé SA préférence pour notre conversation (la mienne est inchangée)
      newSocket.on('private_mode_changed', (data: { senderId?: unknown; isPrivate?: unknown; effectivePrivate?: unknown; senderNickname?: string }) => {
        const senderId = Number(data?.senderId);
        if (!senderId) return;
        const isPrivate = !!data.isPrivate;
        const effective = data.effectivePrivate !== undefined ? !!data.effectivePrivate : isPrivate;
        const senderNickname = data.senderNickname;
        setContacts(prev => prev.map(c => c.id === senderId ? { ...c, their_private: isPrivate ? 1 : 0 } : c));

        const systemMsg: Message = {
          senderId: 0,
          receiverId: senderId,
          text: `${senderNickname} a ${isPrivate ? 'activé' : 'désactivé'} le mode privé. Les messages ${effective ? 'ne seront pas' : 'seront'} enregistrés.`,
          sender: 'Système',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => ({ ...prev, [senderId]: [...(prev[senderId] || []), systemMsg] }));
      });

      // Ma préférence a changé depuis une autre de mes sessions
      newSocket.on('private_mode_self_sync', (data: { contactId?: unknown; isPrivate?: unknown }) => {
        const contactId = Number(data?.contactId);
        if (!contactId) return;
        setIsPrivateMode(prev => ({ ...prev, [contactId]: !!data.isPrivate }));
      });

      // WebRTC : Réception d'un appel
      newSocket.on('incoming_call', (data, ack?: (res: { ok: boolean }) => void) => {
        console.log("Appel entrant de :", data.callerName);
        // Accusé de réception : c'est lui qui fait passer l'appelant à « ça sonne » (une connexion
        // fantôme d'un téléphone en veille ne répond pas, le serveur tente alors un réveil par Push)
        try { ack?.({ ok: true }); } catch { /* ancien serveur sans accusé */ }
        // L'application prend le relais : la notification Push d'appel (qui sonne en boucle)
        // de cet appelant est fermée
        closeCallPushNotifications(Number(data.caller));
        // Déjà présenté (nouvelle remise au retour au premier plan) : rien à refaire
        if (activeCallIdRef.current === Number(data.caller)) return;

        // La signalisation est chiffrée E2EE : on la transmet BRUTE à <VideoCall/> qui la déchiffre.
        setCallSignal(data.signal);
        setActiveCallId(data.caller);
        setIsReceivingCall(true);
        setIsAudioOnly(!!data.audioOnly);

        // Alerte système : utile quand l'onglet est en arrière-plan (la sonnerie peut y être limitée).
        try {
          if (getSystemNotificationPermission() === 'granted') {
            showSystemNotification({
              title: `${data.callerName || 'Contact'} — OpenWLM`,
              body: data.audioOnly ? t.videoCall.audioIncoming : t.videoCall.videoIncoming,
              icon: '/assets/openwlm_logo.png',
              tag: `openwlm-call-${data.caller}`,
              onClick: () => { try { window.focus(); } catch { /* ignore */ } }
            });
          }
        } catch { /* ignore */ }
      });

      // Note : la signalisation WebRTC (webrtc_signal) est gérée dans <VideoCall />.
      // Changement de statut d'un contact
      newSocket.on('user_status_changed', (data) => {
        const contactId = Number(data.userId ?? data.id);
        if (!contactId) return;

        // Ne pas jouer le son pour la session de l'utilisateur connecté lui-même
        if (contactId === user?.id) {
          if (data.status) setMyStatus(data.status);
          return;
        }

        // Si la clé publique du contact est transmise (ex: après réinitialisation E2E)
        if (data.public_key) {
          try {
            const pubKey = typeof data.public_key === 'string' ? JSON.parse(data.public_key) : data.public_key;
            setPublicKeysCache(prev => ({ ...prev, [contactId]: pubKey }));
            calculatePublicKeyFingerprint(pubKey).then(fp => {
              if (!fp) return;
              setVerifiedContacts(prev => {
                const existing = prev[contactId];
                if (!existing) {
                  const nextRecord: VerifiedContactRecord = {
                    contactId,
                    fingerprint: fp,
                    verified: false,
                    seenAt: Date.now()
                  };
                  VerifiedContactsStorage.save(nextRecord);
                  return { ...prev, [contactId]: nextRecord };
                }
                if (existing.fingerprint && existing.fingerprint !== fp) {
                  console.warn(`[Security] La clé publique du contact ${contactId} a changé ! Réinitialisation du statut de vérification.`);
                  setKeyAlertContactId(contactId);
                  const nextRecord: VerifiedContactRecord = {
                    contactId,
                    fingerprint: fp,
                    verified: false,
                    seenAt: Date.now()
                  };
                  VerifiedContactsStorage.save(nextRecord);
                  return { ...prev, [contactId]: nextRecord };
                }
                return prev;
              });
            });
          } catch (e) {
            console.warn('[Security] Impossible de parser la clé publique reçue:', e);
          }
        }

        // NOTIFICATION DE CONNEXION : « Pseudo vient de se connecter » (même mécanique que
        // les messages : toast Aero au premier plan sur PC, notification système sinon).
        const knownContact = contactsRef.current.find(c => c.id === contactId);
        // Le serveur marque les vraies connexions (`signedIn`) : une mise à jour de profil ou un
        // état local périmé ne déclenchent plus de faux « vient de se connecter »
        const isSignIn = !!knownContact && data.signedIn === true;
        if (isSignIn && Date.now() > signInQuietUntil) {
          const signInName = knownContact.nickname || knownContact.username;
          const signInAvatar = data.avatar || knownContact.avatar || '/assets/usertiles/chess.png';
          const signInDecision = decideNotificationType({
            isSender: false,
            senderId: contactId,
            activeChatId: activeChatIdRef.current,
            isAppVisible: typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus(),
            isDesktop: typeof window !== 'undefined' && window.innerWidth > 768,
            hasSystemPermission: typeof Notification !== 'undefined' && Notification.permission === 'granted'
          });
          if (signInDecision === 'system') {
            showSystemNotification({
              title: 'OpenWLM',
              body: `${signInName} ${tRef.current.settings.toastSignedIn}`,
              icon: signInAvatar,
              tag: `openwlm-signin-${contactId}`,
              onClick: () => {
                setOpenChatIds(prev => prev.includes(contactId) ? prev : [...prev, contactId]);
                setActiveChatId(contactId);
              }
            });
          } else if (signInDecision === 'in-app') {
            addToast({
              senderId: contactId,
              senderName: signInName,
              avatar: signInAvatar,
              text: '',
              actionText: tRef.current.settings.toastSignedIn
            });
          }
        }

        // Le contact a basculé son mode privé GLOBAL : on le signale dans la conversation
        // (l'état lui-même suit via contacts.global_private, persisté côté serveur).
        if (data.global_private !== undefined) {
          const known = contactsRef.current.find(c => c.id === contactId);
          if (known && known.global_private !== undefined && Number(known.global_private) !== Number(data.global_private)) {
            const on = Number(data.global_private) === 1;
            const name = known.nickname || known.username;
            const systemMsg: Message = {
              senderId: 0,
              receiverId: contactId,
              text: `${name} a ${on ? 'activé' : 'désactivé'} le mode privé global.${on ? ' Les messages ne seront pas enregistrés.' : ''}`,
              sender: 'Système',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            setMessages(prev => (prev[contactId] ? { ...prev, [contactId]: [...prev[contactId], systemMsg] } : prev));
          }
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

      // Réception d'une mise à jour de statut de message (remis)
      newSocket.on('message_status_updated', (data: { contactId: number; messageId: number; status: 'delivered' | 'read' }) => {
        const { contactId, messageId, status } = data || {};
        if (!contactId || !messageId) return;

        setMessages(prev => {
          const list = prev[contactId];
          if (!list) return prev;
          let changed = false;
          const updated = list.map(m => {
            if (m.id === messageId) {
              // Ne pas rétrograder si déjà marqué 'read'
              if (m.delivery_status === 'read' && status === 'delivered') return m;
              if (m.delivery_status !== status) {
                changed = true;
                return { ...m, delivery_status: status };
              }
            }
            return m;
          });
          return changed ? { ...prev, [contactId]: updated } : prev;
        });
      });

      // Réception d'un accusé de lecture groupé (curseur de lecture)
      newSocket.on('conversation_read', (data: { contactId: number; lastReadMessageId: number }) => {
        const { contactId, lastReadMessageId } = data || {};
        if (!contactId || !lastReadMessageId) return;

        setMessages(prev => {
          const list = prev[contactId];
          if (!list) return prev;
          let changed = false;
          const updated = list.map(m => {
            const mId = typeof m.id === 'number' ? m.id : 0;
            // On marque 'read' les messages envoyés par moi vers ce contact avec id <= lastReadMessageId
            if (mId && mId <= lastReadMessageId && m.delivery_status !== 'read') {
              changed = true;
              return { ...m, delivery_status: 'read' as const };
            }
            return m;
          });
          return changed ? { ...prev, [contactId]: updated } : prev;
        });
      });

      // Retour au premier plan : une page suspendue dont la connexion a survécu n'a pas été
      // reconnectée, donc pas reçu l'appel en attente → on le redemande au serveur
      const onForeground = () => {
        if (document.visibilityState === 'visible' && newSocket.connected) newSocket.emit('call_resync');
      };
      document.addEventListener('visibilitychange', onForeground);
      window.addEventListener('pageshow', onForeground);

      setSocket(newSocket);
      return () => {
        document.removeEventListener('visibilitychange', onForeground);
        window.removeEventListener('pageshow', onForeground);
        newSocket.disconnect();
      };
    }
  }, [user?.id]);

  /**
   * CHARGEMENT DE L'HISTORIQUE DU CHAT ACTIF SI NON CHARGÉ + ACCUSÉ DE LECTURE AUTOMATIQUE
   */
  useEffect(() => {
    if (user && myKeys && activeChatId !== 0 && (!messages[activeChatId] || messages[activeChatId].length === 0)) {
      loadChatHistory(activeChatId);
    }
  }, [activeChatId, user, !!myKeys, loadChatHistory]);

  // Émission de l'accusé de lecture lorsque la conversation est active et des messages sont présents
  useEffect(() => {
    if (!socket || !user || activeChatId === 0 || activeChatId === SYSTEM_BOT_ID) return;
    const currentMsgs = messages[activeChatId] || [];
    if (currentMsgs.length === 0) return;

    // Trouver le dernier message reçu depuis ce contact
    let maxContactMsgId = 0;
    let isMsgPrivate = false;
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      const m = currentMsgs[i];
      const sId = m.sender_id || m.senderId;
      if (sId === activeChatId && typeof m.id === 'number') {
        maxContactMsgId = Math.max(maxContactMsgId, m.id);
        if (m.isPrivate) isMsgPrivate = true;
      }
    }

    if (maxContactMsgId > 0) {
      const isPriv = !!effectivePrivateModes[activeChatId] || isMsgPrivate;
      socket.emit('message_read', {
        contactId: activeChatId,
        lastReadMessageId: maxContactMsgId,
        isPrivate: isPriv
      });
    }
  }, [activeChatId, messages[activeChatId]?.length, socket, user, effectivePrivateModes]);

  /**
   * RÉCUPÉRATION DE LA CLÉ PUBLIQUE D'UN CONTACT (Cache-first)
   * Intègre la vérification d'empreinte locale et la détection automatique de changement de clé.
   */
  const getPublicKey = async (contactId: number, forceRefresh = false) => {
    if (!forceRefresh && publicKeysCache[contactId]) return publicKeysCache[contactId];
    try {
      const res = await axios.get(`/api/user/${contactId}/public-key`);
      if (res.data && res.data.publicKey) {
        const pubKey = res.data.publicKey;
        setPublicKeysCache(prev => ({ ...prev, [contactId]: pubKey }));

        // Calcul de l'empreinte cryptographique locale
        calculatePublicKeyFingerprint(pubKey).then(fp => {
          if (!fp) return;
          setVerifiedContacts(prev => {
            const existing = prev[contactId];
            if (!existing) {
              // Premier contact : on enregistre l'empreinte connue, statut non vérifié par défaut
              const nextRecord: VerifiedContactRecord = {
                contactId,
                fingerprint: fp,
                verified: false,
                seenAt: Date.now()
              };
              VerifiedContactsStorage.save(nextRecord);
              return { ...prev, [contactId]: nextRecord };
            }

            // Détection automatique de changement de clé publique
            if (existing.fingerprint && existing.fingerprint !== fp) {
              console.warn(`[Security Alert] Clé publique modifiée pour le contact ${contactId}! Empreinte précédente: ${existing.fingerprint}, Nouvelle: ${fp}`);
              // Règle stricte : retrait automatique du statut vérifié + déclenchement d'alerte visible
              setKeyAlertContactId(contactId);
              const nextRecord: VerifiedContactRecord = {
                contactId,
                fingerprint: fp,
                verified: false,
                seenAt: Date.now()
              };
              VerifiedContactsStorage.save(nextRecord);
              return {
                ...prev,
                [contactId]: nextRecord
              };
            }

            return prev;
          });
        }).catch(console.error);

        return pubKey;
      }
    } catch (e) { 
      console.warn("Impossible de récupérer la clé publique pour l'ID:", contactId); 
    }
    return null;
  };
  // Mise à jour après chaque rendu (version courante de getPublicKey et de son cache)
  useEffect(() => { getPublicKeyRef.current = getPublicKey; });

  // ---- ENVOI AVEC ACCUSÉ, ÉCHEC VISIBLE ET RENVOI ------------------------------------
  // Payload en clair des messages non envoyés (mémoire uniquement) pour pouvoir les renvoyer.
  const resendInfoRef = useRef<Map<string, { contactId: number; payload: unknown; type: string; mid?: string }>>(new Map());

  const markSendFailed = (chatId: number, clientMsgId: string, failed: NonNullable<Message['_failed']>, reason?: string) => {
    setMessages(prev => ({
      ...prev,
      [chatId]: (prev[chatId] || []).map(m => m.clientMsgId === clientMsgId
        ? { ...m, _isPending: false, _failed: failed, _failReason: reason }
        : m)
    }));
  };

  /**
   * Envoie un message déjà scellé et suit l'accusé du serveur. En cas de refus (mode
   * privé + contact hors ligne, limite de débit…), de délai dépassé ou de socket
   * déconnectée, le message est marqué « Non envoyé » au lieu de rester en attente.
   */
  const deliverSealedMessage = (
    chatId: number,
    clientMsgId: string,
    msgData: Record<string, unknown>,
    localMsg: Message,
    plainPayload: unknown,
    type: string
  ) => {
    // On mémorise le mid de l'enveloppe : un renvoi le réutilisera pour que le serveur
    // puisse dédupliquer (idempotent) et que le destinataire écarte une seconde copie.
    let envelopeMid: string | undefined;
    try {
      const parsed = JSON.parse(String(msgData.text));
      if (parsed && typeof parsed.mid === 'string') envelopeMid = parsed.mid;
    } catch { /* pas d'enveloppe : rien à mémoriser */ }
    resendInfoRef.current.set(clientMsgId, { contactId: chatId, payload: plainPayload, type, mid: envelopeMid });

    if (JSON.stringify(msgData).length > MAX_SOCKET_MESSAGE_CHARS) {
      resendInfoRef.current.delete(clientMsgId); // renvoyer ne servirait à rien
      markSendFailed(chatId, clientMsgId, 'too_large');
      return;
    }
    if (!socket || !socket.connected) {
      markSendFailed(chatId, clientMsgId, 'error', t.chat.sendFailedNetwork);
      return;
    }

    socket.timeout(SEND_ACK_TIMEOUT_MS).emit('send_message', msgData, (err: Error | null, ack?: { success?: boolean; id?: number | string; timestamp?: string; code?: string; error?: string; isPrivate?: boolean }) => {
      if (err || !ack?.success || ack.id === undefined || ack.id === null) {
        const failed = ack?.code === 'RECIPIENT_OFFLINE_PRIVATE' ? 'offline_private' : 'error';
        markSendFailed(chatId, clientMsgId, failed, err ? t.chat.sendFailedNetwork : ack?.error);
        return;
      }
      resendInfoRef.current.delete(clientMsgId);
      // isPrivate (décidé par le serveur) : un message privé confirmé reste reconnu comme tel
      const confirmed: Message = { ...localMsg, id: ack.id, isPrivate: ack.isPrivate === true, _isPending: false, _failed: undefined, _failReason: undefined, timestamp: ack.timestamp || localMsg.timestamp };
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(m => m.clientMsgId === clientMsgId
          ? { ...m, id: ack.id, isPrivate: ack.isPrivate === true, _isPending: false, _failed: undefined, _failReason: undefined, timestamp: ack.timestamp || m.timestamp }
          : m)
      }));
      if (myKeysRef.current) {
        if (getAppPrefs().messages.keepLocalHistory) LocalDB.saveMessage(`${user?.id}_${chatId}`, confirmed, myKeysRef.current.publicKeyJwk).catch(console.error);
      }
    });
  };

  /** Renvoie un message « Non envoyé » en réutilisant le mid d'origine (le serveur déduplique). */
  const handleResendMessage = async (chatId: number, clientMsgId: string) => {
    const info = resendInfoRef.current.get(clientMsgId);
    const localMsg = (messages[chatId] || []).find(m => m.clientMsgId === clientMsgId);
    if (!info || !localMsg) return;
    try {
      const contactPubKey = await getPublicKey(info.contactId);
      if (!contactPubKey) throw new Error('Clé publique du contact indisponible');
      const envelope = await sealForContact(info.payload, info.contactId, contactPubKey, info.mid);
      seenMidsRef.current.add(envelope.mid);
      const msgData = {
        senderId: user?.id,
        receiverId: info.contactId,
        text: JSON.stringify(envelope),
        style: null,
        audio: null,
        type: info.type,
        isPrivate: !!effectivePrivateModes[info.contactId]
      };
      const retried: Message = { ...localMsg, mid: envelope.mid, _isPending: true, _failed: undefined, _failReason: undefined, timestamp: new Date().toISOString() };
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(m => m.clientMsgId === clientMsgId ? retried : m)
      }));
      deliverSealedMessage(chatId, clientMsgId, msgData, retried, info.payload, info.type);
    } catch (e) {
      console.error('Échec du renvoi:', e);
      markSendFailed(chatId, clientMsgId, 'error', e instanceof Error ? e.message : undefined);
    }
  };

  /**
   * Action utilisateur : basculer le statut vérifié localement
   */
  const handleToggleContactVerification = (contactId: number, currentFp: string) => {
    setVerifiedContacts(prev => {
      const existing = prev[contactId];
      const willBeVerified = !existing?.verified;
      const updatedRecord: VerifiedContactRecord = {
        contactId,
        fingerprint: currentFp || existing?.fingerprint || '',
        verified: willBeVerified,
        verifiedAt: willBeVerified ? Date.now() : undefined,
        seenAt: Date.now()
      };
      VerifiedContactsStorage.save(updatedRecord);
      return {
        ...prev,
        [contactId]: updatedRecord
      };
    });
    // Fermer l'alerte si l'utilisateur a réexaminé et validé la clé
    if (keyAlertContactId === contactId) {
      setKeyAlertContactId(null);
    }
  };

  /**
   * Ouvre la modale de safety number pour un contact
   */
  const handleOpenSafetyModal = async (contactId: number) => {
    setSafetyModalContactId(contactId);
    setShowSafetyModal(true);

    // Calculer mon empreinte locale
    if (myKeys?.publicKeyJwk) {
      calculatePublicKeyFingerprint(myKeys.publicKeyJwk)
        .then(fp => setMyFingerprint(fp))
        .catch(console.error);
    } else {
      setMyFingerprint('');
    }

    const pubKey = await getPublicKey(contactId, true);
    if (pubKey) {
      const fp = await calculatePublicKeyFingerprint(pubKey);
      setActiveFingerprint(fp);
    } else {
      setActiveFingerprint('');
    }
  };

  // Récupérer et vérifier la clé publique du contact actif à l'ouverture de la conversation
  useEffect(() => {
    if (activeChatId && activeChatId !== SYSTEM_BOT_ID) {
      getPublicKey(activeChatId);
    }
  }, [activeChatId]);

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

        const isAppVisible = typeof document !== 'undefined' && 
                             document.visibilityState === 'visible' && 
                             document.hasFocus();
        const isDesktop = typeof window !== 'undefined' && window.innerWidth > 768;
        const hasSystemPermission = typeof Notification !== 'undefined' && Notification.permission === 'granted';

        const botDecision = decideNotificationType({
          isSender: false,
          senderId: SYSTEM_BOT_ID,
          activeChatId: activeChatIdRef.current,
          isAppVisible,
          isDesktop,
          hasSystemPermission
        });

        if (botDecision === 'system') {
          showSystemNotification({
            title: `OpenWLM Bot`,
            body: echoNotice,
            icon: SYSTEM_BOT_CONTACT.avatar,
            tag: `openwlm-chat-${SYSTEM_BOT_ID}`,
            onClick: () => {
              setOpenChatIds(prev => prev.includes(SYSTEM_BOT_ID) ? prev : [...prev, SYSTEM_BOT_ID]);
              setActiveChatId(SYSTEM_BOT_ID);
            }
          });
        } else if (botDecision === 'in-app') {
          addToast({
            senderId: SYSTEM_BOT_ID,
            senderName: 'OpenWLM Bot',
            avatar: SYSTEM_BOT_CONTACT.avatar,
            text: echoNotice,
            actionText: t.settings.toastAction || 'a envoyé un message :'
          });
        }
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
      const e2eData = await sealForContact(unencryptedPayload, activeChatId, contactPubKey);

      const msgData = { 
        senderId: user?.id, 
        receiverId: activeChatId, 
        text: JSON.stringify(e2eData), 
        style: null, 
        audio: null, 
        type: 'text',
        isPrivate: !!effectivePrivateModes[activeChatId]
      };
      
      const clientMsgId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const nowIso = new Date().toISOString();
      const formattedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Ajout local immédiat pour la fluidité (optimistic UI)
      seenMidsRef.current.add(e2eData.mid);
      const myLocalMsg: Message = { 
        ...unencryptedPayload, 
        id: clientMsgId,
        mid: e2eData.mid,
        _auth: 'verified',
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

      deliverSealedMessage(activeChatId, clientMsgId, msgData, myLocalMsg, unencryptedPayload, 'text');

    } catch (e) {
      console.error("Échec du chiffrement:", e);
      alert(e instanceof Error && e.message === t.chat.signingKeyMissing ? e.message : "Erreur lors du chiffrement du message.");
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

      // Auth via le cookie HttpOnly (user.token est souvent absent : le login ne renvoie
      // le JWT qu'en cookie). Ne jamais envoyer « Bearer undefined » → 403 côté serveur.
      const res = await axios.post('/api/files/upload', formData, {
        headers: {
          ...(user?.token ? { Authorization: `Bearer ${user.token}` } : {}),
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

      const e2eData = await sealForContact(filePayload, activeChatId, contactPubKey);

      const msgData = {
        senderId: user?.id,
        receiverId: activeChatId,
        text: JSON.stringify(e2eData),
        style: null,
        audio: null,
        type: 'file',
        isPrivate: !!effectivePrivateModes[activeChatId]
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

      deliverSealedMessage(activeChatId, clientMsgId, msgData, myLocalMsg, filePayload, 'file');
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
  }, [socket, myKeys, activeChatId, user, myNickname, effectivePrivateModes]);

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
      showResetE2EModal ||
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
    showResetE2EModal,
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
        // 32 kbit/s : largement suffisant pour la voix (Opus), et garde un clip de
        // VOICE_CLIP_MAX_MS sous la limite de 1 Mo des trames socket (double base64 inclus).
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, { audioBitsPerSecond: VOICE_CLIP_BITRATE });
        } catch {
          recorder = new MediaRecorder(stream);
        }
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
              const e2eData = await sealForContact(unencryptedPayload, activeChatId, contactPubKey);
              const msgData = {
                senderId: user?.id,
                receiverId: activeChatId,
                text: JSON.stringify(e2eData),
                style: null,
                audio: null,
                type: 'audio',
                isPrivate: !!effectivePrivateModes[activeChatId]
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

              // Sans socket, deliverSealedMessage marque le message « Non envoyé » (renvoyable)
              deliverSealedMessage(activeChatId, clientMsgId, msgData, myLocalMsg, unencryptedPayload, 'audio');
            } catch (err) {
              console.error("Échec chiffrement clip vocal:", err);
            }
          };
        };
        
        recorder.start();
        setMediaRecorder(recorder);
        setIsRecording(true);

        // Arrêt automatique à la durée maximale : le clip est envoyé normalement.
        const recordingChatId = activeChatId;
        const autoStopTimer = setTimeout(() => {
          if (recorder.state !== 'recording') return;
          stream.getTracks().forEach(tr => tr.stop());
          recorder.stop();
          setIsRecording(false);
          setMediaRecorder(null);
          setMessages(prev => ({
            ...prev,
            [recordingChatId]: [...(prev[recordingChatId] || []), {
              sender: 'Système',
              text: t.chat.voiceClipMaxReached,
              timestamp: new Date().toISOString()
            }]
          }));
        }, VOICE_CLIP_MAX_MS);
        recorder.addEventListener('stop', () => clearTimeout(autoStopTimer));
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
   * RÉINITIALISATION DES CLÉS E2E (OUVERTURE DE LA MODALE DE CONFIRMATION)
   */
  // Mode privé global (menu principal et Options → Sécurité)
  const toggleGlobalPrivateMode = () => {
    const newGlobal = !globalPrivateMode;
    setGlobalPrivateMode(newGlobal);
    // Persisté côté serveur, qui diffuse le nouvel état aux contacts (user_status_changed)
    axios.post('/api/user/global-private', { userId: user?.id, globalPrivate: newGlobal }).catch(console.error);
  };

  const handleResetE2EKeys = () => {
    setShowStatusMenu(false);
    setResetE2EPassword('');
    setResetE2EError(null);
    setShowResetE2EModal(true);
  };

  /**
   * CONFIRMATION ET EXÉCUTION DU RESET E2E (ZERO-KNOWLEDGE DE BOUT EN BOUT)
   */
  const handleConfirmResetE2EKeys = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!user || !resetE2EPassword) return;

    setIsResettingE2E(true);
    setResetE2EError(null);

    try {
      // 1. Dérivation Zero-Knowledge locale depuis le mot de passe utilisateur
      const { authKeyHex, vaultKey } = await deriveZeroKnowledgeKeys(user.username, resetE2EPassword);

      // 2. Génération d'une nouvelle paire de clés cryptographiques RSA 2048 bits
      const newKeyPair = await generateKeyPair();
      const pubJwk = newKeyPair.publicKeyJwk;
      const privJwk = newKeyPair.privateKeyJwk;

      // 3. Chiffrement de la nouvelle clé privée avec la vaultKey dérivée
      const newVault = await encryptPrivateKeyVault(privJwk, vaultKey);

      // 4. Appel sécurisé de l'API avec JWT
      const res = await axios.post('/api/user/reset-e2e-keys', {
        authKeyHex,
        publicKey: pubJwk,
        encryptedPrivateKey: newVault
      });

      if (res.data && res.data.success) {
        // 5. Purge complète des données locales chiffrées (messages, clés privées, contacts vérifiés)
        const purgeErrors: string[] = [];
        try {
          // Seulement la copie de CE compte : celles des autres comptes du navigateur sont
          // chiffrées avec leurs propres clés, que cette réinitialisation ne touche pas
          await LocalDB.clearUser(user.id);
        } catch (err: any) {
          console.error('[Reset] Échec purge LocalDB:', err);
          purgeErrors.push("messages locaux");
        }
        try {
          // Seulement les clés mémorisées de CE compte : les autres comptes du navigateur
          // gardent les leurs (elles ne sont pas concernées par cette réinitialisation)
          const resKeys = await E2EEKeyStorage.removeKeys(user.id);
          if (!resKeys) {
            console.error('[Reset] Échec purge E2EEKeyStorage');
            purgeErrors.push("clés privées locales");
          }
        } catch (err: any) {
          console.error('[Reset] Exception purge E2EEKeyStorage:', err);
          purgeErrors.push("clés privées locales");
        }
        try {
          const resVC = await VerifiedContactsStorage.clearAll();
          if (!resVC || !resVC.success) {
            console.error('[Reset] Échec purge VerifiedContactsStorage:', resVC?.error);
            purgeErrors.push("contacts vérifiés");
          }
        } catch (err: any) {
          console.error('[Reset] Exception purge VerifiedContactsStorage:', err);
          purgeErrors.push("contacts vérifiés");
        }
        try {
          await CustomEmoticonsDB.clearAll();
        } catch (err: any) {
          console.warn('[Reset] Échec purge CustomEmoticonsDB:', err);
        }

        if (purgeErrors.length > 0) {
          console.error('[Reset] Échec partiel de purge locale:', purgeErrors);
          alert(`Attention : Les données locales suivantes n'ont pas pu être entièrement purgées sur cet appareil : ${purgeErrors.join(', ')}.`);
        }

        // 6. Nettoyage de l'état en mémoire
        setMessages({});
        setMyKeys(null);
        setVerifiedContacts({});
        setShowResetE2EModal(false);

        // 7. Déconnexion propre et redirection vers l'écran d'accueil/authentification
        handleLogout('Réinitialisation E2E effectuée avec succès');
      } else {
        setResetE2EError(res.data?.error || "Échec de la réinitialisation.");
      }
    } catch (err: any) {
      console.error("[Reset E2E] Erreur:", err);
      const errorMsg = err.response?.data?.error || err.message || "Erreur lors de la réinitialisation des clés E2E.";
      setResetE2EError(errorMsg);
    } finally {
      setIsResettingE2E(false);
    }
  };

  /**
   * DÉCONNEXION (PURGE COMPLÈTE DE LA MÉMOIRE VIVE)
   */
  // `local` : session déjà révoquée par le serveur — on nettoie seulement cet appareil
  // (appeler /api/logout révoquerait aussi la session de l'appareil à l'origine de la demande).
  const handleLogout = async (reason?: string, opts: { local?: boolean } = {}) => {
    if (reason) console.warn("[Session] Déconnexion:", reason); 
    const currentToken = user?.token;
    if (!opts.local) {
      if (socket) {
        socket.emit('manual_disconnect');
      }
      // SÉCURITÉ : Révocation du token côté serveur via l'endpoint dédié et suppression du cookie HttpOnly
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: currentToken ? { 'Authorization': `Bearer ${currentToken}` } : {},
          credentials: 'include'
        });
      } catch (e) {
        console.warn('[Logout] Erreur appel /api/logout:', e);
      }
    } else if (socket) {
      socket.disconnect();
    }
    draftsRef.current = {};
    // SÉCURITÉ : Purge complète du stockage JS
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('wlm_user'); 
      localStorage.removeItem('wlm_open_chats');
      localStorage.removeItem('wlm_active_chat');
      sessionStorage.clear();
      // Message affiché sur l'écran de connexion après le rechargement
      if (reason === 'session_revoked') sessionStorage.setItem('wlm_session_notice', 'revoked');
    } catch {}

    // SÉCURITÉ : Purger les clés E2EE mémorisées sur cet appareil
    try { 
      if (user?.id) {
        await E2EEKeyStorage.removeKeys(user.id);
      }
    } catch (e) { 
      console.warn('[Logout] Erreur purge E2EEKeyStorage:', e); 
    }
    // SÉCURITÉ : Purger le cache IndexedDB des émoticônes personnalisées (clés + assets déchiffrés)
    try { await CustomEmoticonsDB.clearAll(); } catch (e) { console.warn('[Logout] Erreur purge CustomEmoticonsDB:', e); }
    setMyKeys(null);
    setUser(null);
    window.location.reload(); 
  };
  useEffect(() => { handleLogoutRef.current = handleLogout; });

  // Options → Sécurité : couper les autres appareils, garder celui-ci (connexion et Push)
  const revokeOtherSessions = async (): Promise<{ ok: boolean; disconnected?: number }> => {
    try {
      const sub = await getExistingPushSubscription().catch(() => null);
      const res = await axios.post('/api/sessions/revoke-others', { socketId: socket?.id, keepPushEndpoint: sub?.endpoint });
      return { ok: true, disconnected: Number(res.data?.disconnected) || 0 };
    } catch {
      return { ok: false };
    }
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

  /**
   * GESTION DES DISCUSSIONS OUVERTES
   */
  const openChat = async (id: number) => {
    if (!openChatIds.includes(id)) {
      setOpenChatIds(prev => [...prev, id]);

    }
    setActiveChatId(id);
    loadChatHistory(id);
  };
  const closeChat = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setUnreadCounts(prev => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
    const newIds = openChatIds.filter(cid => cid !== id);
    setOpenChatIds(newIds);
    delete draftsRef.current[id];
    if (activeChatId === id) {
      draftChatIdRef.current = null; // l'onglet fermé ne garde pas de brouillon
      setActiveChatId(newIds.length > 0 ? newIds[0] : 0);
    }
  };

  /**
   * GLISSER-DÉPOSER DES ONGLETS DE DISCUSSION (DnD natif HTML5)
   */
  const handleTabDragStart = (e: React.DragEvent<HTMLDivElement>, id: number) => {
    // Si l'utilisateur clique sur le bouton de fermeture ou un sous-élément d'action, ignorer le drag
    const target = e.target as HTMLElement | null;
    if (target && target.closest('.chat-tab-close')) {
      e.preventDefault();
      return;
    }
    setDraggedTabId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
  };

  const handleTabDragOver = (e: React.DragEvent<HTMLDivElement>, targetId: number) => {
    e.preventDefault();
    if (draggedTabId === null || draggedTabId === targetId) {
      if (dragOverTabId !== null) setDragOverTabId(null);
      if (dropPosition !== null) setDropPosition(null);
      return;
    }

    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX;
    const midX = rect.left + rect.width / 2;
    const pos: 'left' | 'right' = mouseX < midX ? 'left' : 'right';

    if (dragOverTabId !== targetId || dropPosition !== pos) {
      setDragOverTabId(targetId);
      setDropPosition(pos);
    }
  };

  const handleTabDragLeave = (e: React.DragEvent<HTMLDivElement>, id: number) => {
    // Empêcher le clignotement lorsque la souris survole un élément enfant de l'onglet
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) {
      return;
    }
    if (dragOverTabId === id) {
      setDragOverTabId(null);
      setDropPosition(null);
    }
  };

  const handleTabDrop = (e: React.DragEvent<HTMLDivElement>, targetId: number) => {
    e.preventDefault();
    if (draggedTabId !== null && draggedTabId !== targetId && dropPosition !== null) {
      const updated = reorderChatTabs(openChatIds, draggedTabId, targetId, dropPosition);
      setOpenChatIds(updated);
    }
    setDraggedTabId(null);
    setDragOverTabId(null);
    setDropPosition(null);
  };

  const handleTabDragEnd = () => {
    setDraggedTabId(null);
    setDragOverTabId(null);
    setDropPosition(null);
  };

  /**
   * RENDU DU CONTENU DES MESSAGES (Gestion des émoticônes)
   */
  const renderMessageContent = (text: string, style: any) => {
    if (!text) return null;
    
    let parts: (string | React.ReactNode)[] = [text];
    
    // 1. Émoticônes personnalisées (E2EE) - Triées par longueur décroissante
    // Options → Messages : émoticônes en images, ou laissées en texte (« :) »)
    const showEmoticonImages = appPrefs.messages.emoticonImages;
    const customShortcuts = showEmoticonImages ? Object.keys(customEmoticonsMap).sort((a, b) => b.length - a.length) : [];
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
    const sortedShortcuts = showEmoticonImages ? Object.keys(EMOTICON_MAP).sort((a, b) => b.length - a.length) : [];
    
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
                  width={19}
                  height={19}
                  draggable={false}
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
   * CHAMP DE SAISIE RICHE (contentEditable)
   *
   * Le texte reste la source de vérité ; à chaque frappe les raccourcis
   * complétés sont convertis en <img> inline (comme dans les messages). L'image
   * occupe sa largeur réelle et pousse le texte, avec le même `vertical-align`
   * que les bulles. On reconstruit `inputText` (sérialisation) et on restaure le
   * curseur en "unités texte" (une image compte pour la longueur du raccourci).
   */
  const emoticonShortcuts = useMemo<EmoticonShortcut[]>(() => {
    const list: EmoticonShortcut[] = [];
    Object.keys(customEmoticonsMap).forEach((shortcut) => {
      const info = customEmoticonsMap[shortcut];
      if (info?.url) list.push({ shortcut, src: info.url, custom: true });
    });
    Object.keys(EMOTICON_MAP).forEach((shortcut) => {
      list.push({ shortcut, src: `/assets/emoticons/${EMOTICON_MAP[shortcut]}`, custom: false });
    });
    return list.sort((a, b) => b.shortcut.length - a.shortcut.length);
  }, [customEmoticonsMap]);

  const syncRichInput = (force = false) => {
    const root = chatInputRef.current;
    if (!root) return;
    const text = serializeRich(root);
    const tokens = buildRichTokens(text, emoticonShortcuts);
    const shortcutCount = tokens.reduce((n, t) => n + (hasShortcutKey(t) ? 1 : 0), 0);
    const domImgCount = root.querySelectorAll('img').length;
    const hasForeign = Array.from(root.childNodes).some(n => n.nodeType !== Node.TEXT_NODE && n.nodeName !== 'IMG');
    // On ne reconstruit QUE si un raccourci vient d'être complété (ou supprimé)
    // ou en cas de nœuds parasites : la frappe normale garde ainsi l'undo et
    // l'IME natifs, et le curseur n'est pas retouché inutilement.
    if (force || hasForeign || shortcutCount !== domImgCount) {
      const caret = getRichCaretOffset(root);
      renderRichTokens(root, tokens);
      setRichCaretOffset(root, caret);
    }
    setInputText(text);
  };

  // Insère du texte au niveau du curseur (sélecteur d'émoticônes, etc.)
  const insertChatText = (text: string) => {
    const root = chatInputRef.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    syncRichInput();
  };

  const handleRichKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode('\n');
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      syncRichInput(true);
    } else {
      handleSendMessage();
    }
  };

  const handleRichPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    const hasImage = items ? Array.from(items).some(it => it.kind === 'file' && it.type.startsWith('image/')) : false;
    if (hasImage) return; // laissé au listener global (aperçu de pièce jointe)
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) document.execCommand('insertText', false, text);
    syncRichInput();
  };

  // Vide le champ lorsque son contenu a été consommé (envoi) ailleurs
  useEffect(() => {
    inputTextRef.current = inputText;
    const root = chatInputRef.current;
    if (root && inputText === '' && serializeRich(root) !== '') {
      root.replaceChildren();
    }
  }, [inputText]);

  // Changement d'onglet : on range le brouillon de la conversation quittée et on
  // restaure celui de la conversation affichée (sinon le texte suivait partout).
  useLayoutEffect(() => {
    const prevId = draftChatIdRef.current;
    if (prevId === activeChatId) return;
    if (prevId !== null) {
      const text = inputTextRef.current;
      if (text) draftsRef.current[prevId] = text;
      else delete draftsRef.current[prevId];
    }
    draftChatIdRef.current = activeChatId;
    const draft = draftsRef.current[activeChatId] || '';
    inputTextRef.current = draft;
    setInputText(draft);
    const root = chatInputRef.current;
    if (root) {
      root.replaceChildren();
      if (draft) renderRichTokens(root, buildRichTokens(draft, emoticonShortcuts));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  /**
   * RENDU DU COMPOSANT
   */

  // Écran de chargement élégant pendant la vérification du coffre-fort local E2EE
  if (isAuthInitializing) {
    return (
      <div className="wlm-auth-container">
        <div className="wlm-auth-box" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <img src="/assets/openwlm_logo.png" alt="OpenWLM Logo" className="wlm-auth-logo-img" style={{ width: 64, height: 64, margin: '0 auto 15px', display: 'block' }} />
          <div className="wlm-logo-text-large" style={{ marginBottom: 12 }}>OpenWLM</div>
          <div style={{ fontSize: '12px', color: '#004b8d', fontWeight: 'bold' }}>
            {t.auth.signingIn || "Connexion en cours..."}
          </div>
        </div>
      </div>
    );
  }

  // Redirection vers l'authentification si aucun utilisateur n'est connecté ou si les clés ne sont pas en mémoire
  if (!user || !myKeys) {
    let fallbackUsername = '';
    let fallbackId: number | undefined;
    try {
      const saved = localStorage.getItem('wlm_user');
      if (saved) { const su = JSON.parse(saved); fallbackUsername = su?.username || ''; fallbackId = Number(su?.id) || undefined; }
    } catch {}
    const loginStatus = loadPreferredStatus(user?.id ?? fallbackId) ?? undefined;
    return <Auth onLogin={handleUserLogin} initialUsername={user?.username || fallbackUsername} initialStatus={loginStatus} />;
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

  // Détermination de l'arrière-plan de la discussion courante
  const convBg = activeChatId ? (conversationBackgrounds[activeChatId] || '') : '';

  // Filtrage des contacts pour la liste (En ligne / Hors ligne / Recherche)
  // Options → Disposition : tri (par statut puis nom, ou par nom) et contacts hors ligne.
  // Les contacts BLOQUÉS restent toujours visibles (c'est là qu'on les débloque).
  const contactName = (c: Contact) => (c.nickname || c.username || '').toLowerCase();
  const STATUS_RANK: Record<string, number> = { online: 0, busy: 1, away: 2 };
  const byName = (a: Contact, b: Contact) => contactName(a).localeCompare(contactName(b));
  const sortContacts = (list: Contact[]) => [...list].sort(appPrefs.layout.sortBy === 'name'
    ? byName
    : (a, b) => (STATUS_RANK[a.status || 'online'] ?? 3) - (STATUS_RANK[b.status || 'online'] ?? 3) || byName(a, b));

  const onlineContacts = Array.isArray(contacts) ? sortContacts(contacts.filter(c => 
    Number(c.blocked) === 0 && 
    (c.status || 'online') !== 'offline' && 
    contactName(c).includes(searchQuery.toLowerCase())
  )) : [];

  const offlineContacts = Array.isArray(contacts) ? sortContacts(contacts.filter(c => 
    (Number(c.blocked) === 1 || ((c.status || 'online') === 'offline' && appPrefs.layout.showOffline)) && 
    contactName(c).includes(searchQuery.toLowerCase())
  )) : [];

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
                    maxLength={50}
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

                {isDeviceRemembered && (
                  <span 
                    className="wlm-e2ee-device-icon" 
                    title={t.auth.deviceRememberedTooltip}
                    aria-label={t.auth.deviceRememberedTooltip}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-.5V4.5A3.5 3.5 0 0 0 8 1zm2 5H6V4.5a2 2 0 1 1 4 0V6z"/>
                    </svg>
                  </span>
                )}

                {/* Menu déroulant de Statut et Options */}
                {showStatusMenu && (
                  <div className="wlm-status-dropdown">
                    {STATUS_OPTIONS.map(opt => (
                      <div key={opt.id} className="dropdown-item" onClick={() => { setMyStatus(opt.id); savePreferredStatus(user?.id, opt.id); setShowStatusMenu(false); syncProfile({ status: opt.id }); }}>
                        <div className={`status-icon-box ${opt.id}`}></div>{getStatusLabel(opt.id)}
                      </div>
                    ))}
                    <div className="dropdown-item separator"></div>
                    <div className="dropdown-item" onClick={() => { toggleGlobalPrivateMode(); setShowStatusMenu(false); }}>
                      {globalPrivateMode ? t.roster.globalPrivateOn : t.roster.globalPrivateOff}
                    </div>
                    <div className="dropdown-item" onClick={() => { setShowOptionsModal(true); setShowStatusMenu(false); }}>{t.roster.optionsMenu}</div>
                    <div className="dropdown-item" onClick={() => { setLanguage(language === 'fr' ? 'en' : 'fr'); setShowStatusMenu(false); }}>
                      🌐 {language === 'fr' ? 'English (EN)' : 'Français (FR)'}
                    </div>
                    <div className="dropdown-item" onClick={() => handleLogout()}>{t.auth.logout}</div>
                    {isDeviceRemembered && (
                      <div 
                        className="dropdown-item" 
                        onClick={() => { handleForgetDevice(); setShowStatusMenu(false); }}
                        style={{ color: '#b33927' }}
                      >
                        🔓 {t.auth.forgetDevice}
                      </div>
                    )}
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
                  maxLength={150}
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
        <ContactRoster
          unreadCounts={unreadCounts}
          pendingInvites={pendingInvites}
          onlineContacts={onlineContacts}
          offlineContacts={offlineContacts}
          activeChatId={activeChatId}
          isGroupOpen={isGroupOpen}
          onToggleOnlineGroup={() => setIsGroupOpen(!isGroupOpen)}
          isOfflineGroupOpen={isOfflineGroupOpen}
          onToggleOfflineGroup={() => setIsOfflineGroupOpen(!isOfflineGroupOpen)}
          isServicesGroupOpen={isServicesGroupOpen}
          onToggleServicesGroup={() => setIsServicesGroupOpen(!isServicesGroupOpen)}
          onOpenChat={openChat}
          onAcceptInvite={handleAcceptInvite}
          onDeclineInvite={handleDeclineInvite}
          onContextMenu={handleContextMenu}
        />
      </div>

      {/* --- FENÊTRE DE CONVERSATION --- */}
      <ChatWindow
        activeChatId={activeChatId}
        hasOpenChats={openChatIds.length > 0}
        isNudging={isNudging}
        onStartBotChat={() => openChat(SYSTEM_BOT_ID)}
        tabs={
          <ChatTabsBar
            openChatIds={openChatIds}
            contacts={contacts}
            activeChatId={activeChatId}
            unreadCounts={unreadCounts}
            draggedTabId={draggedTabId}
            dragOverTabId={dragOverTabId}
            dropPosition={dropPosition}
            isGameTab={(id) => activeGame?.opponentId === id || resumableGames.some(g => g.opponentId === id)}
            onSelectTab={setActiveChatId}
            onCloseTab={closeChat}
            onMobileBack={() => setActiveChatId(0)}
            onDragStart={handleTabDragStart}
            onDragOver={handleTabDragOver}
            onDragLeave={handleTabDragLeave}
            onDrop={handleTabDrop}
            onDragEnd={handleTabDragEnd}
          />
        }
        toolbar={
          <ChatToolbar
            activeChatId={activeChatId}
            activeContact={activeContact}
            globalPrivateMode={globalPrivateMode}
            isPrivateMode={effectivePrivateModes}
            showGamesMenu={showGamesMenu}
            onToggleGamesMenu={() => setShowGamesMenu(prev => !prev)}
            onOpenFiles={() => fileInputRef.current?.click()}
            onOpenBackground={() => setShowBgModal(true)}
            onStartVideo={() => handleStartCall(false)}
            onStartCall={() => handleStartCall(true)}
            onInviteGame={handleInviteGame}
            onTogglePrivateMode={() => {
              if (globalPrivateMode) {
                alert(t.chat.privateModeGlobalAlert);
              } else {
                togglePrivateMode(activeChatId);
              }
            }}
            onOpenSafetyModal={handleOpenSafetyModal}
          />
        }
      >
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
                       {effectivePrivateModes[activeChatId] && (
                         <div className="padlock-badge" title={t.chat.privateModeActive}>🔒</div>
                       )}
                     </div>
                     <div className="conv-info">
                        <div className="conv-name">
                          {formatNickname(activeContact.nickname || activeContact.username)}
                          {activeContact.id === SYSTEM_BOT_ID && <span className="wlm-bot-badge">{t.bot.badge}</span>}
                          {activeContact.id && activeContact.id !== SYSTEM_BOT_ID && (
                            <button
                              type="button"
                              className={`wlm-safety-badge ${verifiedContacts[activeContact.id]?.verified ? 'verified' : 'unverified'}`}
                              title={verifiedContacts[activeContact.id]?.verified ? t.chat.safetyNumberVerifiedBadge : t.chat.safetyNumberUnverifiedBadge}
                              aria-label={verifiedContacts[activeContact.id]?.verified ? t.chat.safetyNumberVerifiedBadge : t.chat.safetyNumberUnverifiedBadge}
                              onClick={() => handleOpenSafetyModal(activeContact.id)}
                            >
                              {verifiedContacts[activeContact.id]?.verified ? (
                                <svg className="wlm-safety-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <path className="shield-base" d="M8 1.5 C10.8 1.5 13.5 2.4 13.5 2.4 C13.5 7.8 11.2 12.1 8 14.5 C4.8 12.1 2.5 7.8 2.5 2.4 C2.5 2.4 5.2 1.5 8 1.5 Z" />
                                  <path className="shield-glyph" d="M5.3 7.9 L7.1 9.8 L10.8 5.7" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              ) : (
                                <svg className="wlm-safety-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <path className="shield-base" d="M8 1.5 C10.8 1.5 13.5 2.4 13.5 2.4 C13.5 7.8 11.2 12.1 8 14.5 C4.8 12.1 2.5 7.8 2.5 2.4 C2.5 2.4 5.2 1.5 8 1.5 Z" />
                                  <path className="shield-glyph-mark" d="M6.3 5.3 C6.3 4.3 7.1 3.7 8 3.7 C8.9 3.7 9.7 4.3 9.7 5.2 C9.7 6.4 8.2 6.7 8.2 7.8" fill="none" strokeWidth="1.6" strokeLinecap="round" />
                                  <circle className="shield-glyph-dot" cx="8" cy="9.9" r="0.85" />
                                </svg>
                              )}
                            </button>
                          )}
                          <span style={{fontSize:'12px', fontWeight:'normal', marginLeft: '10px'}}>
                            ({(activeContact.status === 'offline' || !activeContact.id) ? t.status.offline : t.status.online})
                          </span>
                        </div>
                        <div className="conv-psm">{formatNickname(activeContact.psm) || ((activeContact.status === 'offline' || !activeContact.id) ? '' : t.status.online)}</div>
                     </div>
                  </div>
               </div>

                {/* Alerte de changement d'empreinte / clé publique de sécurité */}
                {keyAlertContactId === activeChatId && (
                  <div className="wlm-key-alert-banner">
                    <div className="wlm-key-alert-icon">⚠️</div>
                    <div className="wlm-key-alert-content">
                      <div className="wlm-key-alert-title">{t.chat.safetyNumberChangedAlertTitle}</div>
                      <div className="wlm-key-alert-desc">{t.chat.safetyNumberChangedAlertText}</div>
                    </div>
                    <div className="wlm-key-alert-actions">
                      <button
                        type="button"
                        className="btn-dialog wlm-btn-verify"
                        onClick={() => handleOpenSafetyModal(activeChatId)}
                      >
                        {t.chat.safetyNumberAction}
                      </button>
                      <button
                        type="button"
                        className="wlm-btn-alert-close"
                        onClick={() => setKeyAlertContactId(null)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}

                {/* Bannière d'invitation à un jeu reçu */}
                {incomingGameInvite && incomingGameInvite.from === activeChatId && (
                  <div className="wlm-game-invite-banner">
                    <div className="wlm-game-invite-info">
                      <span className="wlm-game-invite-icon">
                        {gameIcon(incomingGameInvite.gameType)}
                      </span>
                      <div className="wlm-game-invite-text">
                        <span className="wlm-game-invite-title">
                          {incomingGameInvite.gameType === 'checkers' ? t.games.inviteCheckersTitle
                            : incomingGameInvite.gameType === 'puissance4' ? t.games.invitePuissance4Title
                            : incomingGameInvite.gameType === 'minesweeper' ? t.games.inviteMinesweeperTitle
                            : t.games.inviteMorpionTitle}
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
                          {outgoingGameInvite.gameType === 'checkers' ? t.games.invitePendingCheckers
                            : outgoingGameInvite.gameType === 'puissance4' ? t.games.invitePendingPuissance4
                            : outgoingGameInvite.gameType === 'minesweeper' ? t.games.invitePendingMinesweeper
                            : t.games.invitePendingMorpion}
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
                        {gameIcon(activeGame.gameType)}
                      </span>
                      <div className="docked-pill-texts">
                        <span className="docked-pill-title">
                          {formatNickname(t.games.dockedTitle.replace('{game}', activeGame.gameType === 'checkers' ? t.games.checkers : activeGame.gameType === 'puissance4' ? t.games.puissance4 : activeGame.gameType === 'minesweeper' ? t.games.minesweeper : t.games.morpion).replace('{name}', activeGame.opponentName))}
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

               {/* Historique des messages + actions rapides de l'assistant */}
               <ChatMessageLog
                 messages={messages[activeChatId] || []}
                 activeChatId={activeChatId}
                 contacts={contacts}
                 myId={user?.id}
                 selfDisplayName={myNickname || user?.nickname || user?.username || 'Moi'}
                 myPrivateKeyJwk={myKeys?.privateKeyJwk}
                 chatEndRef={chatEndRef}
                 onResend={handleResendMessage}
                 onAssistantAction={handleAssistantAction}
                 renderMessageContent={renderMessageContent}
                 onPlayWink={(winkId) => { setActiveWink(winkId); setWinkCounter(c => c + 1); }}
               />

               {/* Pied de page (Saisie du message) */}
               <div className="chat-footer">
                  <div className="chat-input-bubble">
                     {/* Champ riche : rend les émoticônes en image pendant la frappe */}
                     <div
                        ref={chatInputRef}
                        className="chat-input-rich"
                        contentEditable
                        suppressContentEditableWarning
                        spellCheck={false}
                        role="textbox"
                        aria-multiline="true"
                        data-placeholder={t.chat.typeMessagePlaceholder}
                        onInput={() => syncRichInput()}
                        onKeyDown={handleRichKeyDown}
                        onPaste={handleRichPaste}
                        style={{
                          fontFamily: fontSettings.family,
                          fontWeight: fontSettings.weight,
                          fontStyle: fontSettings.style,
                          color: fontSettings.color,
                          fontSize: `${fontSettings.size}pt`,
                          textDecoration: `${fontSettings.underline ? 'underline' : ''} ${fontSettings.strikeout ? 'line-through' : ''}`.trim()
                        }}
                     />
                     
                     {/* Barre d'outils du chat (Émoticônes, Winks, Wizz, Voice) */}
                     <div className="chat-toolbar" style={{ position: 'relative' }}>
                        <div ref={emoticonContainerRef} className="emoticon-menu-container">
                        <span className="tool-icon" title={t.chat.emoticonsTooltip} onClick={() => setShowEmoticonMenu(!showEmoticonMenu)}>
                          <img src="/assets/icons/emoticon_official.svg" style={{width:'32px', cursor:'pointer'}} alt={t.chat.emoticonsTooltip} />
                        </span>
                        
                        {showEmoticonMenu && (
                          <>
                          <div className="emoticon-backdrop" onClick={() => setShowEmoticonMenu(false)} />
                          <div className="emoticon-popup" onClick={e => e.stopPropagation()}>
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
                                        onClick={() => { insertChatText(emo.shortcut); setShowEmoticonMenu(false); }}
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
                                  <div key={idx} className="emoticon-item" title={emo.shortcut} onClick={() => { insertChatText(emo.shortcut); setShowEmoticonMenu(false); }}>
                                    <img src={`/assets/emoticons/${emo.file}`} alt={emo.shortcut} width={19} height={19} draggable={false} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                          </>
                        )}
                        </div>

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
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar || undefined}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  myColor={(activeGame.myColor === 'white' || activeGame.myColor === 'black') ? activeGame.myColor : (activeGame.mySymbol === 'W' ? 'white' : 'black')}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={handleGameClose}
                  onMinimize={handleGameMinimize}
                  onGameStateChange={handleGameStateChange}
                />
              ) : activeGame.gameType === 'minesweeper' && activeGame.opponentId !== SYSTEM_BOT_ID ? (
                <MinesweeperGame
                  socket={socket}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={contacts.find(c => c.id === activeGame.opponentId)?.avatar || undefined}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  myColor={activeGame.myColor === 'red' ? 'red' : 'blue'}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={handleGameClose}
                  onMinimize={handleGameMinimize}
                  onGameStateChange={handleGameStateChange}
                />
              ) : activeGame.gameType === 'puissance4' ? (
                <Puissance4Game
                  socket={activeGame.opponentId === SYSTEM_BOT_ID ? null : socket}
                  isBotOpponent={activeGame.opponentId === SYSTEM_BOT_ID}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar || undefined}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  myColor={activeGame.myColor === 'yellow' ? 'yellow' : 'red'}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={handleGameClose}
                  onMinimize={handleGameMinimize}
                  onGameStateChange={handleGameStateChange}
                />
              ) : (
                <MorpionGame
                  socket={activeGame.opponentId === SYSTEM_BOT_ID ? null : socket}
                  isBotOpponent={activeGame.opponentId === SYSTEM_BOT_ID}
                  opponentId={activeGame.opponentId}
                  opponentName={activeGame.opponentName}
                  opponentAvatar={activeGame.opponentId === SYSTEM_BOT_ID ? SYSTEM_BOT_CONTACT.avatar : contacts.find(c => c.id === activeGame.opponentId)?.avatar || undefined}
                  myId={user?.id || 0}
                  myName={myNickname || user?.nickname || 'Moi'}
                  myAvatar={myAvatar}
                  initialSymbol={(activeGame.mySymbol as 'X' | 'O') || 'X'}
                  initialIsMyTurn={activeGame.isMyTurn}
                  onClose={handleGameClose}
                  onMinimize={handleGameMinimize}
                  onGameStateChange={handleGameStateChange}
                />
              )}
            </div>
          )}
        </div>
      </ChatWindow>

      {/* --- MODALES --- */}

      {/* Modale: Vérification de l'empreinte de sécurité (Safety Number) */}
      {showSafetyModal && safetyModalContactId && (() => {
        const modalContact = contacts.find(c => c.id === safetyModalContactId) || (activeContact.id === safetyModalContactId ? activeContact : null);
        const contactName = modalContact ? (modalContact.nickname || modalContact.username) : `#${safetyModalContactId}`;
        const myDisplayName = myNickname || user?.nickname || user?.username || 'Moi';
        const isVerified = !!verifiedContacts[safetyModalContactId]?.verified;
        return (
          <div className="modal-bg" onClick={() => setShowSafetyModal(false)}>
            <div className="modal-box wlm-safety-modal" onClick={e => e.stopPropagation()} style={{ width: '510px' }}>
              <div className="win-modal-header">
                <span>🛡️ {t.chat.safetyNumberTitle} — {formatNickname(contactName)}</span>
                <button type="button" className="win-close-btn" onClick={() => setShowSafetyModal(false)}>✕</button>
              </div>
              <div className="modal-content" style={{ padding: '16px' }}>
                <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: 'var(--text-color, #444)', lineHeight: '1.4' }}>
                  {t.chat.safetyNumberDescription}
                </p>

                <div className="wlm-safety-tip-banner">
                  {t.chat.safetyNumberComparisonTip}
                </div>

                {/* Bloc 1 : Mon Safety Number */}
                <div className="wlm-safety-compare-block">
                  <div className="wlm-safety-compare-header">
                    <span className="wlm-safety-compare-title">👤 {t.chat.safetyNumberMyFingerprintLabel} ({formatNickname(myDisplayName)})</span>
                  </div>
                  <div className="wlm-safety-compare-sub">{t.chat.safetyNumberMyFingerprintSub}</div>
                  <div className="wlm-safety-compare-box">
                    {myFingerprint ? formatSafetyNumber(myFingerprint) : '...'}
                  </div>
                </div>

                {/* Bloc 2 : Safety Number du contact */}
                <div className="wlm-safety-compare-block">
                  <div className="wlm-safety-compare-header">
                    <span className="wlm-safety-compare-title">👤 {formatNickname(t.chat.safetyNumberContactFingerprintLabel.replace('{name}', contactName))}</span>
                  </div>
                  <div className="wlm-safety-compare-sub">{t.chat.safetyNumberContactFingerprintSub}</div>
                  <div className="wlm-safety-compare-box">
                    {activeFingerprint ? formatSafetyNumber(activeFingerprint) : '...'}
                  </div>
                </div>

                {/* Ligne d'état & Confirmation de la vérification humaine */}
                <div className="wlm-safety-status-row">
                  <div className="wlm-safety-status-badge">
                    {isVerified ? (
                      <span className="wlm-badge-verified">✓ {t.chat.safetyNumberVerifiedBadge}</span>
                    ) : (
                      <span className="wlm-badge-unverified">⚪ {t.chat.safetyNumberUnverifiedBadge}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`btn-dialog ${isVerified ? 'btn-unverify' : 'btn-verify'}`}
                    disabled={!activeFingerprint}
                    onClick={() => handleToggleContactVerification(safetyModalContactId, activeFingerprint)}
                  >
                    {isVerified ? t.chat.safetyNumberMarkUnverified : t.chat.safetyNumberMarkVerified}
                  </button>
                </div>

                <div className="modal-buttons" style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn-dialog" onClick={() => setShowSafetyModal(false)}>
                    {t.chat.safetyNumberClose}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

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
        <AllEmoticonsModal
          customEmoticons={myCustomEmoticons}
          customEmoticonsMap={customEmoticonsMap}
          standardEmoticons={EMOTICONS_LIST}
          onSelect={(shortcut) => { insertChatText(shortcut); setShowAllEmoticonsModal(false); }}
          onManage={() => { setShowCustomEmoticonsModal(true); setShowAllEmoticonsModal(false); }}
          onClose={() => setShowAllEmoticonsModal(false)}
        />
      )}

      {/* Modale: Gestionnaire des émoticônes personnalisées (E2EE) */}
      <CustomEmoticonsModal 
        isOpen={showCustomEmoticonsModal}
        onClose={() => setShowCustomEmoticonsModal(false)}
        userToken={user?.token}
        onEmoticonsChange={handleCustomEmoticonsChange}
        onSelectEmoticon={(shortcut) => {
          insertChatText(shortcut);
          setShowCustomEmoticonsModal(false);
        }}
      />

      {/* Modale: Choix du décor (Scène) */}
      {showSceneModal && (
        <SceneModal
          onClose={() => setShowSceneModal(false)}
          onSelect={(file) => {
            setMyScene(`/assets/scenes/${file}`);
            setShowSceneModal(false);
            syncProfile({ scene: `/assets/scenes/${file}` });
          }}
        />
      )}

      {/* Modale: Ajouter un contact */}
      {showAddContactModal && (
        <AddContactModal
          value={contactEmail}
          onChange={setContactEmail}
          onSubmit={handleInvite}
          onClose={() => setShowAddContactModal(false)}
        />
      )}

      {/* Modale: Modifier l'arrière-plan de la discussion */}
      {showBgModal && (
        <BgModal
          onClose={() => setShowBgModal(false)}
          onSelect={(file) => {
            if (activeChatId) {
              setConversationBackgrounds(prev => setConversationBackground(prev, activeChatId, file));
            }
            setShowBgModal(false);
          }}
        />
      )}

      {/* Modale: Choisir une image perso (Avatar) */}
      {showAvatarModal && (
        <AvatarModal
          onClose={() => setShowAvatarModal(false)}
          onSelect={(tile) => {
            setMyAvatar(`/assets/usertiles/${tile}`);
            setShowAvatarModal(false);
            syncProfile({ avatar: `/assets/usertiles/${tile}` });
          }}
        />
      )}

      {/* Modale: Paramètres de la police (Style Windows Classique) */}
      {showFontModal && (
        <FontModal
          settings={fontSettings}
          onChange={setFontSettings}
          onClose={() => setShowFontModal(false)}
        />
      )}

      {/* Modale: Choix d'un Clin d'œil (Wink) */}
      {showWinksModal && (
        <WinksModal
          onClose={() => setShowWinksModal(false)}
          onSelect={(winkId) => handleSendWink(winkId)}
        />
      )}

      {/* Modale: Changement de mot de passe */}
      {showPasswordModal && (
        <PasswordModal
          onClose={() => setShowPasswordModal(false)}
          onSubmit={handleChangePassword}
        />
      )}

      {/* Modale: Réinitialisation des clés de chiffrement E2E */}
      {showResetE2EModal && (
        <div className="modal-bg" onClick={() => !isResettingE2E && setShowResetE2EModal(false)}>
          <div className="modal-box wlm-reset-modal" onClick={e => e.stopPropagation()}>
            <div className="win-modal-header">
              <span>🛡️ {t.modals.resetE2ETitle}</span>
              <button 
                type="button" 
                className="win-close-btn" 
                disabled={isResettingE2E}
                onClick={() => setShowResetE2EModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-content" style={{ padding: '16px' }}>
              <div className="wlm-reset-warning-banner">
                ⚠️ {t.modals.resetE2EWarningIntro}
              </div>

              <ul className="wlm-reset-points-list">
                <li>• {t.modals.resetE2EPoint1}</li>
                <li>• {t.modals.resetE2EPoint2}</li>
                <li>• {t.modals.resetE2EPoint3}</li>
                <li>• {t.modals.resetE2EPoint4}</li>
                <li>• {t.modals.resetE2EPoint5}</li>
                <li>• {t.modals.resetE2EPoint6}</li>
              </ul>

              <form onSubmit={handleConfirmResetE2EKeys}>
                <div className="wlm-reset-password-section">
                  <label htmlFor="reset-e2e-password-input" style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#333', marginBottom: '6px' }}>
                    {t.modals.resetE2EPasswordPrompt}
                  </label>
                  <input
                    id="reset-e2e-password-input"
                    type="password"
                    value={resetE2EPassword}
                    onChange={(e) => { setResetE2EPassword(e.target.value); setResetE2EError(null); }}
                    placeholder={t.modals.resetE2EPasswordPlaceholder}
                    disabled={isResettingE2E}
                    required
                    className="user-name-input"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }}
                    autoFocus
                  />
                  {resetE2EError && (
                    <div className="wlm-reset-error">
                      ⚠ {resetE2EError}
                    </div>
                  )}
                </div>

                <div className="win-modal-footer" style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    type="button"
                    className="win-btn"
                    disabled={isResettingE2E}
                    onClick={() => setShowResetE2EModal(false)}
                  >
                    {t.common.cancel || "Annuler"}
                  </button>
                  <button
                    type="submit"
                    className="win-btn danger"
                    disabled={isResettingE2E || !resetE2EPassword}
                  >
                    {isResettingE2E ? t.modals.resetE2EInProgress : t.modals.resetE2EConfirmBtn}
                  </button>
                </div>
              </form>
            </div>
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
          myKeys={myKeys}
          getContactPublicKey={getPublicKey}
          onEndCall={handleEndCall}
        />
      )}

      {/* Modale: Options (Style MSN classique) */}
      {showOptionsModal && (
        <OptionsModal
          myNickname={myNickname}
          setMyNickname={setMyNickname}
          myPSM={myPSM}
          setMyPSM={setMyPSM}
          enableAutoAway={enableAutoAway}
          setEnableAutoAway={setEnableAutoAway}
          awayTimeout={awayTimeout}
          setAwayTimeout={setAwayTimeout}
          systemIdleEnabled={systemIdleEnabled}
          systemIdleRunning={systemIdleRunning}
          systemIdleSupport={systemIdleSupport}
          enableSystemIdle={enableSystemIdle}
          disableSystemIdle={disableSystemIdle}
          enableDesktopToasts={enableDesktopToasts}
          setEnableDesktopToasts={setEnableDesktopToasts}
          systemPermission={systemPermission}
          prepromptDismissed={prepromptDismissed}
          setPrepromptDismissed={setPrepromptDismissed}
          permissionAttempted={permissionAttempted}
          testAlertFeedback={testAlertFeedback}
          pushStatus={pushStatus}
          pushTestFeedback={pushTestFeedback}
          handleRequestPermission={handleRequestPermission}
          handleTestAlert={handleTestAlert}
          handleTestPush={handleTestPush}
          syncProfile={syncProfile}
          userId={user?.id ?? null}
          socket={socket}
          security={{
            contacts,
            onUnblock: (contactId) => handleBlockContact(contactId, false),
            isDeviceRemembered,
            onForgetDevice: () => { handleForgetDevice(); },
            globalPrivateMode,
            onToggleGlobalPrivate: toggleGlobalPrivateMode,
            safetyNumber: myFingerprint ? formatSafetyNumber(myFingerprint) : '',
            onChangePassword: () => { setShowOptionsModal(false); setShowPasswordModal(true); },
            onResetKeys: () => { setShowOptionsModal(false); handleResetE2EKeys(); },
            onRevokeOtherSessions: revokeOtherSessions
          }}
          onClose={() => setShowOptionsModal(false)}
        />
      )}

      {/* Menu Contextuel (Clic droit sur un contact) */}
      {clearConfirmContactId !== null && (
        <AeroConfirmDialog
          title={t.roster.contextClearHistory}
          message={t.roster.clearHistoryWarning}
          checkboxLabel={t.roster.clearHistoryConfirmCheckbox}
          confirmLabel={t.roster.clearHistoryConfirmBtn}
          cancelLabel={t.common.cancel}
          danger
          onConfirm={() => { const id = clearConfirmContactId; setClearConfirmContactId(null); performClearHistory(id); }}
          onCancel={() => setClearConfirmContactId(null)}
        />
      )}
      {clearNotice && (
        <AeroConfirmDialog
          title={t.roster.contextClearHistory}
          message={clearNotice}
          icon="ℹ️"
          confirmLabel="OK"
          onConfirm={() => setClearNotice(null)}
        />
      )}
      {contextMenu && (
        <div className="wlm-status-dropdown" style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 10000 }}>
          <div className="dropdown-item" onClick={() => openChat(contextMenu.contactId)}>{t.roster.contextSendIM}</div>
          {contextMenu.contactId !== SYSTEM_BOT_ID && (
            <div className="dropdown-item" onClick={() => { handleOpenSafetyModal(contextMenu.contactId); setContextMenu(null); }}>
              🛡️ {t.chat.safetyNumberAction}
            </div>
          )}
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

      {/* Toast de notification non-bloquante (persistance des clés, oubli appareil, etc.) */}
      {persistenceNotice && (
        <div className="wlm-toast-persistence" role="status" aria-live="polite">
          <div className="wlm-toast-content">
            <span className="wlm-toast-icon">ℹ</span>
            <span className="wlm-toast-text">{persistenceNotice}</span>
          </div>
          <button 
            type="button" 
            className="wlm-toast-close"
            onClick={() => setPersistenceNotice(null)}
            title={t.common.cancel || "Fermer"}
          >
            ✕
          </button>
        </div>
      )}

      {/* Alertes et notifications desktop in-app rétro WLM */}
      <DesktopToastContainer
        toasts={toasts}
        onOpenChat={handleToastOpenChat}
        onDismiss={dismissToast}
      />
    </div>
  );
};

export default App;
