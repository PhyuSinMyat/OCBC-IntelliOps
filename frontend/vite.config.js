import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/backend': {
        target: process.env.INTELLIOPS_BACKEND_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/backend/, ''),
      },
    },
  },
});
