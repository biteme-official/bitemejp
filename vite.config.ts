import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { shopifyProxyMiddleware } from "./server/shopify-proxy";
import { lineCallbackMiddleware } from "./server/line-callback";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env so server middleware can access SHOPIFY_CLIENT_SECRET
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    server: {
      host: "::",
      port: 5173,
    },
    plugins: [
      react(),
      mode === "development" && componentTagger(),
      {
        name: 'shopify-proxy',
        configureServer(server) {
          server.middlewares.use(shopifyProxyMiddleware());
          server.middlewares.use(lineCallbackMiddleware());
        },
      },
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
