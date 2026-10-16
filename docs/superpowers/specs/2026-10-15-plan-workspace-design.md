# Plan: script, shot list and mood board

This is pre-production inside SharedCut. A crew writes the script, breaks it into a shot list and collects a mood board, then edits the footage in the same project.

The three parts are linked:
- Script scenes own shots.
- Shots find their takes in the media bin by clip name.
- Board images open on the Color page as a grading reference.

It stays out of the way. "Plan" is a hidden fifth workspace, reached from one quiet icon at the end of the workspace nav. It is not one of the Edit / Color / Audio / Deliver tabs.

## Data (four new persisted collections)

Every entity is a top-level row with `id`, `projectId` and `modifiedAt`. Nothing is nested, so each entity saves, merges, locks and undoes on its own. Order always comes from a numeric `order` field and never from array position. merge.ts keeps the remote order and appends local-only entries at the end.

```ts
export type ScriptFormat = 'screenplay' | 'stage';
export interface Script { id: string; projectId: string; name: string; format: ScriptFormat; credit?: string; order: number; modifiedAt: number }
export type ScriptBlockKind = 'scene' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition' | 'shot' | 'lyric' | 'note';
export interface ScriptBlock { id: string; projectId: string; scriptId: string; kind: ScriptBlockKind; text: string; order: number; modifiedAt: number }
export interface Shot { id: string; projectId: string; number: string; sceneId?: string; text: string; size?: string; movement?: string; cast?: string; location?: string; notes?: string; mediaIds?: string[]; done?: boolean; order: number; modifiedAt: number }
export type BoardItemKind = 'image' | 'note' | 'text' | 'swatch';
export interface BoardItem { id: string; projectId: string; kind: BoardItemKind; x: number; y: number; w: number; h: number; z: number; mediaId?: string; text?: string; color?: string; modifiedAt: number }
```

- **Persisted keys:** `scripts`, `scriptBlocks`, `shots`, `boardItems`.
- **History:** these are commit() collections, so they get undo and history.
  - Snapshots leave them out, so restoring an edit snapshot never rolls the script back.
  - The operation types are `ScriptChanged`, `ShotChanged` and `BoardChanged`.
- **Generic validation:** the generic validator gives `name`, `duration`, `start`, `sourceIn` and `time` a special meaning.
  - These entities avoid those names. The one exception is `Script.name`, which is the script's title and fits that meaning.
- **References:**
  - **Soft references:** `scriptBlock.scriptId`, `shot.sceneId`, `shot.mediaIds` and `boardItem.mediaId` may dangle, and the UI skips orphans.
  - **Why soft:** a strict check would block a collaborator's saves forever after a concurrent delete.
  - **Cascades:** deletes cascade in the same commit where they can. Deleting a script removes its blocks. Deleting a scene block unsets `sceneId` on its shots.
- **Size caps:**
  - block text: 20,000 characters
  - shot `text`: 2,000; shot `notes`: 5,000; other shot strings: 255
  - `mediaIds`: 100 entries
  - board `text`: 5,000; board `color`: `#rrggbb`
  - board `x`/`y`: ±1e6; board `w`/`h`: 8 to 20,000
- **Locks:** all four collections are lockable, and the server locks whole entities: one block, one shot or one card.
- **Media deletion:** an asset on the mood board cannot be deleted. The server answers 409 and the store also refuses. A shot's hand-linked takes do not block deletion.
- **Fix-forward:** like Depth, this cannot be rolled back. Once these keys exist, an older build would serve them to everyone unfiltered.

## Store actions (EditorStore, each with a one-line doc for MCP help)

- **Script:**
  - `addScript(name?, format?)` returns the id and also creates one empty scene block.
  - `updateScript(id, patch)`
  - `deleteScript(id)`
  - `addScriptBlocks(scriptId, blocks:{kind,text}[], afterId?: string|null)` returns the ids. Omitting `afterId` inserts at the end; `null` inserts at the start.
  - `updateScriptBlock(id, patch, gesture?)`
  - `splitScriptBlock(id, at, kind?)` returns the new id.
  - `mergeScriptBlock(id)` returns the previous block's id.
  - `deleteScriptBlocks(ids)`
- **Shots:**
  - `addShot(fields?, afterId?)` returns the id and numbers the shot automatically.
  - `updateShot(id, patch, gesture?)`
  - `deleteShots(ids)`
  - `moveShot(id, afterId: string|null)`
  - `linkShotMedia(shotId, mediaId, linked?)`
- **Board:**
  - `addBoardItems(items)` returns the ids.
  - `updateBoardItems(patches:{id,patch}[], gesture?)` makes one commit for a multi-card drag.
  - `deleteBoardItems(ids)`
