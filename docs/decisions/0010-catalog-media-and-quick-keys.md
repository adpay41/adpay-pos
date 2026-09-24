# 0010: Product photos in Postgres behind a MediaStore, and the quick-key layout model

- Status: Accepted
- Date: 2026-09-24
- Decides spec **Open** item: "Quick-key layout editor scope"
- Build plan: P2 (F1 part 2). Bible: L34 (item add/edit with photo), L2 (per-store layout, colors, images, favorites), L35

## Context

The Bible asks for "snap the product, type price, done; pushed to all registers in seconds" and a
quick-key grid "with per-store layout, colors, images, favorites". Drag-to-arrange from the merchant
app is tier N (P14). ADR 0007 requires everything to run locally with no AWS, and deploying storage
needs the founder's go, so S3 isn't available yet.

## Decisions

### 1. Photos: Postgres `media` table now, behind `MediaStore`

- **Clients shrink before upload**: square crop, 512px, JPEG around 0.72 quality. The merchant app
  uses `expo-image-manipulator` and admin uses a canvas, which gives tens of KB per photo. The API
  caps uploads at 1 MB and checks **magic bytes**. The declared type must match what the bytes
  are, and only JPEG, PNG and WebP are accepted, so SVG and script payloads are refused.
- **Content-addressed per merchant** (`UNIQUE (merchant_id, sha256)`): re-uploading returns the
  same id. Rows are **immutable** (trigger), so a new photo means a new row, and nothing that
  references a photo can see it change underneath.
- **Served publicly by random id** at `GET /media/:id` with `cache-control: immutable, 1 year`.
  Product photos are what the merchant shows customers. The id is an unguessable UUID, and an
  `<img>` or register tile can't send a bearer token. The long cache also lets a register keep
  showing photos while offline. An item may reference only its own merchant's media.
- **Why not S3 now**: it needs AWS, which needs the founder's go (ADR 0005/0007). At ~50 KB × 2,000
  items ≈ 100 MB per merchant, Postgres is fine for the pilot. `MediaStore` is the seam: an S3
  implementation replaces `pgMediaStore` and `/media/:id` redirects to a CDN URL. No caller changes.

### 2. Quick-key layout: favorites page + ordered categories + tile color

- **Favorites per location** (`location_quick_keys`, ordered, max 48): the register's first page,
  selected by default when non-empty. Per location, because two stores of one owner sell different
  things fast.
- **Order**: categories and items carry `sort`. New items are appended to their category, and
  `PUT …/catalog/order` rewrites `sort` for a list in one transaction. The merchant app and admin
  offer up/down controls. Drag-to-arrange (N) only needs a new UI over the same endpoint.
- **Tile color** is an enum over a **fixed palette** (`TILE_COLORS` in shared, and a DB CHECK),
  not free hex. Tiles sit next to prices and the brand rule is **never red near a dollar amount**,
  so the palette has no red and no green (green means approved/money). The price text is black on
  every tile.
- Every change bumps `catalog_version`, so registers pull it on their next tick like any catalog
  change. Migration 0003 bumps every merchant once so no register keeps a pre-P2 snapshot.

## Consequences

- Scope of the "layout editor" in v1: favorites list, category order, item order, tile color, photo.
  Not in v1: free placement on a grid, multiple custom pages, per-register layouts. They can be
  added as more rows keyed by location/register without changing the snapshot's existing fields.
- The M-tier "predictive next item" can add a computed page beside favorites. Nothing here blocks it.
- Media bytes are in database backups. When S3 arrives, a one-time copy job moves them.
