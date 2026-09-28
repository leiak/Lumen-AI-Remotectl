import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind on all interfaces so the dev server is reachable from the phone
    // over Tailscale. Vite already restricts by origin check, but
    // `strictPort` keeps the port stable so the phone bookmark doesn't break.
    host: '0.0.0.0',
    strictPort: true,
  },
  // `@capacitor/*` are optional peer deps — present only in the native
  // build. Excluding them from optimizeDeps keeps Vite (both build and test)
  // from trying to pre-bundle missing modules when it walks the dynamic
  // imports in push.ts.
  optimizeDeps: {
    exclude: [
      '@capacitor/core',
      '@capacitor/app',
      '@capacitor/preferences',
      '@capacitor/push-notifications',
      '@capacitor/ios',
    ],
  },
  build: {
    rollupOptions: {
      external: [/^@capacitor\//],
    },
  },
});
