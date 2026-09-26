import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Some Solana libraries still reference Node's `global`.
  define: { global: "globalThis" },
  server: { port: 5173 },
});
