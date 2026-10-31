import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  // The build's own version, compared with GET /version to detect an out-of-date tab
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  server: {
    // What's New reads CHANGELOG.md, which sits above the ui folder
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:8000',
      '/events': 'http://localhost:8000',
      '/projects': 'http://localhost:8000',
      '/tickets': 'http://localhost:8000',
      '/members': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/version': 'http://localhost:8000',
      '/mcp': 'http://localhost:8000',
      '/uploads': 'http://localhost:8000',
      '/settings': 'http://127.0.0.1:8000',
      '/data': 'http://127.0.0.1:8000',
      '/workspace': 'http://localhost:8000',
      '/diagrams': 'http://localhost:8000',
      '/sketches': 'http://localhost:8000',
      '/docs/': 'http://localhost:8000',
      '/ai': { target: 'http://localhost:8000', ws: true }, // ws: the sign-in terminal of an AI account
    },
  },
})
