/**
 * Service Worker pour OpenWLM (Web Edition)
 * Fournit le support hors-ligne de la coquille d'application (App Shell)
 * et la mise en cache haute-performance des sons et icônes rétro.
 */

const CACHE_NAME = 'openwlm-v7';
// Préférences lues par le service worker (langue de l'app), écrites par la page : jamais purgé
const PREFS_CACHE = 'openwlm-prefs';

// Ressources critiques pré-mises en cache au démarrage
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.png',
  '/pwa-192x192.png',
  '/pwa-maskable-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
  '/assets/openwlm_logo.png',
  '/assets/sounds/nudge.mp3',
  '/assets/sounds/type.mp3',
  '/assets/sounds/online.mp3',
  '/assets/sounds/newalert.mp3',
  '/assets/sounds/outgoing.mp3'
];

// Installation : pré-chargement des ressources essentielles
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Pré-mise en cache partielle:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activation : suppression des anciens caches et prise de contrôle immédiate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== PREFS_CACHE)
          .map((name) => {
            console.log('[SW] Suppression ancien cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Interception des requêtes réseau (Fetch)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. NE JAMAIS intercepter les requêtes Socket.io, les requêtes non-GET, ou les appels API
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/api/')
  ) {
    return; // Laisser le réseau natif traiter la requête
  }

  // 2. Navigation vers des pages HTML (Mode Navigation)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match('/index.html');
      })
    );
    return;
  }

  // 3. Ressources statiques (Images, Sons, Émoticônes, Polices, Scripts Vite)
  // Stratégie Stale-While-Revalidate / Cache-First pour les assets
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.wav') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Si présent dans le cache, on le retourne immédiatement, et on met à jour en tâche de fond
          fetch(request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse);
              });
            }
          }).catch(() => {});
          return cachedResponse;
        }

        // Sinon récupération réseau puis mise en cache
        return fetch(request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return networkResponse;
        });
      })
    );
    return;
  }

  // 4. Par défaut : Réseau d'abord avec repli sur le cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// Écoute des messages pour forcer la mise à jour
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Réception d'une notification Web Push en arrière-plan (PWA fermée ou suspendue sur Android/Desktop)
/**
 * TEXTES DES NOTIFICATIONS dans la langue de l'app. Le serveur ne connaît pas cette langue
 * (réglage propre à l'appareil) : il envoie une clé (`l10n`) et un texte français de repli ;
 * la page enregistre sa langue dans le cache PREFS_CACHE, lu ici.
 */
const L10N = {
  fr: {
    message: 'Nouveau message reçu', privateMessage: '🔒 Nouveau message privé', voice: '🎤 Message vocal',
    file: '📎 Fichier partagé', encrypted: '🔐 Message chiffré (E2EE)', nudge: '💥 [Wizz !]',
    callAudio: '📞 Appel audio entrant', callVideo: '📹 Appel vidéo entrant', callMissed: '📵 Appel manqué',
    callAnswered: '📞 Appel pris sur un autre appareil', callDeclined: '📵 Appel refusé',
    pushTest: 'La passerelle de notification Push Web / Android fonctionne correctement !',
    answer: 'Répondre', decline: 'Refuser'
  },
  en: {
    message: 'New message', privateMessage: '🔒 New private message', voice: '🎤 Voice message',
    file: '📎 Shared file', encrypted: '🔐 Encrypted message (E2EE)', nudge: '💥 [Nudge!]',
    callAudio: '📞 Incoming voice call', callVideo: '📹 Incoming video call', callMissed: '📵 Missed call',
    callAnswered: '📞 Call answered on another device', callDeclined: '📵 Call declined',
    pushTest: 'Web / Android push notifications are working!',
    answer: 'Answer', decline: 'Decline'
  }
};
async function getLang() {
  try {
    const res = await (await caches.open(PREFS_CACHE)).match('/__openwlm/lang');
    const lang = res ? (await res.text()).trim() : '';
    if (lang === 'fr' || lang === 'en') return lang;
  } catch { /* cache indisponible */ }
  return String(self.navigator?.language || 'fr').slice(0, 2) === 'fr' ? 'fr' : 'en';
}

