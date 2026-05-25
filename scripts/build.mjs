import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
const envPath = resolve(root, ".env");
const keyPath = resolve(root, "keys", "enoughwork.key");

// Load password from .env
let password = "";
try {
  const env = readFileSync(envPath, "utf-8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^TAURI_SIGNING_PRIVATE_KEY_PASSWORD=(.+)$/);
    if (match) {
      password = match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!password) {
    console.error("Error: TAURI_SIGNING_PRIVATE_KEY_PASSWORD not found in .env");
    process.exit(1);
  }
} catch {
  console.error("Error: .env file not found. Copy .env.example to .env and set TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  process.exit(1);
}

// Read the private key
let privateKey;
try {
  privateKey = readFileSync(keyPath, "utf-8").trim();
} catch {
  console.error("Error: keys/enoughwork.key not found. Run key generation first (see docs/auto-update-keys.md)");
  process.exit(1);
}

// Build with signing
console.log("Building with update signing...");
execSync("pnpm tauri build", {
  stdio: "inherit",
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  },
});
