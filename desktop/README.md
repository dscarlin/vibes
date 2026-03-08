# Vibes Desktop (Tauri)

## Dev
1) Start the web UI locally (from repo root):

```
npm run dev
```

2) In another terminal, run the Tauri app:

```
cd desktop
cargo tauri dev
```

By default it loads http://localhost:8080.

## Build
```
cd desktop
API_URL=https://api.vibesplatform.ai DOMAIN=vibesplatform.ai node scripts/build-web.js
cargo tauri build
```

## Build (single command)
```
cd desktop
API_URL=https://api.vibesplatform.ai DOMAIN=vibesplatform.ai ./scripts/build-release.sh
```

## Build + Notarize (macOS)
```
cd desktop
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@company.com"
export APPLE_TEAM_ID="TEAMID"
export APPLE_APP_PASSWORD="app-specific-password"
API_URL=https://api.vibesplatform.ai DOMAIN=vibesplatform.ai NOTARIZE_MACOS=1 ./scripts/build-release.sh
```

## Build + Sign (Windows)
```
cd desktop
set WINDOWS_PFX_PATH=C:\path\to\cert.pfx
set WINDOWS_PFX_PASSWORD=your_password
set WINDOWS_SIGN_TARGET=C:\path\to\YourInstaller.msi
API_URL=https://api.vibesplatform.ai DOMAIN=vibesplatform.ai WINDOWS_SIGN=1 ./scripts/build-release.sh
```

## Distribute (macOS)
1) Build the app (above).
2) Codesign + notarize:
```
cd desktop
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@company.com"
export APPLE_TEAM_ID="TEAMID"
export APPLE_APP_PASSWORD="app-specific-password"
./scripts/macos-notarize.sh
```
This signs the `.app`, submits the latest `.dmg` (or `.app` if no dmg), waits, and staples the ticket.

Without signing+notarization, macOS Gatekeeper will block most users.

## Distribute (Windows)
Unsigned Windows builds trigger SmartScreen warnings. For clean installs you need a code signing cert.

1) Build the app on Windows.
2) Sign the `.exe` or `.msi`:
```
set WINDOWS_PFX_PATH=C:\path\to\cert.pfx
set WINDOWS_PFX_PASSWORD=your_password
set WINDOWS_SIGN_TARGET=C:\path\to\YourInstaller.msi
powershell -ExecutionPolicy Bypass -File scripts/windows-sign.ps1
```

Notes:
- Use a reputable CA (DigiCert, Sectigo, etc). EV certificates reduce SmartScreen warnings faster.
- `signtool.exe` ships with the Windows SDK.

## Notes
- The web UI is reused; no separate frontend is included in this scaffold.
- Add icons under desktop/src-tauri/icons/ when ready.
