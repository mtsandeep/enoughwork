# Auto Update Keys — EnoughWork (Dev Reference)

## Key Locations

| What | Where | Purpose |
|---|---|---|
| Public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | Shipped with the app, verifies update signatures |
| Private key | `keys/enoughwork.key` (repo, gitignored) | Signs update binaries during CI builds |
| Private key (CI) | GitHub repo Secrets → `TAURI_SIGNING_PRIVATE_KEY` | Used by `publish.yml` to sign releases |
| Key password (CI) | GitHub repo Secrets → `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Protects the private key |

## How Signing Works

1. CI builds a release → `tauri-action` signs the update binary using the private key
2. CI uploads `latest.json` + signed binaries to the GitHub release
3. App checks for update → downloads binary → verifies signature using the embedded public key
4. If signature matches → install and restart. If not → reject.

**Full installers** (NSIS/MSI) downloaded manually from GitHub releases are **not** signature-checked — only the in-app auto-update path verifies signatures.

---

## Initial Setup

### Step 1: Generate signing keys

```powershell
pnpm tauri signer generate -w .\keys\enoughwork.key
```

It will ask for a password. Enter one and save it — you'll need it for GitHub Secrets.

Output looks like:
```
Public key (add to TAURI_CONF):
dW50cnVzdGVkIGNvbW1lbnQ6IH...(base64 string)

Private key written to: .\keys\enoughwork.key
```

The `keys/` folder is gitignored — the private key stays local.

### Step 2: Add public key to config

Copy the public key from the output and paste it into `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IH..."
  }
}
```

Replace the `PASTE_PUBLIC_KEY_HERE` placeholder.

### Step 3: Add secrets to GitHub

1. Go to https://github.com/mtsandeep/enoughwork/settings/secrets/actions
2. Add **`TAURI_SIGNING_PRIVATE_KEY`**:
   - Value: contents of `keys/enoughwork.key` (the full base64 blob)
3. Add **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**:
   - Value: the password you entered when generating the key

### Step 4: Verify

Test that the key + password work:

```powershell
echo "test" > .\keys\test.txt
pnpm tauri signer sign .\keys\test.txt -f .\keys\enoughwork.key -p <your_password>
```

If correct, a `.sig` file is created. If wrong, you get an error.

Then push a version tag → CI builds → check the GitHub release has a `latest.json` asset alongside the installers.

---

## Key Rotation

Only needed if the private key is compromised. You likely won't need to do this.

### Step 1: Generate new keys

```powershell
pnpm tauri signer generate -w .\keys\enoughwork-v2.key
```

### Step 2: Build a transitional release (vN)

This release must be signed with the **old** key so existing installs accept it:
- CI still uses old `TAURI_SIGNING_PRIVATE_KEY`
- Update `tauri.conf.json` with the **new** public key
- Release vN

Users who auto-update to vN now trust the new key.

### Step 3: Switch to new key

- Update GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` to the new key
- Update `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if password changed
- Release vN+1 (and all future) — now signed with new key

### Step 4: Users who skipped vN

- Auto-update from old versions → fails (old key doesn't trust new signatures)
- User clicks "Check for Updates" → sees "Check failed" with link to GitHub releases
- User downloads and runs the full installer manually → works fine (no signature check on full installs)

---

## References

- GitHub repo constant: `GITHUB_REPO = "mtsandeep/enoughwork"` in `src/main.js`
- Updater endpoint: `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
- CI workflow: `.github/workflows/publish.yml`
