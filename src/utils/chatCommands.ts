import type { QuickText } from './appPrefs';

/**
 * COMMANDES « / » DANS LES CONVERSATIONS
 *
 * Une saisie qui commence par « / » est une commande (/me, /busy…) ou un texte rapide
 * (« /raccourci », Options → Messages). « // » envoie un message qui commence par « / ».
 * Le traitement (statut, envoi…) est fait par l'appelant ; ce module ne fait qu'analyser.
 */

export type BuiltinCommand = 'me' | 'clear' | 'online' | 'busy' | 'away' | 'offline' | 'nick' | 'psm' | 'all' | 'signout' | 'help';

export interface CommandInfo {
  name: BuiltinCommand;
  /** La commande attend un texte après son nom. */
  needsArg: boolean;
  /** Clé de description dans t.extras. */
  descKey: 'cmdMe' | 'cmdClear' | 'cmdOnline' | 'cmdBusy' | 'cmdAway' | 'cmdOffline' | 'cmdNick' | 'cmdPsm' | 'cmdAll' | 'cmdSignout' | 'cmdHelp';
}

export const BUILTIN_COMMANDS: readonly CommandInfo[] = [
  { name: 'me', needsArg: true, descKey: 'cmdMe' },
  { name: 'clear', needsArg: false, descKey: 'cmdClear' },
  { name: 'online', needsArg: false, descKey: 'cmdOnline' },
  { name: 'busy', needsArg: false, descKey: 'cmdBusy' },
  { name: 'away', needsArg: false, descKey: 'cmdAway' },
  { name: 'offline', needsArg: false, descKey: 'cmdOffline' },
  { name: 'nick', needsArg: true, descKey: 'cmdNick' },
  { name: 'psm', needsArg: true, descKey: 'cmdPsm' },
  { name: 'all', needsArg: true, descKey: 'cmdAll' },
  { name: 'signout', needsArg: false, descKey: 'cmdSignout' },
  { name: 'help', needsArg: false, descKey: 'cmdHelp' }
];

export const isBuiltinCommand = (name: string): name is BuiltinCommand =>
  BUILTIN_COMMANDS.some((c) => c.name === name);

export type ParsedInput =
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: BuiltinCommand; arg: string }
  | { kind: 'quickText'; text: string }
  | { kind: 'unknown'; name: string };

const COMMAND_RE = /^\/([a-z0-9_?-]+)(?:\s+([\s\S]*))?$/i;

/**
 * Analyse une saisie. `contactName` remplace (!N) dans les textes rapides (texte simple, sans
 * balises de mise en forme).
 */
export const parseChatInput = (input: string, quickTexts: QuickText[], contactName: string): ParsedInput => {
  if (!input.startsWith('/')) return { kind: 'text', text: input };
  if (input.startsWith('//')) return { kind: 'text', text: input.slice(1) };
  const m = COMMAND_RE.exec(input.trim());
  if (!m) return { kind: 'text', text: input };
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  if (isBuiltinCommand(name)) return { kind: 'command', name, arg };
  const qt = quickTexts.find((q) => q.shortcut === name);
  if (qt) {
    const text = qt.text.replace(/\(!N\)/g, contactName);
    return { kind: 'quickText', text: arg ? `${text} ${arg}` : text };
  }
  return { kind: 'unknown', name };
};

/** Suggestions pour la saisie en cours (« /bu » → /busy) : commandes puis textes rapides. */
export const commandSuggestions = (input: string, quickTexts: QuickText[]) => {
  if (!input.startsWith('/') || input.startsWith('//') || /\s/.test(input)) return null;
  const prefix = input.slice(1).toLowerCase();
  const builtins = BUILTIN_COMMANDS.filter((c) => c.name.startsWith(prefix)).map((c) => ({ kind: 'command' as const, ...c }));
  const quick = quickTexts.filter((q) => q.shortcut.startsWith(prefix)).map((q) => ({ kind: 'quickText' as const, name: q.shortcut, text: q.text }));
  return [...builtins, ...quick];
};
