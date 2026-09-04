# P3X OneNote — Agent Guide (Global Note Search)

This fork adds a **global note search** on top of the upstream P3X OneNote wrapper (a
`<webview>`-based Electron shell around OneNote Online). This guide covers **only the
search feature and the code it touches**. The original featureset is out of scope — do
not modify it unless the search feature directly requires it (the only such changes so
far: `did-attach-webview` hook in `create/window/onenote.mjs` for the Ctrl+Shift+E
fallback, and the dogfood updater guard below).

## Stack and conventions

- Plain ESM `.mjs`, no TypeScript, no bundler. Electron 42.3.3, dev Node 24, yarn
  classic (`corepack yarn`), vitest (`yarn test`, 460 tests).
- Pure logic lives in `src/electron/lib/` and tests **import** it — never duplicate
  logic inline in test files (older non-search tests do; that's an anti-pattern).
- Headless modules in `src/electron/search/` import nothing from `electron` so vitest
  and plain-node CLI runs work. SQLite is Node's built-in `node:sqlite` (FTS5 verified
  inside Electron 42); `sqlite-backend.mjs` is the only module allowed to touch the
  engine (a `better-sqlite3` fallback exists but is untested and unused).

## Architecture map

```
renderer chrome (index.html + load.mjs, nodeIntegration)
 ├─ search/overlay.mjs        overlay panel, tabs [Search|Index], keyboard nav,
 │                            opens results via webview.src = oneNoteWebUrl (full
 │                            navigation — SPA-internal navigation deliberately deferred)
 ├─ search/token-harvester.mjs  webview token lift (storage scan + CDP bearer-header
 │                            capture) → main validates vs Graph. Currently finds 0
 │                            candidates on the live webapp — do not rely on it.
 ├─ ipc/handler.mjs           p3x-onenote-search-event → overlay/harvester
 └─ tab-manager.mjs           hooks: dom-ready + every navigation → searchHarvest
                              .onTabReady(tab); switchTab → searchOverlay.onTabSwitched
main process
 ├─ search-controller.mjs     owns the utilityProcess child; sync scheduling; token
 │                            store (electron-store, MAIN-ONLY writes); IPC handlers
 │                            (ipc-main.mjs); 401 get-token recovery; sign-out
 ├─ search-pkce.mjs           interactive PKCE sign-in: system browser +
 │                            loopback listener on dynamic http://localhost port
 ├─ search-token-validate.mjs candidate bearer tokens vs GET /me/onenote/notebooks?$top=1
 ├─ create/menu.mjs           Search menu (accelerator Ctrl+Shift+E, account display,
 │                            sign in/out, Index status)
 └─ app-events.mjs            search.init() on ready; shutdown() on before-quit
utilityProcess child (src/electron/search/indexer-entry.mjs, MessagePort protocol)
 ├─ sqlite-store.mjs          notes + FTS5 triggers, notebooks (enable flags),
 │                            activity (capped 50), meta (last_sync_at)
 ├─ graph-api-client.mjs      retries, throttle pacing, pagination, HTML→text
 ├─ search-service.mjs        the sync walk (incremental/tombstone/filter)
 └─ token-provider.mjs        token seam (child-side); future providers plug here
```

## Invariants that are easy to break

1. **MessagePort shape** — Electron's `process.parentPort` delivers web-style events:
   the message is at `event.data` (plain Node MessagePorts deliver it directly).
   `indexer-entry.mjs` unwraps both. Any new child message type must be added to
   BOTH the child handler and `search-controller.mjs`'s `onChildMessage` resolve list.
2. **electron-store** — main and renderer each instantiate `Store` on the same JSON
   file. All writes to `searchAuth` / `searchSyncStaleMs` / `searchClientId` happen in
   MAIN; the renderer reads only via IPC responses.
3. **Sync scheduling** — `requestSync({mode:'auto'})` is the single decision point:
   no DB → full; `last_sync_at` older than `searchSyncStaleMs` (24h) → incremental;
   else skip. Trigger sites (tab dom-ready/navigation + a 5-min interval in the
   harvester, all debounced) MUST call it even when `authState === 'ok'` — a valid
   PKCE token needs no harvest, but the index still needs its periodic sync. Missing
   this was a real bug (index stuck until manual Sync now).
4. **Graph budget** — 120 req/min + 400 req/hour, rolling, shared with other clients.
   The api client paces itself (`paceThrottle`, pauses + `throttle-waiting` event
   before the budget runs out) and honors `Retry-After` (bounded). Retry policy:
   429/5xx and wedged attempts (per-attempt 30s timeout) are transient (3 retries,
   linear backoff); **only a 401 is fatal per item** — everything else becomes a
   per-section/per-note skip via `sync-error` events and must never kill the sync
   (this has been broken twice: aborts classified as fatal).
5. **Tombstone safety** — notes are removed only when their own section was walked
   successfully in the current sync (`tombstone-plan.mjs`).
