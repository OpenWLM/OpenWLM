import React from 'react';

/**
 * Dictionnaire officiel des raccourcis d'émoticônes rétro Windows Live Messenger / MSN
 * Mappé vers les fichiers GIF authentiques dans /assets/emoticons/
 */
export const NICKNAME_EMOTICON_MAP: Record<string, string> = {
  // Visages et expressions classiques
  ':-)': 'regular_smile.gif',
  ':)': 'regular_smile.gif',
  ':-D': 'teeth_smile.gif',
  ':D': 'teeth_smile.gif',
  ':-d': 'teeth_smile.gif',
  ':d': 'teeth_smile.gif',
  ';-)': 'wink_smile.gif',
  ';)': 'wink_smile.gif',
  ':-O': 'omg_smile.gif',
  ':O': 'omg_smile.gif',
  ':-o': 'omg_smile.gif',
  ':o': 'omg_smile.gif',
  ':-P': 'tongue_smile.gif',
  ':P': 'tongue_smile.gif',
  ':-p': 'tongue_smile.gif',
  ':p': 'tongue_smile.gif',
  '(H)': 'shades_smile.gif',
  '(h)': 'shades_smile.gif',
  ':-@': 'angry_smile.gif',
  ':@': 'angry_smile.gif',
  ':-S': 'confused_smile.gif',
  ':S': 'confused_smile.gif',
  ':-s': 'confused_smile.gif',
  ':s': 'confused_smile.gif',
  ':-$': 'red_smile.gif',
  ':$': 'red_smile.gif',
  ':-(': 'sad_smile.gif',
  ':(': 'sad_smile.gif',
  ":'(": 'cry_smile.gif',
  ':-|': 'what_smile.gif',
  ':|': 'what_smile.gif',
  '(A)': 'angel_smile.gif',
  '(a)': 'angel_smile.gif',
  '(6)': 'devil_smile.gif',
  '8o|': 'angry.gif',
  '8-|': 'glasses_happy.gif',
  '8-)': 'glasses_happy.gif',
  '+o(': 'sick.gif',
  '<:o)': 'party.gif',
  '|-)': 'Sleepy.gif',
  '*-)': 'thinking.gif',
  ':-#': 'shutup.gif',
  ':-*': 'kiss.gif',
  '^o)': 'eye-rolling.gif',

  // Objets et symboles emblématiques MSN
  '(L)': 'heart.gif',
  '(U)': 'broken_heart.gif',
  '(u)': 'broken_heart.gif',
  '(M)': 'messenger.gif',
  '(m)': 'messenger.gif',
  '(@)': 'cat.gif',
  '(&)': 'dog.gif',
  '(sn)': 'escargot.gif',
  '(bah)': 'sheep.gif',
  '(S)': 'moon.gif',
  '(*)': 'star.gif',
  '(#)': 'idk.gif',
  '(R)': 'rose.gif',
  '(r)': 'rain.gif',
  '({)': 'guy_hug.gif',
  '(})': 'girl_hug.gif',
  '(K)': 'kiss.gif',
  '(k)': 'kiss.gif',
  '(F)': 'rose.gif',
  '(f)': 'rose.gif',
  '(W)': 'wilted_rose.gif',
  '(w)': 'wilted_rose.gif',
  '(O)': 'clock.gif',
  '(o)': 'clock.gif',
  '(ip)': 'airplane.gif',
  '(ap)': 'airplane.gif',
  '(b)': 'beer_mug.gif',
  '(B)': 'beer_mug.gif',
  '(d)': 'bowl.gif',
  '(D)': 'bowl.gif',
  '(c)': 'coffee.gif',
  '(C)': 'coffee.gif',
  '(co)': 'computer.gif',
  '(e)': 'envelope.gif',
  '(E)': 'envelope.gif',
  '(film)': 'film.gif',
  '(g)': 'present.gif',
  '(G)': 'present.gif',
  '(i)': 'lightbulb.gif',
  '(I)': 'lightbulb.gif',
  '(l)': 'heart.gif',
  '(li)': 'Lightning.gif',
  '(LI)': 'Lightning.gif',
  '(mp)': 'mobile.gif',
  '(n)': 'thumbs_down.gif',
  '(N)': 'thumbs_down.gif',
  '(8)': 'note.gif',
  '(p)': 'phone.gif',
  '(P)': 'phone.gif',
  '(pi)': 'pizza.gif',
  '(pl)': 'plate.gif',
  '(um)': 'umbrella.gif',
  '(y)': 'thumbs_up.gif',
  '(Y)': 'thumbs_up.gif'
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Construction précompilée de l'expression régulière triée par longueur décroissante
const SORTED_SHORTCUTS = Object.keys(NICKNAME_EMOTICON_MAP).sort((a, b) => b.length - a.length);
const NICKNAME_EMOTICON_REGEX = new RegExp(`(${SORTED_SHORTCUTS.map(escapeRegex).join('|')})`, 'g');

// Caractères déclencheurs pour le fast-path (évite toute allocation pour les pseudos standards)
const SHORTCUT_TRIGGER_CHARS = /[:;(8+<|^*]/;

export interface FormatNicknameOptions {
  className?: string;
  keyPrefix?: string;
}

/**
 * Analyse et formate un pseudo/nom en remplaçant les codes d'émoticônes reconnus
 * par des balises <img> authentiques et proportionnées au texte.
 * Si aucun code n'est présent, retourne le texte brut sans allocation.
 */
export function formatNickname(
  text: string | null | undefined,
  options?: FormatNicknameOptions
): React.ReactNode {
  if (!text || typeof text !== 'string') {
    return text || '';
  }

  // Fast-Path : pas de caractère déclencheur = chaîne primitive directe
  if (!SHORTCUT_TRIGGER_CHARS.test(text)) {
    return text;
  }

  // Découpage en jetons
  const parts = text.split(NICKNAME_EMOTICON_REGEX);
  if (parts.length === 1 && !NICKNAME_EMOTICON_MAP[parts[0]]) {
    return text;
  }

  const className = options?.className || 'nickname-emoticon';
  const prefix = options?.keyPrefix || 'nick-emo';
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    const file = NICKNAME_EMOTICON_MAP[part];
    if (file) {
      elements.push(
        <img
          key={`${prefix}-${i}`}
          src={`/assets/emoticons/${file}`}
          alt={part}
          title={part}
          className={className}
          draggable={false}
        />
      );
    } else {
      elements.push(part);
    }
  }

  return elements.length === 1 ? elements[0] : elements;
}

export interface FormattedNicknameProps {
  text: string | null | undefined;
  className?: string;
}

export const FormattedNickname: React.FC<FormattedNicknameProps> = ({ text, className }) => {
  return <>{formatNickname(text, { className })}</>;
};

export default FormattedNickname;
