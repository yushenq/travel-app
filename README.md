# Travel

Sheng's trip planner and travel journal. An installable web app (PWA) that works offline on Android.

- **App**: plain HTML/JS in `public/`, no build step. Hosted on Cloudflare Workers as static assets (see `wrangler.jsonc`, which points at `public`).
- **Data**: Supabase project "Travel" (trips, days, items, entries, photos, plus a private `photos` storage bucket). Only emails listed in `allowed_users` can read or write.
- **Offline**: `sw.js` caches the app; the last synced data and photo files live in IndexedDB. Journal entries and photos made offline queue up and upload when the phone has signal.

## Releasing a change
Bump `VERSION` in `public/sw.js` with every change to the app files, so installed phones pick up the update (they show a "Reload" banner).

## Data shape
- `trips.map`: hand-drawn map (bbox, land outlines, places, bases, overlays) so the map needs no internet.
- `days.route`: `{ legs: [[mode, [placeKeys]]], fit: [placeKeys] }` where mode is drive, fly, boat or coach.
- `items.section`: free-text section names shown on the Info tab, in `sort` order.
