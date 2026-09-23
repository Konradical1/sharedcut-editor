import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// data/ and artifacts/ hold media, caches and models, not source. On Windows the dev watcher's directory
// handles block renaming anything inside them (EPERM), which failed every finished Smart Mask analysis.
export default defineConfig({ plugins: [react(), tailwindcss()], server: { port: 5173, watch: { ignored: ['**/data/**', '**/artifacts/**', '**/.venv-*/**'] }, proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false } } } });
