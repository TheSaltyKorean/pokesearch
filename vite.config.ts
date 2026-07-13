import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served at the domain root since the pokesearch.site custom domain (the old
// thesaltykorean.github.io/pokesearch URL redirects there); overridable for
// other hosts via VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
})
