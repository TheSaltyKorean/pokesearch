import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base is '/pokesearch/' for GitHub Pages project site; overridable for other hosts
export default defineConfig({
  base: process.env.VITE_BASE ?? '/pokesearch/',
  plugins: [react()],
})
