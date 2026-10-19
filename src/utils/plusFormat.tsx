import React from 'react';

/**
 * MISE EN FORME DES PSEUDOS, MESSAGES PERSO ET MESSAGES (couleurs, gras, dégradés…)
 *
 * Syntaxe (popularisée à l'époque par les extensions de messagerie) :
 *   [b]gras[/b]  [i]italique[/i]  [u]souligné[/u]  [s]barré[/s]
 *   [c=4]texte rouge[/c]   [c=#00AA00]texte vert[/c]   (couleur : numéro 0-15 ou #RRGGBB)
 *   [a=8]fond jaune[/a]                                  (couleur de fond)
 *   [c=4]dégradé[/c=12]   [a=4]fond en dégradé[/a=12]    (dégradé : couleur de fin à la fermeture)
 *   Codes courts « · » (point médian) : ·$4 couleur, ·#RRGGBB couleur, ·b ·i ·u ·s bascules,
 *   ·0 réinitialise tout.
 *
 * Sûreté : le texte est découpé en segments rendus par React (aucun HTML injecté) ; seules des
 * couleurs validées (palette ou #RRGGBB) arrivent dans les styles. Les balises inconnues ou
 * invalides restent affichées telles quelles.
 */

/** Les 16 couleurs classiques (numéros 0 à 15). */
export const PLUS_COLORS: readonly string[] = [
  '#FFFFFF', '#000000', '#00007F', '#009300', '#FF0000', '#7F0000', '#9C009C', '#FC7F00',
  '#FFFF00', '#00FC00', '#009393', '#00FFFF', '#0000FC', '#FF00FF', '#7F7F7F', '#D2D2D2'
];

const COLOR_VALUE = '(#[0-9a-fA-F]{6}|1[0-5]|[0-9])';
// Balises [b] [/b] … [c=…] [/c] [/c=…] [a=…] [/a] [/a=…], puis codes « · »
const TOKEN_RE = new RegExp(
  `\\[(\\/?)(b|i|u|s)\\]|\\[(c|a)=${COLOR_VALUE}\\]|\\[\\/(c|a)(?:=${COLOR_VALUE})?\\]|·(?:\\$${COLOR_VALUE}|#([0-9a-fA-F]{6})|([biusBIUS0]))`,
  'g'
);
const QUICK_TEST = /\[(?:\/?[biusBIUS]|\/?[caCA](?:=[^\]]{1,7})?)\]|·/;

const toColor = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (value.startsWith('#')) return value.toUpperCase();
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < PLUS_COLORS.length ? PLUS_COLORS[n] : undefined;
};

/** Le texte contient-il (peut-être) de la mise en forme ? Test rapide, sans analyse. */
export const hasPlusFormatting = (text: string | null | undefined): boolean => !!text && QUICK_TEST.test(text);

/** Texte sans aucune balise (notifications, titres, comptage de longueur…). */
export const stripPlusTags = (text: string | null | undefined): string =>
  text ? text.replace(TOKEN_RE, '') : '';

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  bg?: string;
  /** Groupe de dégradé de texte / de fond (défini seulement si la balise fermante donne une couleur de fin). */
  colorGrad?: number;
  bgGrad?: number;
}

