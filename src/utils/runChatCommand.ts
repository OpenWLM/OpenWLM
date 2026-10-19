import { SYSTEM_BOT_ID, type Contact } from '../types';
import type { QuickText } from './appPrefs';
import { BUILTIN_COMMANDS, parseChatInput } from './chatCommands';
import { notify } from './dialogs';
import { stripPlusTags } from './plusFormat';

/**
 * EXÉCUTION DES COMMANDES « / »
 *
 * L'analyse est dans chatCommands.ts ; ici, l'exécution. Tout ce qui touche à l'état de
 * l'application (statut, profil, envoi…) est fourni par l'appelant via `ChatCommandContext`,
 * ce qui garde ce module indépendant de App.tsx.
 */

type Texts = {
  unknownCommand: string;
  missingParameter: string;
  argText: string;
  nickTooLong: string;
  psmTooLong: string;
  allNone: string;
  allSent: string;
};

export interface ChatCommandContext {
  /** Conversation où la commande est tapée. */
  chatId: number;
  contacts: Contact[];
  openChatIds: number[];
  quickTexts: QuickText[];
  texts: Texts;
  clearInput: () => void;
  clearConversation: (chatId: number) => void;
  setStatus: (status: 'online' | 'busy' | 'away' | 'offline') => void;
  setNickname: (nickname: string) => void;
  setPsm: (psm: string) => void;
  sendText: (chatId: number, text: string) => Promise<boolean>;
  signOut: () => void;
  openHelp: () => void;
}

/** Résultat : texte à envoyer (texte simple, texte rapide, /me) ou null si déjà traité. */
export type ChatCommandResult = { text: string; action?: boolean } | null;

// Mêmes bornes que le serveur (server/utils/plusText.js) : longueur visible / brute
const NICK_MAX = 50, NICK_MAX_RAW = 300, PSM_MAX = 150, PSM_MAX_RAW = 600;

/** Nom simple (sans balises) d'une conversation, pour (!N) des textes rapides. */
const plainContactName = (chatId: number, contacts: Contact[]) => {
  if (chatId === SYSTEM_BOT_ID) return 'OpenWLM';
  const c = contacts.find(x => x.id === chatId);
  return (c && (stripPlusTags(c.nickname) || c.username)) || '';
};

export const runChatCommand = async (raw: string, ctx: ChatCommandContext): Promise<ChatCommandResult> => {
  const { texts: tx } = ctx;
  const parsed = parseChatInput(raw, ctx.quickTexts, plainContactName(ctx.chatId, ctx.contacts));
  if (parsed.kind === 'text' || parsed.kind === 'quickText') return { text: parsed.text };
  if (parsed.kind === 'unknown') {
    notify(tx.unknownCommand.replace('{name}', parsed.name), { icon: '⚠️' });
    return null;
  }
  const { name, arg } = parsed;
  const info = BUILTIN_COMMANDS.find(c => c.name === name);
  if (info?.needsArg && !arg) {
    notify(tx.missingParameter.split('{name}').join(name).replace('{usage}', `<${tx.argText}>`), { icon: '⚠️' });
    return null;
  }
  const done = () => { ctx.clearInput(); return null; };
  switch (name) {
    case 'me': return { text: arg, action: true };
    case 'clear':
      ctx.clearConversation(ctx.chatId);
      return done();
    case 'online': case 'busy': case 'away': case 'offline':
      ctx.setStatus(name);
      return done();
    case 'nick':
      if (arg.length > NICK_MAX_RAW || stripPlusTags(arg).length > NICK_MAX) { notify(tx.nickTooLong, { icon: '⚠️' }); return null; }
      ctx.setNickname(arg);
      return done();
    case 'psm':
      if (arg.length > PSM_MAX_RAW || stripPlusTags(arg).length > PSM_MAX) { notify(tx.psmTooLong, { icon: '⚠️' }); return null; }
      ctx.setPsm(arg);
      return done();
    case 'all': {
      const targets = ctx.openChatIds.filter(id => id !== SYSTEM_BOT_ID);
      if (targets.length === 0) { notify(tx.allNone); return null; }
      let sent = 0;
      for (const id of targets) if (await ctx.sendText(id, arg)) sent++;
      notify(tx.allSent.replace('{count}', String(sent)), { icon: '✅' });
      return done();
    }
    case 'signout':
      ctx.clearInput();
      ctx.signOut();
      return null;
    case 'help':
      ctx.openHelp();
      return done();
  }
  return null;
};
