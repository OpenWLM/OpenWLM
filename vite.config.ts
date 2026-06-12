import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Configuration de Vite pour le projet WLM Recreation
 * Gère le build du frontend React et le proxying vers le serveur Express.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Redirige les appels API vers le serveur Express local
      '/api': 'http://localhost:3001',
      // Proxy pour les WebSockets (Socket.IO)
      '/socket.io': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
})
