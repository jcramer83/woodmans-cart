# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Woodmans Cart automates adding grocery items to a ShopWoodmans.com cart using Playwright. It has a GUI for managing weekly staple items, recipes with ingredients, AI recipe generation (Claude API), and one-click cart automation. Runs as either an Electron desktop app or a standalone Express web server (for Docker/Unraid deployment).

## Commands

```bash
npm install                  # Install dependencies
npm run setup                # Download Chromium for Playwright
npm start                    # Launch Electron GUI (desktop mode)
npm run cli                  # Run legacy CLI automation (node add-to-cart.js)
node server-standalone.js    # Run standalone web server (Docker mode, no Electron)
```

No test suite or linter is configured.

## Architecture

### Two Entry Points

- **`main.js`** — Electron main process. Manages window/tray, IPC handlers, starts `server.js` internally for optional remote access. Used via `npm start`.
- **`server-standalone.js`** — Docker/standalone entry point. Provides the same deps to `server.js` without Electron. Overlays environment variables (`WOODMANS_USERNAME`, `WOODMANS_PASSWORD`, `ANTHROPIC_API_KEY`, etc.) onto settings on every `readJSON()` call. Used via `node server-standalone.js`.

Both call `startServer()` from `server.js` with a deps object containing `readJSON`, `writeJSON`, file paths, and Electron callback stubs.

### Transport Abstraction

**`renderer/api-adapter.js`** detects the environment and unifies the API:
- **Electron**: proxies to `window.api` (IPC via `preload.js`)
- **Browser/Docker**: uses `fetch()` for REST + WebSocket for real-time updates

`renderer/app.js` calls `window.appApi.*` everywhere — it never knows which transport is active.

### Two Automation Modes

- **Standard mode (`cart-worker.js`)**: Full Playwright browser automation. Slower (~3-5s/item) but resilient to API changes.
- **Fast mode (`cart-worker-fast.js`)**: Direct GraphQL API calls using cached session cookies from a one-time headless login. ~10x faster. Uses hard-coded SHA256 persisted query hashes.

Toggled by `settings.fastMode`. Both `main.js` and `server.js` check this flag and route to the appropriate worker.

### Server (`server.js`)

Express + WebSocket server on port 3456. Provides REST endpoints (`/api/settings`, `/api/staples`, `/api/recipes`, `/api/cart/*`, `/api/products/search`, `/api/recipe/generate`) and WebSocket broadcasting for progress/item-done/cart-update events. Runs inside Electron (as embedded server) and standalone (Docker).

### Renderer (`renderer/`)

Vanilla HTML/CSS/JS SPA — no framework, no build step. `app.js` manages all state in module-level variables and renders via innerHTML. `styles.css` has CSS Grid layout with dark mode support.

### Data Files (`data/`)

Three JSON files — `settings.json` (credentials, store URL, delays, fastMode flag), `staples.json` (array of items with optional productName/brand), `recipes.json` (array of recipes with enabled flag and items sub-array). All use whole-array load/save pattern.

**`data/settings.json` contains real credentials and must never be committed** (excluded via `.gitignore`).

## Docker Deployment

`Dockerfile` uses `mcr.microsoft.com/playwright:v1.50.0-noble` base image, installs production deps only (`--omit=dev` skips Electron), runs `node server-standalone.js`. Credentials are passed as environment variables, data persisted via volume mount to `/app/data`.

## IPC Channel Map

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `settings:load/save` | renderer→main | User credentials and preferences |
| `staples:load/save` | renderer→main | Weekly staple items CRUD |
| `recipes:load/save` | renderer→main | Recipe definitions CRUD |
| `cart:start` | renderer→main | Launch cart automation |
| `cart:stop` | renderer→main | Abort running automation |
| `cart:progress` | main→renderer | Real-time progress messages |
| `cart:item-done` | main→renderer | Per-item completion status |
| `cart:online-update` | main→renderer | Refreshed online cart contents |
| `product:search` | renderer→main | Product search |
| `cart:fetch` | renderer→main | Import existing online cart |
| `cart:remove-all` | renderer→main | Clear online cart |
| `recipe:generate` | renderer→main | AI recipe generation |

## Key Patterns

- **Product search** scrapes clean names from URL slugs (`/products/123-product-name`) rather than DOM text to avoid badge/label contamination.
- **Cart removal** uses an `excludedCartIds` Set in the renderer — items are hidden from cart view without deleting source staples/recipes.
- **Recipe item editing** uses a sub-modal (`modal-recipe-item`) with its own product search, mirroring the staple modal's search flow.
- Functions used in inline `onclick` must be assigned to `window.*` at the bottom of `app.js`.
- Electron caches `require()` modules — changes to `cart-worker.js` or `cart-worker-fast.js` need a full app restart.
- ShopWoodmans.com is an Instacart white-label React SPA with portal overlays, ZIP code gates, and shopping mode dialogs that require `{ force: true }` clicks and multi-strategy selector fallbacks.
- Fast mode GraphQL hashes are hard-coded in `cart-worker-fast.js` — if Instacart changes their persisted queries, these need updating.

## POC Research Files

`poc-*.js` and `poc-*-results.json` files document reverse engineering of the ShopWoodmans.com/Instacart API. These are reference material, not production code.
