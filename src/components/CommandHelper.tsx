import React from 'react';
import { useI18n } from '../i18n';
import type { commandSuggestions } from '../utils/chatCommands';
import { stripPlusTags } from '../utils/plusFormat';

/**
 * Liste des commandes « / » et textes rapides correspondant à la saisie en cours, affichée
 * au-dessus du champ. Un clic complète la commande (Tab fait de même, géré par le champ).
 */

type Suggestions = NonNullable<ReturnType<typeof commandSuggestions>>;

/** Nombre maximal de lignes affichées. */
const MAX_ITEMS = 8;

export const CommandHelper: React.FC<{ items: Suggestions; onPick: (name: string) => void }> = ({ items, onPick }) => {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="cmd-helper" role="listbox" aria-label={t.extras.helperHint} data-testid="command-helper">
      {items.slice(0, MAX_ITEMS).map(c => (
        <div
          key={`${c.kind}-${c.name}`}
          className="cmd-helper-item"
          role="option"
          aria-selected={false}
          // mousedown + preventDefault : le champ de saisie garde le focus
          onMouseDown={e => { e.preventDefault(); onPick(c.name); }}
        >
          <span className="cmd-helper-name">/{c.name}{c.kind === 'command' && c.needsArg ? ` <${t.extras.argText}>` : ''}</span>
          <span className="cmd-helper-desc">{c.kind === 'command' ? t.extras[c.descKey] : `${t.extras.quickTextTag} : ${stripPlusTags(c.text)}`}</span>
        </div>
      ))}
      <div className="cmd-helper-hint">{t.extras.helperHint}</div>
    </div>
  );
};

export default CommandHelper;
