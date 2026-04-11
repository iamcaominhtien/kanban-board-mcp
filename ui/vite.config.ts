import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/events': 'http://localhost:8000',
      '/projects': 'http://localhost:8000',
      '/tickets': 'http://localhost:8000',
      '/members': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/mcp': 'http://localhost:8000',
    },
  },
})
