import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import axios from 'axios';
import SoundManager from '../utils/SoundManager';
import LocalDB from '../utils/LocalDB';
import { removeConversationBackground } from '../utils/ConversationBackgrounds';
import type { Contact, Message, User } from '../types';
import { useI18n } from '../i18n';
import { serverErrorText } from '../utils/serverError';
import { notify, askConfirm } from '../utils/dialogs';

/**
 * DOMAINE CONTACTS (roster, invitations, menu contextuel)
 *
 * Regroupe l'état et les actions qui entourent le carnet de contacts :
 * - liste des contacts et invitations en attente, avec rafraîchissement périodique ;
 * - recherche dans le roster, menu contextuel, confirmation d'effacement d'historique ;
 * - blocage / suppression / effacement d'historique, envoi et réponse aux invitations.
 *
 * Les actions qui débordent sur d'autres domaines (navigation d'onglets, fonds de
 * conversation, liste de messages, modale d'ajout de contact) reçoivent les setters
 * concernés en paramètres, plutôt que de les posséder.
 */

interface ContextMenuState {
  x: number;
  y: number;
  contactId: number;
}

export interface UseContactsOptions {
  user: User | null;
  /** Cache des clés publiques, alimenté depuis les contacts renvoyés par le serveur. */
  setPublicKeysCache: Dispatch<SetStateAction<Record<number, any>>>;
  /** Messages par conversation (l'effacement d'historique purge l'entrée du contact). */
  setMessages: Dispatch<SetStateAction<Record<number, Message[]>>>;
  activeChatId: number;
  setActiveChatId: Dispatch<SetStateAction<number>>;
  setOpenChatIds: Dispatch<SetStateAction<number[]>>;
  setConversationBackgrounds: Dispatch<SetStateAction<Record<number, string>>>;
  contactEmail: string;
  setContactEmail: Dispatch<SetStateAction<string>>;
  setShowAddContactModal: Dispatch<SetStateAction<boolean>>;
  /** Texte d'erreur (i18n) affiché si l'effacement d'historique échoue. */
  clearHistoryErrorText: string;
}

export interface ContactsApi {
  contacts: Contact[];
  setContacts: Dispatch<SetStateAction<Contact[]>>;
  contactsRef: { current: Contact[] };
  pendingInvites: any[];
  setPendingInvites: Dispatch<SetStateAction<any[]>>;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  contextMenu: ContextMenuState | null;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  clearConfirmContactId: number | null;
  setClearConfirmContactId: Dispatch<SetStateAction<number | null>>;
  clearNotice: string | null;
  setClearNotice: Dispatch<SetStateAction<string | null>>;
  refreshData: () => Promise<void>;
  handleBlockContact: (contactId: number, block: boolean) => Promise<void>;
  handleDeleteContact: (contactId: number) => Promise<void>;
  handleClearHistory: (contactId: number) => void;
  performClearHistory: (contactId: number) => Promise<void>;
  handleContextMenu: (e: React.MouseEvent, contactId: number) => void;
  handleInvite: () => Promise<void>;
  handleAcceptInvite: (invitationId: number) => Promise<void>;
  handleDeclineInvite: (invitationId: number) => Promise<void>;
}

export function useContacts(options: UseContactsOptions): ContactsApi {
  const { t, language } = useI18n();
  const {
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
    clearHistoryErrorText
  } = options;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const contactsRef = useRef<Contact[]>([]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  const isInitialContactsLoadRef = useRef(true);
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clearConfirmContactId, setClearConfirmContactId] = useState<number | null>(null);
  const [clearNotice, setClearNotice] = useState<string | null>(null);

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
            } catch (e) {}
          }
        });
        setPublicKeysCache(prev => ({ ...prev, ...newKeys }));
      }
      if (Array.isArray(resInvites.data)) setPendingInvites(resInvites.data);
    } catch (err) {
      console.error("Erreur lors du rafraîchissement des données:", err);
    }
  }, [user, setPublicKeysCache]);

  // Rafraîchissement des contacts & invitations (immédiat puis toutes les 15 s)
  useEffect(() => {
    if (user) {
      refreshData();
      const interval = setInterval(refreshData, 15000); // Rafraîchissement toutes les 15s
      return () => clearInterval(interval);
    }
  }, [user, refreshData]);

  /**
   * GESTION DES CONTACTS (Blocage, Suppression)
   */
  const handleBlockContact = useCallback(async (contactId: number, block: boolean) => {
    if (!user) return;
    try {
      await axios.post('/api/contacts/block', { userId: user.id, contactId, block });
      refreshData();
      setContextMenu(null);
    } catch (err) {
      console.error("Erreur lors du blocage/déblocage:", err);
    }
  }, [user, refreshData]);

  const handleDeleteContact = useCallback(async (contactId: number) => {
    if (!user) return;
    if (!(await askConfirm(t.notices.deleteContactConfirm, { danger: true, confirmLabel: t.common.delete, icon: '⚠️' }))) return;
    try {
      await axios.post('/api/contacts/delete', { userId: user.id, contactId });
      refreshData();
      setContextMenu(null);
      if (activeChatId === contactId) setActiveChatId(0);
      setOpenChatIds(prev => prev.filter(id => id !== contactId));
      setConversationBackgrounds(prev => removeConversationBackground(prev, contactId));
    } catch (err) {
      console.error("Erreur lors de la suppression du contact:", err);
    }
  }, [user, refreshData, activeChatId, setActiveChatId, setOpenChatIds, setConversationBackgrounds]);

  const handleClearHistory = useCallback((contactId: number) => {
    if (!user) return;
    setContextMenu(null);
    setClearConfirmContactId(contactId);
  }, [user]);

  const performClearHistory = useCallback(async (contactId: number) => {
    if (!user) return;
    try {
      // 1. Supprimer sur le serveur (efface l'historique des DEUX côtés)
      await axios.post('/api/messages/clear', { userId: user.id, contactId });

      // 2. Supprimer en local (IndexedDB)
      await LocalDB.clearHistory(`${user.id}_${contactId}`);

      // 3. Mettre à jour l'état React
      setMessages(prev => {
        const next = { ...prev };
        delete next[contactId];
        return next;
      });
    } catch (err) {
      console.error("Erreur lors de la suppression de l'historique:", err);
      setClearNotice(clearHistoryErrorText);
    }
  }, [user, setMessages, clearHistoryErrorText]);

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
      notify(t.notices.inviteSent, { icon: '✅' });
      setShowAddContactModal(false);
      setContactEmail('');
    } catch (err: any) {
      notify(serverErrorText(err, t, language, t.notices.inviteFailed), { icon: '⚠️' });
    }
  };

  const handleAcceptInvite = useCallback(async (invitationId: number) => {
    try {
      await axios.post('/api/accept-invite', { invitationId, userId: user?.id });
      refreshData();
    } catch (err) {
      console.error("Erreur acceptation invitation:", err);
    }
  }, [user, refreshData]);

  const handleDeclineInvite = useCallback(async (invitationId: number) => {
    try {
      await axios.post('/api/decline-invite', { invitationId });
      refreshData();
    } catch (err) {
      console.error("Erreur refus invitation:", err);
    }
  }, [refreshData]);

  return {
    contacts,
    setContacts,
    contactsRef,
    pendingInvites,
    setPendingInvites,
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
  };
}
