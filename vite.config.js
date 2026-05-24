import { resolve } from "path";

export default {
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        animation: resolve(__dirname, "src/animation.html"),
        notify: resolve(__dirname, "src/notify.html"),
        overlay: resolve(__dirname, "src/overlay.html"),
        "break-countdown": resolve(__dirname, "src/break-countdown.html"),
      },
    },
  },
};
