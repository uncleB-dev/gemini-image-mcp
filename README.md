# Gemini Image MCP

A tiny **remote MCP server** that lets Claude (or any MCP client) **generate images with Google Gemini**. Claude can't create images on its own — connect this and it can. The generated image is stored on **Vercel Blob** and returned as a **public URL** you can drop straight into an `<img src>`, an OG tag, or a blog post.

- **Five tools:** `generate_image` (text → image, exact sizing + webp/jpeg compression), `edit_image` (image(s) + prompt → new image), `list_models`, `list_images`, `delete_image`
- **Zero framework**, one serverless function (`api/mcp.js`), one dependency (`@vercel/blob`)
- **Bring your own API key.** Nothing is hard-coded; every secret is read from env.
- Works as a **claude.ai / Claude Cowork custom connector** (streamable-HTTP + SSE + token auth).

---

## Deploy your own (5 minutes)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FuncleB-dev%2Fgemini-image-mcp&env=GOOGLE_AI_API_KEY,MCP_AUTH_TOKEN&envDescription=Your%20Gemini%20API%20key%20%2B%20a%20secret%20token%20that%20guards%20the%20endpoint&project-name=gemini-image-mcp&repository-name=gemini-image-mcp)

Or manually: **Vercel → Add New → Project → import this repo** (Framework preset: *Other*).

### 1. Create a Vercel Blob store
Project → **Storage → Create Database → Blob** → **Connect** to this project.
This injects `BLOB_READ_WRITE_TOKEN` automatically — you don't set it by hand.

### 2. Set two environment variables
Project → **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `GOOGLE_AI_API_KEY` | Your Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (billing-enabled project) |
| `MCP_AUTH_TOKEN` | A secret **you** invent — it guards the endpoint. Generate one with `openssl rand -base64 32` |

> `BLOB_READ_WRITE_TOKEN` is added for you in step 1. The endpoint **fails closed** if `MCP_AUTH_TOKEN` is unset.

### 3. Turn off Deployment Protection
Project → **Settings → Deployment Protection → Vercel Authentication: OFF**.
(Otherwise MCP clients get a 401 from Vercel's auth wall, before they ever reach the server.)

### 4. Redeploy
**Deployments → latest → Redeploy** so the env vars take effect.

---

## Connect it to Claude

In **claude.ai → Settings → Connectors → Add custom connector**, use:

```
https://<your-project>.vercel.app/api/mcp?token=<MCP_AUTH_TOKEN>
```

The `?token=` query param is how claude.ai passes auth (it has no custom-header field). Once connected, the `generate_image` tool appears in Claude and Cowork.

You can also use it from **Claude Code** by adding it to `.mcp.json` / your MCP config as an HTTP server with an `Authorization: Bearer <MCP_AUTH_TOKEN>` header.

---

## The tools

### `generate_image` — text → image
| Arg | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | ✅ | Describe subject, style, lighting. Add "no text, no logos" for clean results. |
| `aspect_ratio` | string | – | Soft composition hint, e.g. `16:9`, `1:1`, `9:16` (use `width`/`height` for a hard crop). |
| `width` / `height` | integer | – | Exact output size in px. Both set → cover-crop to exactly W×H (e.g. **1200×630** for OG). One set → proportional resize. |
| `format` | string | – | `webp` \| `jpeg` \| `png`. **webp/jpeg strongly reduce file size** (PNG ~1.2 MB → webp ~150 KB). |
| `quality` | integer | – | 1–100 compression quality for webp/jpeg (default 82). |
| `name` | string | – | Base filename; a random suffix is added so every URL is unique. |
| `model` | string | – | Gemini model id (see `list_models`). Defaults to `gemini-2.5-flash-image`. |

Returns: `{ "url", "mime", "bytes", "model", "width", "height", "aspect_ratio" }`

> **Blog hero/OG recipe:** `width: 1200, height: 630, format: "webp"` — one call, ready to embed.

### `edit_image` — image(s) + prompt → new image
Feed existing image(s) and describe the change (recolor, add/remove an element, swap background, restyle, composite).
| Arg | Type | Required | Notes |
|---|---|---|---|
| `image_url` | string | ✅* | Source image: an http(s) URL (e.g. one from `generate_image`) or a `data:` URL. |
| `image_urls` | string[] | ✅* | *Or* up to 4 images — composite two photos, transfer a style, place a product on a background. |
| `prompt` | string | ✅ | What to change, e.g. "make the background dark navy, keep the apple". |
| `width`/`height`/`format`/`quality`/`name`/`model` | | – | Same output options as `generate_image`. |

Returns: `{ "url", "mime", "bytes", "model", "width", "height", "sources" }`

### `list_models` — pick a model
No arguments. Returns the image-capable Gemini models (queried live, with a curated fallback) plus the default:
```json
{ "default": "gemini-2.5-flash-image", "models": [ { "id": "gemini-2.5-flash-image", "description": "…" } ] }
```
Pass any returned `id` as the `model` argument to `generate_image` / `edit_image`.

### `list_images` — what's in the store
| Arg | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer | – | Max results (default 100, max 1000). |
| `cursor` | string | – | Pagination cursor from the previous call. |

Returns `{ count, total_bytes, has_more, cursor, images: [{ url, pathname, size, uploaded_at }] }` — handy for reviewing storage usage and finding candidates to clean up.

### `delete_image` — clean up
| Arg | Type | Required | Notes |
|---|---|---|---|
| `url` | string | ✅* | One Blob URL to delete. |
| `urls` | string[] | ✅* | *Or* up to 100 URLs at once. |

⚠️ Permanent — a blog post embedding a deleted URL will show a broken image. Check usage first.

---

## How it works

`api/mcp.js` is a single Vercel serverless function that speaks JSON-RPC 2.0 (MCP):

1. Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>` **or** `?token=<MCP_AUTH_TOKEN>`.
2. `initialize` / `tools/list` / `tools/call` handled inline.
3. `generate_image` / `edit_image` → call `<model>:generateContent` (text, or image + text), get base64 image bytes.
4. Uploads the bytes to Vercel Blob (`put(..., { access: "public" })`).
5. Returns the public Blob URL.
6. Responds as `text/event-stream` when the client's `Accept` header asks for SSE (required by claude.ai), otherwise plain JSON.

## Cost & notes
- **You pay** for your own Gemini API usage and Vercel Blob storage/bandwidth. This project has no billing of its own.
- The default model is `gemini-2.5-flash-image`; call `list_models` to see alternatives, or change `DEFAULT_MODEL` in `api/mcp.js`.
- Keep `MCP_AUTH_TOKEN` secret — anyone with the URL + token can spend your Gemini quota.

## License
MIT — see [LICENSE](./LICENSE). Copy it, fork it, ship it.
