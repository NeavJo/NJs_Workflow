import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    host: 'localhost',
    port: 5173,
    open: true
  }
})
