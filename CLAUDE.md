# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Woodmans Cart is a web app that automates adding grocery items to a ShopWoodmans.com cart. It has a GUI for managing weekly staple items, recipes with ingredients, AI recipe generation (Claude API), and one-click cart automation. Runs as a standalone Express web server (designed for Docker/Unraid deployment).

## Commands

```bash
npm install               # Install dependencies
npm start                 # Run web server (node server-standalone.js)
```

No test suite or linter is configured. The app runs on port 3456.

## Architecture

### Entry Point

**`server-standalone.js`** is the sole entry point. It creates `readJSON`/`writeJSON` helpers (with env var overlay for credentials), ensures data files exist, then calls `startServer()` from `server.js`.

### Server (`server.js`)

Express + WebSocket server. Accepts a `deps` object with `readJSON`, `writeJSON`, and file paths. Provides REST endpoints and WebSocket broadcasting for real-time progress/item-done/cart-update events.

**REST endpoints:**
- `GET/POST /api/settings` — User credentials and preferences
- `GET/POST /api/staples` — Weekly staple items
- `GET/POST /api/recipes` — Recipe definitions
- `GET /api/products/search?q=` — Product search via GraphQL
- `POST /api/cart/start` — Launch cart automation
- `POST /api/cart/stop` — Abort running automation
- `POST /api/cart/fetch` — Import current online cart
- `POST /api/cart/remove-all` — Clear online cart
- `POST /api/recipe/generate` — AI recipe generation (Claude Sonnet 4.5)
- `POST /api/recipe/suggest` — AI recipe suggestions (Claude Haiku 4.5)
- `POST /api/recipe/image` — Scrape Bing Images for recipe photo, cache to `data/recipe-images/`
- `POST /api/recipe/image/delete` — Delete cached recipe image

### Renderer (`renderer/`)

Vanilla HTML/CSS/JS SPA — no framework, no build step. Four files: `index.html`, `styles.css`, `app.js`, `api-adapter.js`.

**`api-adapter.js`** exposes `window.appApi` — a unified API layer using `fetch()` for REST and WebSocket (with auto-reconnect) for real-time events. All of `app.js` calls `window.appApi.*` exclusively.

**`app.js`** (~1650 lines) manages all state in module-level variables and renders via innerHTML. Functions used in inline `onclick` handlers must be assigned to `window.*` at the bottom of the file.

### Cart Automation (`cart-worker-fast.js`)

Direct GraphQL API calls against ShopWoodmans.com (an Instacart white-label). Login uses pure HTTP against Azure AD B2C OAuth2 — no browser needed. Uses hard-coded SHA256 persisted query hashes for GraphQL operations. If Instacart changes their persisted queries, these hashes need updating.

**Hardcoded values:** ZIP code `53177`, zone ID `1022`, and shop IDs for instore/pickup modes are baked into the worker. These would need changing for different store locations.

### AI Integration

Uses raw HTTPS requests to `api.anthropic.com` (no SDK). Two models:
- **Recipe generation** (`/api/recipe/generate`): Claude Opus 4.6 — full recipe with ingredients, instructions, and search-optimized item names
- **Recipe suggestions** (`/api/recipe/suggest`): Claude Sonnet 4.5 — quick recipe idea brainstorming

Dietary flags (gluten-free, dairy-free, organic, picky-eater) are injected into prompts.

### Data Files (`data/`)

- `settings.json` — credentials, store URL, delays, shopping mode. **Contains real credentials — never commit** (excluded via `.gitignore`).
- `staples.json` — array of items with optional productName/brand
- `recipes.json` — array of recipes with enabled flag and items sub-array
- `recipe-images/` — cached recipe photos from Bing scraping (excluded via `.gitignore`)

All use whole-array load/save pattern via `readJSON`/`writeJSON`.

## Environment Variables

Used in Docker deployments, overlaid onto settings by `server-standalone.js`:

| Variable | Description |
|----------|-------------|
| `WOODMANS_USERNAME` | Woodmans-Food.com login email |
| `WOODMANS_PASSWORD` | Woodmans-Food.com password |
| `ANTHROPIC_API_KEY` | Claude API key for AI recipes |
| `ZIP_CODE` | Store ZIP code |
| `STORE_URL` | Store URL override |
| `SHOPPING_MODE` | `instore` or `pickup` |

## Docker / CI

`Dockerfile` uses `node:20-slim`, installs production deps only (`--omit=dev`), runs `server-standalone.js`. GitHub Actions (`.github/workflows/docker.yml`) builds and pushes to `ghcr.io/jcramer83/woodmans-cart` on every push to `master`, tagged with `latest` + short git SHA.

## Key Patterns

- **Product search** scrapes clean names from URL slugs (`/products/123-product-name`) rather than DOM text to avoid badge/label contamination.
- **Cart removal** uses an `excludedCartIds` Set in the renderer — items are hidden from cart view without deleting source staples/recipes.
- **Recipe item editing** uses a sub-modal (`modal-recipe-item`) with its own product search, mirroring the staple modal's search flow.
- ShopWoodmans.com is an Instacart white-label React SPA — its GraphQL API uses persisted query hashes and requires specific cookie/header patterns.

## POC Research Files

`poc-*.js`, `poc-*-results.json`, and `temp_*.js`/`temp_*.html` files document reverse engineering of the ShopWoodmans.com/Instacart API. These are reference material, not production code.
