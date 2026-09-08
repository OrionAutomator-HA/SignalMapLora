import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const demProxy = {
  '/dem': {
    target: 'https://s3.amazonaws.com',
    changeOrigin: true,
    rewrite: (path: string) =>
      path.replace(/^\/dem/, '/elevation-tiles-prod/terrarium'),
  },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy: demProxy },
  preview: { proxy: demProxy },
})
