# Upload recovery and performance — September 21, 2026

The two supplied camera clips total 2,080,718,208 bytes (2.08 GB). They contain 4K, 59.94 fps, 10-bit 4:2:2 HEVC footage, despite being only 45 and 31 seconds long. Their originals remain unchanged.

## Observed bottlenecks

- The browser was open on `https://sharedcut.com`, so uploads from the hosting Mac traveled through the internet tunnel back to that same Mac. The observed transfer rate was approximately 3 MB/s. C1066 stopped after 603,979,776 bytes with a connection reset.
- A direct local disk check wrote and synced sixteen 8 MiB chunks and calculated their SHA-256 checksums: 128 MiB in 159 ms, approximately 803 MiB/s. This isolates disk/checksum capacity; it is not an HTTP upload benchmark. Health response times were 58 ms locally and 1.08 seconds through the tunnel, one observation each.
- Resuming C1066 through `http://localhost:4310` transferred its remaining **268,602,016 bytes in approximately 2 seconds**, as reported by the actual uploader. The complete 872,581,792-byte uploaded original matched the Desktop file's SHA-256. This was a resumed transfer, not a two-second upload of the entire file.
- Upload completion was also being confused with media preparation. The server previously withheld a usable proxy until smaller proxies, a waveform, filmstrip, and a second expensive color encode all finished.

## Changed behavior

The upload panel identifies the current connection and provides an explicit local-uploader link on remote connections. Use it on the Mac running SharedCut; another computer's localhost does not point at this server. The usual authentication and project permissions remain in effect. Uploads are not silently redirected across origins.

A browser-local queue displays every selected file, accepted bytes, transfer speed, estimated remaining time, elapsed time, pauses, retries, and failures. Two files may transfer at once; chunks within each file remain ordered and checksum verified. Progress does not become collaborative edit traffic. Pausing preserves accepted bytes. Resuming uses the same asset and server offset; reselecting an interrupted file also resumes when its fingerprint matches. Refreshing requires reselecting files because browsers do not retain File objects across reloads; an unload warning protects active transfers, and unfinished server assets expose a resume action.

The server publishes a playable asset after the main proxy and waveform exist, then publishes smaller playback previews before color processing finishes. Background failure preserves the existing playable media. The UI distinguishes preparation stages from upload progress and makes clear when editing can start.

On C1066, the original finished at 12:28:24 UTC; the main proxy finished at 12:29:21 and the small streaming preview at 12:29:45. The UI showed the clip ready while its high-precision color preview was still processing. These are observations of this Mac, not guarantees for other hardware or formats.

## Validation

- Production TypeScript/Vite build passed.
- 66 upload, server API, synchronization, and editor state checks passed.
- Real media preparation/export validation and the new early-playback/background-failure check passed.
- Browser verification used the real Newspaper project and resumed C1066 through localhost; both C1064 and C1066 originals were checked against the supplied files.

Run the focused checks with:

```sh
node --experimental-strip-types --test src/services/upload.test.ts src/services/sync.test.ts src/state/store.test.ts server/server.test.ts
node --experimental-strip-types --test --test-name-pattern='playable footage|real media preparation' server/media.test.ts
npm run build
```
