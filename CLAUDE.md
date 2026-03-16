# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Woodmans Cart is a web app that automates adding grocery items to a ShopWoodmans.com cart, previewing checkout, and placing orders. It has a GUI for managing weekly staple items, recipes with ingredients, AI recipe generation (Claude API), and one-click cart automation. Runs as a standalone Express web server (designed for Docker/Unraid deployment).

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
- `GET/POST /api/staples` — Weekly staple items (POST with object adds one, with array replaces all)
- `PATCH/DELETE /api/staples/:id` — Update or remove a single staple
- `GET/POST /api/recipes` — Recipe definitions
- `GET /api/recipes/active` — Only enabled recipes with ingredients
- `GET /api/cart` — Combined internal cart (staples + enabled recipes + manual items) with estimated total
- `POST /api/cart/add` — Add item to internal cart (auto-enriches with Woodmans image/price)
- `GET/POST/PATCH/DELETE /api/cart/manual` — Manual cart item CRUD
- `GET/POST /api/shopping-mode` — Get/set shopping mode (pickup or instore)
- `GET /api/products/search?q=` — Product search via GraphQL
- `POST /api/cart/start` — Launch cart automation (builds items from internal cart if no body)
- `POST /api/cart/stop` — Abort running automation
- `POST /api/cart/fetch` — Get current Woodmans online cart (returns items with `itemId`)
- `POST /api/cart/remove` — Remove a single item from Woodmans cart by `itemId`
- `POST /api/cart/remove-all` — Clear entire Woodmans online cart
- `POST /api/cart/copy` — Copy cart between shopping modes
- `POST /api/checkout/preview` — Fetch cart + real totals from Woodmans
- `POST /api/checkout/timeslots` — Fetch pickup/delivery time slots
- `POST /api/checkout/select-timeslot` — Reserve a time slot on Woodmans
- `POST /api/checkout/place-order` — Place order (charges card on file)
- `POST /api/checkout/service-options` — Fetch service chooser (pickup vs delivery)
- `POST /api/recipe/generate` — AI recipe generation (Claude Opus 4.6)
- `POST /api/recipe/suggest` — AI recipe suggestions (Claude Sonnet 4.5)
- `POST /api/recipe/image` — Scrape Bing Images for recipe photo, cache to `data/recipe-images/`
- `POST /api/recipe/image/delete` — Delete cached recipe image

See `AI-API-GUIDE.md` for the external AI integration API (subset of above focused on internal cart management).

### Renderer (`renderer/`)

Vanilla HTML/CSS/JS SPA — no framework, no build step. Four files: `index.html`, `styles.css`, `app.js`, `api-adapter.js`.

**`api-adapter.js`** exposes `window.appApi` — a unified API layer using `fetch()` for REST and WebSocket (with auto-reconnect) for real-time events. All of `app.js` calls `window.appApi.*` exclusively.

**`app.js`** (~2200 lines) manages all state in module-level variables and renders via innerHTML. Functions used in inline `onclick` handlers must be assigned to `window.*` at the bottom of the file.

### Cart Automation (`cart-worker-fast.js`)

Direct GraphQL API calls against ShopWoodmans.com (an Instacart white-label). Login uses pure HTTP against Azure AD B2C OAuth2 — no browser needed. Uses hard-coded SHA256 persisted query hashes for GraphQL operations. If Instacart changes their persisted queries, these hashes need updating.

**Hardcoded values:** ZIP code `53177`, zone ID `1022`, shop IDs (`755260` pickup, `755261` instore), retailer ID `1396`, and pickup location ID `498198` (Racine store) are baked into the worker. These would need changing for different store locations.

### Two-Layer Mode Switching

Shopping mode (pickup vs instore) requires switching at **two** independent layers:
1. **Cart layer** — `ensureShoppingMode()` calls `VisitShop` GraphQL mutation to switch the cart's shop ID. This changes which cart is active.
2. **Checkout layer** — `ensureCheckoutServiceType()` uses `PUT /v3/orders/new` with `X-Requested-With: XMLHttpRequest` header to switch checkout service type and set retailer location. This is required before fetching pickup time slots or checkout totals. The PUT must run every time (Instacart can reset checkout state between requests).

### Order Placement Flow

