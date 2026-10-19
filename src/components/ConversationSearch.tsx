import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Recherche dans la conversation affichée (Ctrl+F). Surligne les résultats sans toucher au
 * contenu des messages (API CSS Custom Highlight : ::highlight(wlm-search)), et fait défiler
 * jusqu'au résultat courant. Entrée : résultat suivant (vers les plus anciens), Maj+Entrée :
 * précédent, Échap : fermer. Navigateur sans cette API : le message du résultat est encadré.
 */

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): HighlightRegistry | null =>
  (typeof CSS !== 'undefined' && (CSS as unknown as { highlights?: HighlightRegistry }).highlights) || null;
const HighlightCtor = (): (new (...r: Range[]) => unknown) | null =>
  (typeof window !== 'undefined' && (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight) || null;

const findRanges = (container: Element, query: string): Range[] => {
  const needle = query.toLocaleLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || '').toLocaleLowerCase();
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + needle.length);
      ranges.push(r);
      from = idx + needle.length;
    }
  }
  return ranges;
};

export const ConversationSearch: React.FC<{ contentKey: unknown; onClose: () => void }> = ({ contentKey, onClose }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const markedRef = useRef<Element | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Résultats (recalculés si la conversation change ou reçoit des messages)
  // (à l'image suivante : la conversation est alors affichée avec ses derniers messages)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = document.querySelector('.chat-log-scroll');
      const found = container && query.trim() ? findRanges(container, query.trim()) : [];
      setRanges(found);
      setCurrent(found.length > 0 ? found.length - 1 : 0); // le plus récent d'abord
    });
    return () => cancelAnimationFrame(frame);
  }, [query, contentKey]);

  // Surlignage + défilement jusqu'au résultat courant
  useEffect(() => {
    const reg = highlights();
    const Ctor = HighlightCtor();
    markedRef.current?.classList.remove('search-current-msg');
    markedRef.current = null;
    if (reg && Ctor) {
      reg.set('wlm-search', new Ctor(...ranges));
      reg.set('wlm-search-current', ranges[current] ? new Ctor(ranges[current]) : new Ctor());
    }
    const target = ranges[current]?.startContainer.parentElement;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      if (!reg || !Ctor) {
        markedRef.current = target.closest('.msg-line');
        markedRef.current?.classList.add('search-current-msg');
      }
    }
  }, [ranges, current]);

  // Nettoyage à la fermeture
  useEffect(() => () => {
    highlights()?.delete('wlm-search');
    highlights()?.delete('wlm-search-current');
    markedRef.current?.classList.remove('search-current-msg');
  }, []);

  const step = (dir: -1 | 1) => {
    if (ranges.length === 0) return;
    setCurrent(c => (c + dir + ranges.length) % ranges.length);
  };

  return (
    <div className="conv-search" role="search" data-testid="conversation-search">
      <span aria-hidden="true">🔍</span>
      <input
        ref={inputRef}
        className="conv-search-input"
        placeholder={t.extras.searchPlaceholder}
        aria-label={t.extras.searchPlaceholder}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
      />
      <span className="conv-search-count" data-testid="search-count" aria-live="polite">
        {query.trim() ? (ranges.length ? `${current + 1}/${ranges.length}` : t.extras.searchNoResult) : ''}
      </span>
      <button type="button" className="conv-search-btn" title={t.extras.searchPrev} aria-label={t.extras.searchPrev} onClick={() => step(-1)} disabled={!ranges.length}>▲</button>
      <button type="button" className="conv-search-btn" title={t.extras.searchNext} aria-label={t.extras.searchNext} onClick={() => step(1)} disabled={!ranges.length}>▼</button>
      <button type="button" className="conv-search-btn" title={t.extras.searchClose} aria-label={t.extras.searchClose} onClick={onClose}>✕</button>
    </div>
  );
};

export default ConversationSearch;