- **Navigation:**
  - `openPlan(tab, focusId?)` switches to the Plan workspace and scrolls to a block, shot or card.
  - `setColorReference(mediaId|null)` opens Color with a reference picture.
- **UI state:** `planTab`, `planFocus`, `colorReference`.
- **Commit pacing:** script typing keeps a local draft. It commits after 400 ms idle and on blur, with one gesture per focus. History is immutable, so this gives about one row per pause rather than one per keystroke.

## Collaboration

- **Presence:**
  - `presence.activity` is already the workspace id, so the Plan icon gets presence dots for free.
  - A new `planTab` presence field (script | shots | board, whitelisted) drives the dots on the tabs.
- **Script blocks:**
  - Focusing a block takes `acquireLock(blockId,'text')`. A new block is flushed first, because the server can only lock rows it already has.
  - The lock renews every 3 s and is released on blur.
  - Other users see the block read-only, edged in the owner's color, with the owner's name.
- **Shots and cards:**
  - A shot row locks while one of its cells is focused.
  - A card takes a 'manipulation' lock while it is dragged or resized.
- **Cursors:** blocks, shot rows and the board world carry `data-cursor-anchor`, so remote cursors land on content. On the board this survives pan and zoom.

## UI

- **Plan workspace** (`src/workspaces/PlanWorkspace.tsx`): a header with the Script / Shots / Board tabs, each with presence dots, and the tab's actions on the right. Each tab is its own lazy component under `src/components/plan/`.
- **Script:**
  - **Script menu:** switch, new, rename, Screenplay or Stage play, delete.
  - **Scene outline:** collapsible, with a shot count per scene.
  - **Page layout:** a monospace column with `ch`-based screenplay indents.
    - Character is indented 22ch, dialogue 10ch and parenthetical 16ch. Transitions are right-aligned.
    - Stage play centers character names and indents stage directions in italics.
  - **Keys:**
    - Enter splits the block and picks the next element (scene→action, character→dialogue, dialogue→character, and so on). Enter on an empty block turns it into action.
    - Tab and Shift-Tab cycle the element.
    - Backspace at the start merges with the block above.
    - The arrow keys move between blocks.
    - Pasting several lines parses them as Fountain.
  - **Smart detection:** a line starting INT./EXT. becomes a scene, `… TO:` becomes a transition, and a leading `(` becomes a parenthetical. Enter after a short all-caps action line (`THEO`) makes it a character, so dialogue follows.
  - **Helpers:** character names autocomplete, and a page estimate is shown.
  - **Scene headings:** each shows an "n shots" chip and a "+ shot from this line" button.
- **Script export:** everything is built client-side by the pure `src/services/screenplay.ts`, which the MCP export job also uses.
  - "Open in Google Docs" copies rich text, opens docs.new and tells you to paste.
  - "Copy formatted text."
  - Download .docx, which Google Docs and Word open.
  - Download .fountain, for Highland, WriterDuet and Final Draft.
  - Print or save as PDF.
  - Import Fountain or plain text.
  - There is no Google OAuth. CSP `connect-src 'self'` blocks Drive calls, and a .docx or a paste covers the need.
- **Shots:**
  - **Table:** grouped by scene, with these columns: done, number, size, movement, description, cast, location, notes, takes.
  - **Takes:** auto-matched by clip name (`3A_take2.mov`, `Shot 3A`, `sh03a`; see `src/services/shots.ts`). You can also link one by hand by dropping media on a row.
  - **Take actions:** drag a take to the timeline, click it to reveal it in Media, or use "in edit" to jump to its clip.
  - **Export:** copy the table (for Docs or Sheets), download a .csv, or print.
  - **Elsewhere:** the media bin shows a small shot badge, and the media and timeline-clip menus get "Show in shot list".
- **Board:**
  - **Canvas:** pan and zoom, with image, note, text and color-swatch cards.
  - **Adding images:** drop files, paste, or pick from the project media. Uploads go to a "Mood board" bin.
  - **Image actions:**
    - Pull colors: a median-cut palette, from `src/services/palette.ts`.
    - Compare on Color page.
    - Show in media.
    - Add to timeline.
- **Color:** `colorReference` shows the chosen image as a corner reference over the Color viewer. It is for matching by eye; the AI Assistant is unchanged.
- **Shortcuts:** the editor's clip and playhead shortcuts stand down in Plan. Script, Shots and Board own their keys with capture listeners.

## MCP

- Every new action is classified in `mcp/catalog.ts`, and the collections are added to `mcp/views.ts` (handles and change summary).
- `mcp/jobs/plan.ts` adds three jobs:
  - `plan{view: script|shots|board, script?}`: a token-lean read.
  - `script-export{path, format?, script?}`: writes a .docx, .fountain or .html locally.
  - `script-import{path|text, script?, name?}`: a Fountain import as one rollback-safe batch.
- A `plan` help topic holds the recipes.