const parseSegments = (text: string) => {
  const segments: Segment[] = [];
  const gradients = new Map<number, [string, string]>();
  let state: Omit<Segment, 'text'> = { bold: false, italic: false, underline: false, strike: false };
  let nextGrad = 1;
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), ...state });
    last = TOKEN_RE.lastIndex;
    const [, slash, style, openKind, openValue, closeKind, closeValue, dotColor, dotHex, dotFlag] = m;
    if (style) {
      const on = slash !== '/';
      if (style === 'b') state = { ...state, bold: on };
      else if (style === 'i') state = { ...state, italic: on };
      else if (style === 'u') state = { ...state, underline: on };
      else state = { ...state, strike: on };
    } else if (openKind) {
      const color = toColor(openValue);
      if (openKind === 'c') state = { ...state, color, colorGrad: nextGrad++ };
      else state = { ...state, bg: color, bgGrad: nextGrad++ };
    } else if (closeKind) {
      const end = toColor(closeValue);
      if (closeKind === 'c') {
        if (end && state.color && state.colorGrad) gradients.set(state.colorGrad, [state.color, end]);
        state = { ...state, color: undefined, colorGrad: undefined };
      } else {
        if (end && state.bg && state.bgGrad) gradients.set(state.bgGrad, [state.bg, end]);
        state = { ...state, bg: undefined, bgGrad: undefined };
      }
    } else if (dotColor || dotHex) {
      state = { ...state, color: toColor(dotColor ?? `#${dotHex}`), colorGrad: undefined };
    } else if (dotFlag) {
      const f = dotFlag.toLowerCase();
      if (f === '0') state = { bold: false, italic: false, underline: false, strike: false };
      else if (f === 'b') state = { ...state, bold: !state.bold };
      else if (f === 'i') state = { ...state, italic: !state.italic };
      else if (f === 'u') state = { ...state, underline: !state.underline };
      else state = { ...state, strike: !state.strike };
    }
  }
  if (last < text.length) segments.push({ text: text.slice(last), ...state });
  return { segments: segments.filter((s) => s.text !== ''), gradients };
};

const segmentStyle = (s: Segment, inColorGradient: boolean, inBgGradient: boolean): React.CSSProperties => {
  const deco = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  return {
    fontWeight: s.bold ? 'bold' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: deco || undefined,
    color: inColorGradient ? undefined : s.color,
    backgroundColor: inBgGradient ? undefined : s.bg
  };
};

/**
 * Rendu React d'un texte mis en forme. `renderInner` met en forme le texte brut de chaque
 * segment (émoticônes…) ; `keyPrefix` évite les collisions de clés.
 */
export const renderPlusText = (
  text: string,
  renderInner: (plain: string, key: string) => React.ReactNode,
  keyPrefix = 'fmt'
): React.ReactNode => {
  const { segments, gradients } = parseSegments(text);
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    const colorGrad = seg.colorGrad !== undefined ? gradients.get(seg.colorGrad) : undefined;
    const bgGrad = !colorGrad && seg.bgGrad !== undefined ? gradients.get(seg.bgGrad) : undefined;
    if (colorGrad || bgGrad) {
      // Segments consécutifs du même dégradé : un seul conteneur, pour un dégradé continu
      const groupKey = colorGrad ? seg.colorGrad : seg.bgGrad;
      const group: React.ReactNode[] = [];
      while (i < segments.length && (colorGrad ? segments[i].colorGrad === groupKey : segments[i].bgGrad === groupKey)) {
        const s = segments[i];
        group.push(<span key={`${keyPrefix}-${i}`} style={segmentStyle(s, !!colorGrad, !!bgGrad)}>{renderInner(s.text, `${keyPrefix}-${i}`)}</span>);
        i++;
      }
      const [from, to] = (colorGrad || bgGrad)!;
      out.push(
        <span
          key={`${keyPrefix}-g${i}`}
          className={colorGrad ? 'fmt-gradient-text' : 'fmt-gradient-bg'}
          style={colorGrad
            ? { backgroundImage: `linear-gradient(90deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }
            : { backgroundImage: `linear-gradient(90deg, ${from}, ${to})` }}
        >
          {group}
        </span>
      );
      continue;
    }
    const style = segmentStyle(seg, false, false);
    const plain = !style.fontWeight && !style.fontStyle && !style.textDecoration && !style.color && !style.backgroundColor;
    out.push(plain
      ? <React.Fragment key={`${keyPrefix}-${i}`}>{renderInner(seg.text, `${keyPrefix}-${i}`)}</React.Fragment>
      : <span key={`${keyPrefix}-${i}`} style={style}>{renderInner(seg.text, `${keyPrefix}-${i}`)}</span>);
    i++;
  }
  return out;
};

/** Longueur visible (sans balises) : c'est elle que limitent le pseudo et le message perso. */
export const visibleLength = (text: string) => stripPlusTags(text).length;
