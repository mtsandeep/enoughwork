import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const level = process.argv[2];
if (!["patch", "minor", "major"].includes(level)) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(scriptsDir, "..", "src-tauri");

function hasCargoRelease() {
  try {
    execSync("cargo release --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasCargoRelease()) {
  console.log("cargo-release not found, installing...");
  try {
    execSync("cargo install cargo-release --locked", { stdio: "inherit" });
  } catch {
    console.error(
      '\nFailed to install cargo-release. Try "rustup update" or install an older version (e.g. "cargo install cargo-release --version 1.1.6 --locked").'
    );
    process.exit(1);
  }
}

execSync(`cargo release ${level} --execute`, { cwd: tauriDir, stdio: "inherit" });
