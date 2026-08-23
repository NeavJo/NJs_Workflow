import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: {
    host: 'localhost',
    port: 5173,
    open: true
  }
})
