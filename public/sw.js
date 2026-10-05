/**
 * Service Worker pour OpenWLM (Web Edition)
 * Fournit le support hors-ligne de la coquille d'application (App Shell)
 * et la mise en cache haute-performance des sons et icônes rétro.
 */

const CACHE_NAME = 'openwlm-v5';

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
          .filter((name) => name !== CACHE_NAME)
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

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

// Clic sur une notification système déclenchée via ServiceWorkerRegistration ou Web Push
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notifData = event.notification.data || {};
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

