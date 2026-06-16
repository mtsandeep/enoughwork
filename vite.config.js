import { resolve } from "path";

export default {
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch Rust build output / Tauri sources — cargo writes to these
      // during builds and Windows locks the files (EBUSY), crashing the watcher.
      ignored: ["**/src-tauri/**", "**/target/**", "**/dist/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        animation: resolve(__dirname, "src/windows/animation.html"),
        notify: resolve(__dirname, "src/windows/notify.html"),
        overlay: resolve(__dirname, "src/windows/overlay.html"),
        "break-countdown": resolve(__dirname, "src/windows/break-countdown.html"),
      },
    },
  },
};
