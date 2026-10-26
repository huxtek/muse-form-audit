import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "localhost",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      // `import.meta.dirname` rather than `__dirname`: Vite's native config
      // loader cannot evaluate CommonJS globals, and it is slated to become
      // the default in a future major.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
