import React from 'react';

/**
 * Dictionnaire officiel des raccourcis d'émoticônes rétro Windows Live Messenger / MSN
 * Mappé vers les fichiers GIF authentiques dans /assets/emoticons/
 */
export const NICKNAME_EMOTICON_MAP: Record<string, string> = {
  // Visages et expressions classiques
  ':-)': 'regular_smile.png',
  ':)': 'regular_smile.png',
  ':-D': 'teeth_smile.png',
  ':D': 'teeth_smile.png',
  ':-d': 'teeth_smile.png',
  ':d': 'teeth_smile.png',
  ';-)': 'wink_smile.png',
  ';)': 'wink_smile.png',
  ':-O': 'omg_smile.png',
  ':O': 'omg_smile.png',
  ':-o': 'omg_smile.png',
  ':o': 'omg_smile.png',
  ':-P': 'tongue_smile.png',
  ':P': 'tongue_smile.png',
  ':-p': 'tongue_smile.png',
  ':p': 'tongue_smile.png',
  '(H)': 'shades_smile.png',
  '(h)': 'shades_smile.png',
  ':-@': 'angry_smile.png',
  ':@': 'angry_smile.png',
  ':-S': 'confused_smile.png',
  ':S': 'confused_smile.png',
  ':-s': 'confused_smile.png',
  ':s': 'confused_smile.png',
  ':-$': 'red_smile.png',
  ':$': 'red_smile.png',
  ':-(': 'sad_smile.png',
  ':(': 'sad_smile.png',
  ":'(": 'cry_smile.png',
  ':-|': 'what_smile.png',
  ':|': 'what_smile.png',
  '(A)': 'angel_smile.png',
  '(a)': 'angel_smile.png',
  '(6)': 'devil_smile.png',
  '8o|': 'angry.png',
  '8-|': 'glasses_happy.png',
  '8-)': 'glasses_happy.png',
  '+o(': 'sick.png',
  '<:o)': 'party.png',
  '|-)': 'Sleepy.png',
  '*-)': 'thinking.png',
  ':-#': 'shutup.png',
  ':-*': 'kiss.png',
  '^o)': 'eye-rolling.png',

  // Objets et symboles emblématiques MSN
  '(L)': 'heart.png',
  '(U)': 'broken_heart.png',
  '(u)': 'broken_heart.png',
  '(M)': 'messenger.png',
  '(m)': 'messenger.png',
  '(@)': 'cat.png',
  '(&)': 'dog.png',
  '(sn)': 'escargot.png',
  '(bah)': 'sheep.png',
  '(S)': 'moon.png',
  '(*)': 'star.png',
  '(#)': 'idk.png',
  '(R)': 'rose.png',
  '(r)': 'rain.png',
  '({)': 'guy_hug.png',
  '(})': 'girl_hug.png',
  '(K)': 'kiss.png',
  '(k)': 'kiss.png',
  '(F)': 'rose.png',
  '(f)': 'rose.png',
  '(W)': 'wilted_rose.png',
  '(w)': 'wilted_rose.png',
  '(O)': 'clock.png',
  '(o)': 'clock.png',
  '(ip)': 'airplane.png',
  '(ap)': 'airplane.png',
  '(b)': 'beer_mug.png',
  '(B)': 'beer_mug.png',
  '(d)': 'bowl.png',
  '(D)': 'bowl.png',
  '(c)': 'coffee.png',
  '(C)': 'coffee.png',
  '(co)': 'computer.png',
  '(e)': 'envelope.png',
  '(E)': 'envelope.png',
  '(film)': 'film.png',
  '(g)': 'present.png',
  '(G)': 'present.png',
  '(i)': 'lightbulb.png',
  '(I)': 'lightbulb.png',
  '(l)': 'heart.png',
  '(li)': 'Lightning.png',
  '(LI)': 'Lightning.png',
  '(mp)': 'mobile.png',
  '(n)': 'thumbs_down.png',
  '(N)': 'thumbs_down.png',
  '(8)': 'note.png',
  '(p)': 'phone.png',
  '(P)': 'phone.png',
  '(pi)': 'pizza.png',
  '(pl)': 'plate.png',
  '(um)': 'umbrella.png',
  '(y)': 'thumbs_up.png',
  '(Y)': 'thumbs_up.png'
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
