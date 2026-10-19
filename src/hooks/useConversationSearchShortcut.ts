import type React from 'react';
import { useEffect, useState } from 'react';

/**
 * Raccourci Ctrl+F (Cmd+F) : ouvre la recherche dans la conversation affichée plutôt que celle
 * du navigateur. Renvoie la conversation où la recherche est ouverte (changer d'onglet la ferme,
 * puisqu'elle ne correspond plus à la conversation affichée) et de quoi la fermer.
 */
export const useConversationSearchShortcut = (activeChatIdRef: React.RefObject<number>) => {
  const [searchChatId, setSearchChatId] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' && activeChatIdRef.current !== 0) {
        e.preventDefault();
        setSearchChatId(activeChatIdRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeChatIdRef]);
  return { searchChatId, closeSearch: () => setSearchChatId(null) };
};
