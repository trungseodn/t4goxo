import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

/** https://vite.dev/config/ */
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5184,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_URL || 'http://127.0.0.1:3004',
        changeOrigin: true,
      },
      '/storage': {
        target: process.env.VITE_API_PROXY_URL || 'http://127.0.0.1:3004',
        changeOrigin: true,
      },
    },
  },
})
