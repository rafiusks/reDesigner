import redesigner from '@redesigner/vite'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // redesigner first: our plugin expects raw TSX before plugin-react's Fast-Refresh
  // wrapping injects `_c = function X() {}` assignments that hide component identity.
  plugins: [redesigner(), react(), tailwind()],
})
