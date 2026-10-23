# SharedCut Desktop

The app runs all of SharedCut on the computer itself: its own server (bundled Node 26 and FFmpeg 9) with projects in
`~/Library/Application Support/SharedCut/data`. New projects, imports, editing, color, audio and exports work with no
connection. Not bundled yet: the Python features (captions, Smart Mask, depth, denoise, stabilize, optical flow,
tracking, and the colour worker that exports ACES, film and window grades; the viewer shows them all) and
the Color Assistant, which needs the internet anyway. Auto balance (Normalize) runs on sharedcut.com instead, for a
project synced there while signed in and online (`server/remoteSync.ts` `normalize`, `server/colorNormalize.ts`).

## Build (Mac)

1. `npm install` in this folder once. If npm held back Electron's download, run `node node_modules/electron/install.js`.
2. Put this platform's binaries in `vendor/darwin-arm64/` (gitignored):
   - `node`: the official build, https://nodejs.org/dist/v26.11.1/node-v26.11.1-darwin-arm64.tar.gz (check it against SHASUMS256.txt).
   - `ffmpeg` and `ffprobe`: the macOS arm64 release builds from https://ffmpeg.martin-riedl.de (Developer ID: Martin Riedl, KU3N25YGLU).
3. From the repo root: `npm run desktop:dist`. It makes `release/SharedCut-<version>-arm64.dmg`, plus the zip,
   blockmaps and `latest-mac.yml` that updates use.
4. `node offline-check.mjs` runs the packaged app with the internet cut off. It makes a local account, imports 4K HEVC
   4:2:2 and phone footage, prepares and exports it, opens the editor and checks that quitting stops the server.

To run from the checkout: `npm run stage && npm start` in this folder.

## Signing

electron-builder signs with the keychain's Developer ID Application certificate. It notarizes when
`APPLE_KEYCHAIN_PROFILE` names a notarytool profile:

```sh
xcrun notarytool store-credentials sharedcut --apple-id <apple id> --team-id <team id>   # once; asks for an app-specific password
APPLE_KEYCHAIN_PROFILE=sharedcut npm run desktop:dist
```

Without a Developer ID it signs with the Apple Development certificate. That build runs on the Mac that built it. On
another Mac, a downloaded or AirDropped copy needs System Settings → Privacy & Security → Open Anyway once.

## Updates

At launch and every 10 minutes, the app checks https://sharedcut.com/download/latest-mac.yml. The server serves
`/download/<file>` from `<data>/downloads` on the Lenovo. To publish, bump `version` in package.json and build. Then
copy the files with `latest-mac.yml` last, so no app ever sees a feed that points at a missing file:

```sh
ssh <server> mkdir -p SharedCut-data/downloads
scp release/SharedCut-*.dmg release/SharedCut-*.zip release/SharedCut-*.blockmap <server>:SharedCut-data/downloads/
scp release/latest-mac.yml <server>:SharedCut-data/downloads/
```

A Mac update only installs when the installed build and the new build are signed by the same Developer ID.

## Syncing with sharedcut.com

On the Projects screen, sign in to sharedcut.com and choose **Keep on this computer** for a project. The app downloads its
footage and keeps the project live with sharedcut.com every few seconds while online. Edits made offline stay on the
computer and merge in when it is back online; when both sides changed the same thing, the computer's edit wins. New
footage imported in the app uploads by itself. `server/remoteSync.ts` does this; `SHAREDCUT_REMOTE` points the app at
another server. The bundle steps below are the manual route.

## Taking a sharedcut.com project offline

When the laptop already has the footage, only the edit travels. On the Lenovo:

```sh
FRAME_LINE_DATA=~/SharedCut-data node scripts/project-bundle.mjs export "<project>" ~/bundle --no-media
```

Copy `~/bundle` to the laptop. Create an account in the app, quit it, then import with the app's own copy of the
scripts. The app prepares the clips the next time it opens.

```sh
cd /Applications/SharedCut.app/Contents/Resources/app
FRAME_LINE_DATA="$HOME/Library/Application Support/SharedCut/data" ../bin/node scripts/project-bundle.mjs import ~/bundle --originals ~/Desktop/<footage folder>
```

## Moving an offline project to sharedcut.com

Quit the app first. Then export the project from the app's data folder and import it on the Lenovo:

```sh
FRAME_LINE_DATA="$HOME/Library/Application Support/SharedCut/data" node scripts/project-bundle.mjs export "<project>" ~/Desktop/bundle
```
