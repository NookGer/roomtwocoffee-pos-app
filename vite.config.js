import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon_app.png"],
      manifest: {
        name: "RoomTwo Pos",
        short_name: "RoomTwo Pos",
        description: "ระบบ POS สำหรับร้านกาแฟ RoomTwo Coffee",
        theme_color: "#2C1810",
        background_color: "#F5F0EA",
        display: "standalone",
        orientation: "landscape",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "icon_app.png", sizes: "600x600", type: "image/png" },
          { src: "icon_app.png", sizes: "any", type: "image/png", purpose: "any maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "google-fonts-cache", expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } }
          }
        ]
      }
    })
  ],
  server: { port: 3000 },
  build: { outDir: "dist" }
});
