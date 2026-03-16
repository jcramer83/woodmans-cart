# Woodmans Cart API Guide

API for managing a grocery shopping cart and ordering from Woodmans. Base URL: `http://localhost:3456`

All POST endpoints accept JSON bodies (`Content-Type: application/json`).

---

## Shopping Cart

### View Cart

```
GET /api/cart
```

Returns the combined shopping cart (staples + enabled recipes + manually added items):
```json
[
  { "id": "staple-abc", "item": "Whole Milk", "quantity": 1, "source": "staple" },
  { "id": "recipe-xyz-Ground Beef", "item": "Ground Beef", "quantity": 1, "source": "Tacos" },
  { "id": "manual-m1abc", "item": "Bananas", "quantity": 2, "source": "manual" }
]
```

### Add Item to Cart

```
POST /api/cart/add
Body: { "item": "organic whole milk", "quantity": 1 }
```

Adds an item to the shopping cart. These items will be searched and added to the Woodmans online cart when "Add to Woodmans Cart" is triggered.

### Remove Item from Cart

```
DELETE /api/cart/manual/:id
```

Removes a manual item by its ID (the part after `manual-`). Staple and recipe items are managed through their own endpoints.

### Clear Manual Items

```
POST /api/cart/manual/clear
```

---

## Item Management

### Staples (Weekly Recurring Items)

```
GET  /api/staples              → Array of staple items
POST /api/staples              → Save full staples array (replaces all)
```

Each staple: `{ "id": "...", "item": "Whole Milk", "productName": "Woodmans Whole Milk", "brand": "Woodmans" }`

### Recipes

```
GET  /api/recipes              → Array of recipes
POST /api/recipes              → Save full recipes array (replaces all)
```

Each recipe: `{ "id": "...", "name": "Tacos", "enabled": true, "items": [{ "item": "Ground Beef", ... }] }`

Only recipes with `"enabled": true` are included in the shopping cart.

### Product Search

```
GET /api/products/search?q=organic+milk
```

Returns matching products from the Woodmans catalog with name, price, size, brand, and image.

---

## AI Recipe Generation

### Generate a Recipe

```
POST /api/recipe/generate
Body: { "prompt": "healthy chicken stir fry", "dietaryFlags": { "glutenFree": true } }
```

Uses Claude AI to generate a full recipe with ingredients optimized for Woodmans product search.

### Get Recipe Suggestions

```
POST /api/recipe/suggest
Body: { "prompt": "quick weeknight dinners", "count": 5 }
```

Returns recipe name ideas (no full recipes).

---

## Checkout Flow

These endpoints interact with the Woodmans/Instacart system. The app must be in pickup mode (configured in settings).

### Push Cart to Woodmans

```
POST /api/cart/start
```

Searches and adds all shopping cart items (staples + enabled recipes + manual items) to the Woodmans online cart. This is the step that actually puts items in the Woodmans system.

### Get Available Pickup Time Slots

```
POST /api/checkout/timeslots
Body: { "shoppingMode": "pickup" }
```

Response:
```json
{
  "days": [
    {
      "day_full": "Sunday, March 16",
      "date": "Mar 16",
      "options": [
        {
          "id": "7525985868",
          "window": "8am - 9am",
          "price": "$4.95",
          "attributes": ["available"],
          "pickup_full_window": "Pickup tomorrow, 8am - 9am"
        }
      ]
    }
  ]
}
```

Only options with `"available"` in `attributes` can be selected. Use the `id` value when selecting a slot. Requires items in the Woodmans cart (push cart first).

### Select a Time Slot

```
POST /api/checkout/select-timeslot
Body: { "shoppingMode": "pickup", "optionId": "7525985868" }
```

### Preview Checkout

```
POST /api/checkout/preview
Body: { "shoppingMode": "pickup" }
```

Returns cart items with real Woodmans prices, totals (subtotal, tax), and service type info. The pickup fee (shown per-slot) is not included in totals — add it separately.

### Place Order

Order placement is done through the app UI (Checkout Preview → Place Order). Not exposed via API to prevent accidental charges.

---

## Error Handling

All endpoints return `{ "error": "message" }` on failure. Common errors:

- `"Session expired"` — Login session timed out, will auto-retry
- `"No payment method on file..."` — Add a credit card at shopwoodmans.com

---

## Example: Build a Cart

```bash
# Add items to shopping cart
curl -X POST localhost:3456/api/cart/add \
  -H "Content-Type: application/json" \
  -d '{"item":"organic whole milk","quantity":1}'

curl -X POST localhost:3456/api/cart/add \
  -H "Content-Type: application/json" \
  -d '{"item":"bananas","quantity":6}'

# View the cart
curl localhost:3456/api/cart

# Push to Woodmans (searches and adds each item)
curl -X POST localhost:3456/api/cart/start

# Check available pickup times
curl -X POST localhost:3456/api/checkout/timeslots \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# Select a time slot
curl -X POST localhost:3456/api/checkout/select-timeslot \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup","optionId":"7525985868"}'

# Preview totals
curl -X POST localhost:3456/api/checkout/preview \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# Place order through the app UI
```
