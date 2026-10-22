/**
 * Attend `promise` au plus `ms` millisecondes ; au-delà (ou en cas d'erreur), renvoie
 * `fallback`. Pour les API qui peuvent ne jamais répondre (navigator.serviceWorker.ready sans
 * service worker actif, Firebase hors ligne) là où l'on ne doit pas rester bloqué.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