6. **Incremental** — per-note `lastModifiedDateTime` comparison; moved sections and
   missing timestamps always re-extract (`needs-indexing.mjs`).
7. **Notebook config** — enable flags live in the DB (`notebooks` table, written from
   the hierarchy every sync, default enabled) and are applied as the sync filter; an
   empty table means "all notebooks". `reset()` (full rebuild) keeps notebook config
   and the activity log.
8. **XSS safety** — indexed content must never reach innerHTML. FTS `snippet()` is
   called with char(1)/char(2) marks; `parse-snippet.mjs` splits them into segments
   rendered as `textContent` + `<mark>`.
9. **Per-account isolation** — DB at `userData/search/<accountKey>.sqlite3`;
   `accountKey()` (lib) sanitizes emails, `'default'` for unsigned tabs. PKCE sign-in
   stores under the account from the token's `preferred_username`/`upn`/`email`
   claim, not the tab's account.
10. **Ctrl+Shift+E** has three layers — menu accelerator, guest-webContents
    `before-input-event` (did-attach-webview hook), chrome-window `keydown`
    (load.mjs). Keep all three (menu accelerators are unreliable with focused
    `<webview>` guests; CDP `Input.dispatchKeyEvent` does NOT exercise
    before-input-event, so verify with a real keyboard).
11. **Translations** — every UI string lives under the `search` section of
    `src/translation/en-US.js`; `test/translations.test.mjs` enforces key parity
    across all 30 files. New keys must be injected into the 29 other files
    (English values are acceptable; `scripts/auto-translate.js` can translate later).
12. **Overlay layout** — view switching depends on `#p3x-search-overlay .p3x-hidden`
    (`display:none`) plus `flex: 1` + `min-height: 0` chains; the generic
    `.p3x-hidden` rules elsewhere are scoped to webviews only. Check computed styles,
    not class names, when verifying.
13. **Graceful shutdown** — `shutdown-ack` sets `gracefulExit` (the exit event that
    follows is expected); only log "exited unexpectedly" when neither `shuttingDown`
    nor `gracefulExit` is set.

## Auth

- Primary path: **interactive PKCE sign-in** (Search menu → Sign in for search, or the
  overlay button when auth is missing). System browser + loopback listener on a
  dynamic `http://localhost:<port>/` (Azure registration is bare `http://localhost`),
  `/consumers` authority (personal accounts only — corporate/AAD unsupported),
  scopes `Notes.Read User.Read offline_access openid profile`. Bundle
  `{accessToken, refreshToken, expiresOn, account}` stored in `searchAuth[key]`;
  the controller refreshes silently before syncs and on a child 401 (`get-token`
  flow). `DEFAULT_SEARCH_CLIENT_ID` in `search-pkce.mjs` is this fork's public
  client; `searchClientId` config overrides it.
- The webview **lift** (harvester) is kept cheap-first but is effectively dead
  against the live webapp — treat it as an opportunistic optimization.
- The seam for future auth providers: `token-provider.mjs` (child-side contract) and
  the controller's `resolveAccessToken` (main-side).

## Verification workflow (this dev box has no display)

- `corepack yarn test` for all logic; `yarn` is provisioned via
  `corepack prepare yarn@1.22.22 --activate`.
- Headless UI runs: Xvfb + nix-shell GTK libs + `~/.local/bin/p3x-electron-wrap.sh`,
  then drive the chrome page over CDP (`--remote-debugging-port=9223`): click
  `#p3x-search-btn`, switch `#p3x-search-tab-index`, read computed styles, check the
  app log for `[P3X-Search]` lines. See the repo's Claude memory
  (`electron-on-nixos.md`) for the full recipe and process-cleanup gotchas.
- Seed a fake index without an account: a node one-liner using `createSqliteStore`
  against `~/.config/p3x-onenote/search/default.sqlite3` (reset + setNotebooks +
  indexNote), restart, inspect the overlay. Clean up afterwards.
- Dogfood builds: `scripts/build-local-appimage.sh` (optionally `--install`) — the
  `-dogfood` version marker disables the auto-updater via a guard in
  `create/window/onenote.mjs`; the script temporarily moves `electron` to
  devDependencies and strips the publish-only `afterAllArtifactBuild` hook (both
  restored on exit). Arch needs `pacman -S fuse2` to run AppImages.
- Real-account syncs need the user (browser sign-in). Main-process logs carry the
  story: `[P3X-Search]` harvest/sync/token lines.

## Known quirks

- `GUEST_VIEW_MANAGER_CALL: ERR_ABORTED` when opening a result is benign — the webapp
  supersedes the `redir.aspx` navigation mid-flight.
- FTS5's unicode61 tokenizer: CJK search is limited (accepted for v1).
- Opening a result is a full webview navigation via the note's `oneNoteWebUrl` deep
  link; section-level redir URLs may resolve to the section rather than the page.
- Encrypted sections return 403 `20185` and are skipped by design.
