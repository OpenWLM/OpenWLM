import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initPWA } from './pwa'
import { I18nProvider } from './i18n'

// Initialiser le Service Worker PWA et les gestionnaires d'installation
initPWA()

// SÉCURITÉ & WEBRTC : Forcer le passage en HTTPS si on est en production
// Les navigateurs bloquent l'accès à la caméra/micro sur du HTTP simple.
if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  window.location.href = window.location.href.replace('http:', 'https:');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
