# Gemini Image MCP

A tiny **remote MCP server** that lets Claude (or any MCP client) **generate images with Google Gemini**. Claude can't create images on its own — connect this and it can. The generated image is stored on **Vercel Blob** and returned as a **public URL** you can drop straight into an `<img src>`, an OG tag, or a blog post.

- **One tool:** `generate_image(prompt, aspect_ratio?, name?)` → `{ url, mime, bytes }`
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

## The tool

### `generate_image`
| Arg | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | ✅ | Describe subject, style, lighting. Add "no text, no logos" for clean results. |
| `aspect_ratio` | string | – | Soft composition hint, e.g. `16:9`, `1:1`, `9:16` (no hard crop). |
| `name` | string | – | Base filename; a random suffix is added so every URL is unique. |

**Returns** (JSON text):
```json
{ "url": "https://<blob-host>/gemini/hero-abc123.png", "mime": "image/png", "bytes": 812345, "aspect_ratio": "16:9" }
```

---

## How it works

`api/mcp.js` is a single Vercel serverless function that speaks JSON-RPC 2.0 (MCP):

1. Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>` **or** `?token=<MCP_AUTH_TOKEN>`.
2. `initialize` / `tools/list` / `tools/call` handled inline.
3. `generate_image` → calls `gemini-2.5-flash-image:generateContent`, gets base64 image bytes.
4. Uploads the bytes to Vercel Blob (`put(..., { access: "public" })`).
5. Returns the public Blob URL.
6. Responds as `text/event-stream` when the client's `Accept` header asks for SSE (required by claude.ai), otherwise plain JSON.

## Cost & notes
- **You pay** for your own Gemini API usage and Vercel Blob storage/bandwidth. This project has no billing of its own.
- The model used is `gemini-2.5-flash-image`. Change `GEMINI_MODEL` in `api/mcp.js` to swap it.
- Keep `MCP_AUTH_TOKEN` secret — anyone with the URL + token can spend your Gemini quota.

## License
MIT — see [LICENSE](./LICENSE). Copy it, fork it, ship it.
