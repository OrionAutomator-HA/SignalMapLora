import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
import { attachMeshcoreBridge } from './server/meshcore-bridge.mjs'

const demProxy = {
  '/dem': {
    target: 'https://s3.amazonaws.com',
    changeOrigin: true,
    rewrite: (path: string) =>
      path.replace(/^\/dem/, '/elevation-tiles-prod/terrarium'),
  },
}

function meshcoreBridgePlugin(): Plugin {
  const hook = (server: ViteDevServer | PreviewServer) => {
    return () => {
      if (server.httpServer) attachMeshcoreBridge(server.httpServer)
    }
  }
  return {
    name: 'meshcore-bridge',
    configureServer: hook,
    configurePreviewServer: hook,
  }
}

export default defineConfig({
  plugins: [react(), meshcoreBridgePlugin()],
  server: {
    proxy: demProxy,
    headers: { 'Permissions-Policy': 'serial=(self)' },
  },
  preview: {
    proxy: demProxy,
    headers: { 'Permissions-Policy': 'serial=(self)' },
  },
})
