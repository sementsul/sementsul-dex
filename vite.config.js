import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// База сборки.
//
// По умолчанию '/' — обычная сборка для Cloudflare Pages, где сайт лежит в
// корне домена. Переменная MIRROR=1 переключает на './': это нужно для копии
// на IPFS, потому что там нет корня домена и абсолютный '/assets/…' указывал
// бы в никуда. Подробности — docs/IPFS-MIRROR.md.
const MIRROR = process.env.MIRROR === '1'

export default defineConfig({
  plugins: [react()],
  base: MIRROR ? './' : '/',
  build: {
    target: 'es2020',
    // Разные каталоги, чтобы сборка зеркала не затирала основную и наоборот.
    outDir: MIRROR ? 'dist-mirror' : 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          viem: ['viem'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
})