self.addEventListener('push', (event) => {
  let payload = {
    title: 'OpenWLM',
    body: 'Nouveau message reçu',
    icon: '/pwa-maskable-192x192.png',
    badge: '/assets/openwlm_logo.png',
    tag: 'openwlm-message',
    data: { url: '/', senderId: 0 }
  };

  if (event.data) {
    try {
      const json = event.data.json();
      payload = { ...payload, ...json };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    icon: payload.icon || '/pwa-maskable-192x192.png',
    badge: payload.badge || '/assets/openwlm_logo.png',
    tag: payload.tag || 'openwlm-message',
    data: payload.data || { url: '/', senderId: payload.senderId || 0 },
    vibrate: [200, 100, 200],
    renotify: true
  };

  event.waitUntil((async () => {
    const lang = await getLang();
    const texts = L10N[lang];
    if (payload.l10n && texts[payload.l10n]) options.body = texts[payload.l10n];
    if (payload.l10n === 'pushTest') payload.title = 'OpenWLM - Test Web Push';

    // Fin d'un appel qui sonnait (manqué, pris ou refusé) : la notification qui sonne est remplacée
    if (payload.type === 'call_cancel') {
      const ringing = await self.registration.getNotifications({ tag: options.tag });
      ringing.forEach((n) => n.close());
      // Pris ou refusé depuis l'application ouverte : rien de plus à afficher
      if (payload.reason === 'answered' || payload.reason === 'declined') {
        try {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          if (clientList.some((c) => c.focused)) return;
        } catch { /* ignore */ }
      }
      await self.registration.showNotification(payload.title, { ...options, renotify: false, vibrate: [], silent: true });
      return;
    }

    // Anti-doublon : si l'application est OUVERTE au premier plan, c'est ELLE qui affiche
    // sa propre notification (avec le CONTENU déchiffré côté client, le serveur n'ayant pas la clé).
    try {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clientList.some((c) => c.focused)) return;
    } catch { /* ignore */ }

    if (payload.type === 'call') {
      await ringCallNotification(payload, options, texts);
      return;
    }
    await self.registration.showNotification(payload.title, options);
  })());
});

/**
 * APPEL ENTRANT (Push, appareil en veille ou application fermée)
 * Notification persistante avec « Répondre » / « Refuser », réaffichée toutes les quelques
 * secondes (renotify : son et vibration du système à chaque fois) tant que l'appel sonne, pour
 * imiter une sonnerie. Arrêt dès que la notification est fermée (réponse, refus, appel manqué)
 * ou que l'appel expire. Le son est celui des notifications du système : une page web ne peut
 * pas jouer de sonnerie en boucle sur un téléphone en veille.
 */
const CALL_RING_INTERVAL_MS = 4000;
const CALL_RING_MAX_MS = 30000;
async function ringCallNotification(payload, baseOptions, texts) {
  const expiresAt = Number(payload.data?.expiresAt) || Date.now() + CALL_RING_MAX_MS;
  const stopAt = Math.min(expiresAt, Date.now() + CALL_RING_MAX_MS);
  // Identifiant de CETTE sonnerie : la boucle s'arrête dès que sa notification n'est plus
  // affichée (réponse, refus, appel manqué, ou remplacée par l'application ouverte)
  const ringId = `${Date.now()}-${Math.random()}`;
  const options = {
    ...baseOptions,
    data: { ...(baseOptions.data || {}), ringId },
    requireInteraction: true,
    renotify: true,
    vibrate: [400, 200, 400, 200, 400],
    actions: [
      { action: 'answer', title: texts.answer },
      { action: 'decline', title: texts.decline }
    ]
  };
  const stillRinging = async () => (await self.registration.getNotifications({ tag: options.tag }))
    .some((n) => n.data && n.data.ringId === ringId);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  await self.registration.showNotification(payload.title, options);
  while (Date.now() + CALL_RING_INTERVAL_MS < stopAt) {
    await sleep(CALL_RING_INTERVAL_MS);
    if (!(await stillRinging())) return;
    await self.registration.showNotification(payload.title, options);
  }
  // Plus de son, mais l'appel peut encore être pris jusqu'à son expiration ; ensuite, sans
  // réponse, la notification devient « Appel manqué » (au lieu de rester affichée telle quelle)
  while (Date.now() < expiresAt) {
    await sleep(Math.min(CALL_RING_INTERVAL_MS, Math.max(0, expiresAt - Date.now())));
    if (!(await stillRinging())) return;
  }
  if (!(await stillRinging())) return;
  (await self.registration.getNotifications({ tag: options.tag })).forEach((n) => n.close());
  await self.registration.showNotification(payload.title, {
    ...baseOptions,
    body: texts.callMissed,
    renotify: false,
    vibrate: [],
    silent: true
  });
}

// Clic sur une notification système déclenchée via ServiceWorkerRegistration ou Web Push
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notifData = event.notification.data || {};

  // « Refuser » un appel depuis la notification : refus immédiat, sans ouvrir l'application
  if (notifData.type === 'call' && event.action === 'decline') {
    event.waitUntil(fetch('/api/calls/decline', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerId: notifData.callerId })
    }).catch(() => { /* hors ligne : l'appel expirera */ }));
    return;
  }
  const targetUrl = notifData.url || '/';
  const targetSenderId = notifData.senderId;

  // Focus sur la fenêtre OpenWLM existante ou ouverture de l'application
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if (targetSenderId) {
            client.postMessage({
              type: 'OPEN_CHAT',
              senderId: targetSenderId
            });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

