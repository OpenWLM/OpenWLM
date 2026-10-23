import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Clavier d'une fenêtre ou d'un menu : Échap ferme, Tab reste à l'intérieur, le premier
 * élément prend le focus à l'ouverture (et le focus revient où il était à la fermeture).
 */
export const useDialogKeys = (active: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    const previous = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const focusables = () => (root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    // Premier élément focalisable (sauf si un champ `autoFocus` l'a déjà pris)
    if (root && !root.contains(document.activeElement)) focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !root) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [active, onClose, ref]);
};
