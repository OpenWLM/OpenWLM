import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Version affichée dans l'interface, lue dans package.json au build (une seule source de vérité)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * Configuration de Vite pour le projet WLM Recreation
 * Gère le build du frontend React et le proxying vers le serveur Express.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  build: {
    // scripts/deploy.sh construit à côté (dist.next) puis échange avec dist/ : jamais
    // d'interface partielle servie pendant le build
    outDir: process.env.OPENWLM_BUILD_OUT_DIR || 'dist'
  },
  server: {
    proxy: {
      // Redirige les appels API vers le serveur Express local
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // Proxy pour les WebSockets (Socket.IO)
      '/socket.io': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