The full checkout/order flow (`placeOrder()` in cart-worker-fast.js):
1. `ensureCheckoutServiceType()` — switches checkout to pickup or delivery via PUT
2. Time slot selected via `selectDeliveryOption()` — reserves slot via PUT to `/v3/orders/new`
3. `placeOrder()` — POSTs to `/v3/orders` with **all params in the body** (service_type, deliveries, retailer_locations, payment_instructions, user_phone). The PUT to `/v3/orders/new` does NOT persist state for order creation — all params must be in the POST body.
4. Payment instructions use `payment_instrument_id` (not `payment_method_id`) fetched from the checkout container's `preselected_payment_instructions`, falling back to building from `payment_methods` list with correct key names.
5. Phone number comes from `settings.phoneNumber` or `PHONE_NUMBER` env var.
6. The place-order endpoint auto-retries once with a fresh session on any failure.

### V3 REST API (`v3Request`)

All V3 REST calls use a unified `v3Request()` helper that includes `X-Requested-With: XMLHttpRequest`, `Origin`, and checkout `Referer` headers. Three convenience wrappers: `v3Get`, `v3Post`, `v3Put`. These are separate from the GraphQL API (`gqlGet`/`gqlPost`) which hits `/graphql`.

**Pickup-specific endpoints:**
- Pickup time slots: `GET /v3/retailers/1396/pickup_options?retailer_locations[1396]=498198` (NOT `delivery_options` which always returns delivery data)
- Checkout totals: `GET /v3/module_data/checkouttotals?service_type=pickup` (the `service_type` param must match the mode — the checkout container's `async_data_path` hardcodes `service_type=delivery`)
- Checkout totals are fetched sequentially after other calls (not in parallel) because Instacart needs time to recalculate after a service type switch

### Auto-Enrichment

When items are added via `POST /api/cart/add` or `POST /api/staples` (single item), the server automatically searches Woodmans for the product and populates image URL, price, and exact product name from the first match. This ensures items added via API have images in the UI.

### AI Integration

Uses raw HTTPS requests to `api.anthropic.com` (no SDK). Two models:
- **Recipe generation** (`/api/recipe/generate`): Claude Opus 4.6 — full recipe with ingredients, instructions, and search-optimized item names
- **Recipe suggestions** (`/api/recipe/suggest`): Claude Sonnet 4.5 — quick recipe idea brainstorming

Dietary flags (gluten-free, dairy-free, organic, picky-eater) are injected into prompts.

### Data Files (`data/`)

- `settings.json` — credentials, store URL, delays, shopping mode, phone number. **Contains real credentials — never commit** (excluded via `.gitignore`).
- `staples.json` — array of items with optional productName/brand/price/image
- `recipes.json` — array of recipes with enabled flag and items sub-array
- `manual-items.json` — manually added cart items
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
| `PHONE_NUMBER` | Phone number for order placement |

## Docker / CI

`Dockerfile` uses `node:20-slim`, installs production deps only (`--omit=dev`), runs `server-standalone.js`. GitHub Actions (`.github/workflows/docker.yml`) builds and pushes to `ghcr.io/jcramer83/woodmans-cart` on every push to `master`, tagged with `latest` + short git SHA.

## Key Patterns

- **Product search** scrapes clean names from URL slugs (`/products/123-product-name`) rather than DOM text to avoid badge/label contamination.
- **Cart removal** uses an `excludedCartIds` Set in the renderer — items are hidden from cart view without deleting source staples/recipes.
- **Recipe item editing** uses a sub-modal (`modal-recipe-item`) with its own product search, mirroring the staple modal's search flow.
- ShopWoodmans.com is an Instacart white-label React SPA — its GraphQL API uses persisted query hashes and requires specific cookie/header patterns.
- **Progress message routing** — WebSocket progress messages are routed client-side using a `cartOperationActive` flag: messages go to the online cart activity area only during cart operations (fetch/remove/add); all other progress goes to the main status line below checkout preview.
- **`POST /api/cart/start`** builds items from internal cart (staples + enabled recipes + manual items) when called with no body, so API callers don't need to provide items.

## POC Research Files

`poc-*.js`, `poc-*-results.json`, and `temp_*.js`/`temp_*.html` files document reverse engineering of the ShopWoodmans.com/Instacart API. These are reference material, not production code.
