# SharedCut MCP

Lets Claude Code, Codex or any MCP client edit SharedCut projects: cut, trim, move, titles, shapes, effects,
transitions, keyframes, color, captions, masks, depth, tracking, stabilize, uploads and exports, plus the
Plan workspace (script, shot list, mood board).

It runs the editor's own store headless and saves through the same API the browser uses. So an edit made
here is the same edit the UI makes. It shows up live in open editors, lands in History, and the same
account can undo it.

## Install

On the machine where Claude Code or Codex runs, from the SharedCut folder (Node 22.18+, after `npm install`):

```sh
npm run mcp:setup
```

That signs you in (address, email, password; the session lasts 30 days) and registers the server as
`sharedcut` with every CLI it finds (`claude`, `codex`). Restart the CLI afterwards.

- `npm run mcp:login`: sign in again when the session expires
- `npm run mcp:install`: register again (for example after moving the folder)

By hand, if you'd rather:

```sh
claude mcp add --scope user sharedcut -- node /path/to/SharedCut/mcp/server.ts
codex mcp add sharedcut -- node /path/to/SharedCut/mcp/server.ts
```

The session is stored in `~/sharedcut-agent/mcp.json`. Set `FRAME_LINE_URL` / `FRAME_LINE_COOKIE` to point at
another server (a throwaway test server, say).

## Other users

Other people install the standalone build from the public repo https://github.com/Konradical1/sharedcut-mcp
(no SharedCut source needed; they sign in with their own sharedcut.com account and see only projects shared with them).
To publish a new version after MCP or editor changes:

```sh
git clone https://github.com/Konradical1/sharedcut-mcp.git /tmp/sharedcut-mcp
npm run mcp:bundle -- /tmp/sharedcut-mcp
cd /tmp/sharedcut-mcp && git commit -am "SharedCut MCP <version>" && git push
```

## Tools

| Tool | Does |
|---|---|
| `projects` | list projects, open one |
| `timeline` | tracks and clips, one line each (filter by time or track) |
| `media` | the project's media and bins |
| `get` | full JSON of one clip, node, track, media, effect… |
| `act` | run editor actions in order, saved as one batch (all or nothing) |
| `job` | server work: uploads, captions, masks, depth, stabilize, noise reduction, tracking, color assistant, color normalize, exports, Resolve, sounds, fonts |
| `job plan` | the Plan read (script lines, shots with their takes, board cards); `script-export` writes .docx/.fountain/.html, `script-import` reads Fountain |
| `job color-*` | `color-grade` (a clip's nodes: wheels, windows, qualifier, HSL curves, mixer, film), `color-measure` (the graded frame as scope numbers against a reference picture, with hints naming the controls), `color-lut`, `color-looks`, `color-normalize`; the grading itself is `act` (`help color`) |
| `frame` | a small picture of the timeline or a source frame |
| `help` | catalogs: actions, effects, transitions, titles, shapes, color, properties, jobs… |
| `api` | escape hatch to any `/api` endpoint |

Ids print as short handles (`@3fa9c1d2`) to save tokens. Times are in seconds.

## Keeping it complete (for anyone adding a feature)

Every feature has to be reachable from the MCP. `npm test` runs `mcp/coverage.test.ts`, which fails when:

- a new **store action** (a method on `EditorStore` in `src/state/store.ts`) is not classified in `ACTIONS`
  in `mcp/catalog.ts`. Most need only `edit` (then `act` runs it, and `help actions` lists it with its doc comment).
- a new **server route** in `server/index.ts` is not covered in `ROUTES` in `mcp/coverage.test.ts`: either a
  job in `mcp/jobs/<feature>.ts` uses it, or say why it needs none.
- a job kind has no help line.

Catalogs (effects, transitions, title presets, shapes, blend modes, properties) are read from the app's own
definitions, so adding one of those needs no MCP change.
