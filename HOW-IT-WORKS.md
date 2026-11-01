# How SharedCut works

## The big picture

SharedCut has two halves. The browser is the editor: it holds the whole project in memory, plays the footage, and draws effects with the computer's own GPU. The server is a single Node program. It stores accounts and projects in SQLite, turns uploaded camera files into small preview videos with FFmpeg, runs the heavy AI effects (stabilize, masks, depth, noise reduction) as separate Python programs, and renders the final video from the original files.

Editing therefore feels fast because it is local, and the final export is high quality because it never uses the preview copies.

## Four decisions worth explaining

**1. Merging edits instead of using a CRDT.** Real-time editors often use CRDTs or operational transforms, but those are hard to get right. SharedCut does something simpler. Each save says "this is based on revision 41." If someone else already saved revision 42, the server refuses with a 409 and sends back the current state. The browser then does a three-way merge: it compares the common starting point, its own version and the server's version, item by item and field by field. Changes to different clips, or to different settings of the same clip, merge silently. Only a true clash, where two people changed the same value, is shown to the user. Live dragging is covered by locks that expire after 8 seconds, so two people can't pull the same clip in opposite directions. This works because video edits are mostly small changes to separate clips, not characters typed into the same sentence.

**2. Transitions never move clips.** A transition needs extra frames on both sides of a cut. Many editors shift clips to make room, but with several people editing, that would change someone else's timing without warning. SharedCut borrows frames from the trimmed-off handles that the clips already have, so nothing on the timeline moves. The transition is stored as a field on the clip, so it automatically gets saving, merging, undo and snapshots with no extra code.

**3. Preview and export are separate, but they must agree.** The browser plays lighter preview files (each video gets versions 1920, 960 and 480 pixels wide), and they are cached in the browser so footage that has played once doesn't download again. The export runs FFmpeg and Python on the full-quality originals. That means every effect has two implementations, one for preview and one for export, and they can drift apart. To catch this, titles and captions share one layout module, color math is pinned by test vectors, and depth has a parity test that compares both outputs.

**4. AI agents use the same door as people.** The MCP server doesn't call special back-end functions. It runs the editor's own store without a screen and saves through the same API the browser uses. An edit by Claude or Codex is therefore checked, merged, shown live to collaborators and undoable, exactly like a person's edit. A test (`mcp/coverage.test.ts`) fails the build if a new feature isn't reachable by agents, so the agent interface can't fall behind.

## Where to look

- `src/state/store.ts`: every editing action
- `src/services/sync.ts` and `merge.ts`: saving and the three-way merge
- `server/index.ts`: the HTTP API, authentication and permissions
- `server/media.ts`: FFmpeg preview files and export rendering
- `mcp/`: the agent interface
- `docs/superpowers/specs/`: the design documents for individual features
