import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'serve' && !isPreview ? '/' : '/Prop-Desk-Account-Tracker/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: { ignored: ['**/artifacts/**'] },
  },
}));
