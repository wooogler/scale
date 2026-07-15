import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy: `vite dev` forwards /api/* to a running `scale serve`
// (default port 4318 per the engine handoff) so the SPA reaches the live API
// without CORS. In the production build the app is served BY `scale serve` at
// the same origin, so relative fetch('/api/...') just works — no base URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forwards ALL methods (GET + the quest-runner POSTs:
      // /api/quests/:id/complete, /api/socratic/:id/message) to `scale serve`.
      '/api': 'http://localhost:4318',
    },
  },
});
