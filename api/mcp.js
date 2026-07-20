// Gemini image-generation remote MCP server — Vercel serverless function.
//
// Streamable-HTTP MCP endpoint (same pattern as vercel-blogger-mcp) exposing a
// single tool `generate_image`: it calls the Gemini image API, stores the
// result in Vercel Blob, and returns a public image URL. Designed to be added
// as a claude.ai / Cowork custom connector.
//
// Env (set in the Vercel dashboard → Settings → Environment Variables):
//   GOOGLE_AI_API_KEY        Gemini API key (billing-enabled project)
//   MCP_AUTH_TOKEN           guards this endpoint (Bearer header or ?token=)
//   BLOB_READ_WRITE_TOKEN    auto-provided when you create a Vercel Blob store
//
// Auth: Authorization: Bearer <MCP_AUTH_TOKEN>  OR  ?token=<MCP_AUTH_TOKEN>.
// Fails closed if MCP_AUTH_TOKEN is unset.

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "gemini-image", version: "0.3.0" };
const DEFAULT_MODEL = "gemini-2.5-flash-image";

// Curated fallback if the live models listing is unavailable. These are the
// Gemini models that produce images via the :generateContent path this server
// uses (Imagen models use a different :predict endpoint and are not listed).
const FALLBACK_MODELS = [
  { id: "gemini-2.5-flash-image", description: "Fast, high-quality image generation and editing (default)." },
  { id: "gemini-2.0-flash-preview-image-generation", description: "Preview image generation model." },
];

class GenError extends Error {}

function apiKey() {
  const key = (process.env.GOOGLE_AI_API_KEY || "").trim();
  if (!key) throw new GenError("GOOGLE_AI_API_KEY is not set in Vercel env.");
  return key;
}

// Core call: send a parts array (text and/or inline image) to a model, get an
// image back. Used by both generate_image and edit_image.
async function geminiGenerate(parts, model) {
  const m = (model || DEFAULT_MODEL).replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey()}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!r.ok) throw new GenError(`Gemini API error ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = await r.json();
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of outParts) {
    if (p.inlineData?.data) {
      return { b64: p.inlineData.data, mime: p.inlineData.mimeType || "image/png" };
    }
  }
  throw new GenError("No image in Gemini response (the model may have returned text only).");
}

// Fetch bytes for an image reference: an http(s) URL or a data: URL.
async function fetchImageBytes(ref) {
  if (typeof ref !== "string" || !ref) throw new GenError("image_url (string) is required.");
  if (ref.startsWith("data:")) {
    const m = ref.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new GenError("Malformed data: URL.");
    const mime = m[1] || "image/png";
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
    return { b64: buf.toString("base64"), mime };
  }
  if (!/^https?:\/\//i.test(ref)) throw new GenError("image_url must be an http(s) or data: URL.");
  const r = await fetch(ref);
  if (!r.ok) throw new GenError(`Could not fetch image_url (${r.status}).`);
  const mime = (r.headers.get("content-type") || "image/png").split(";")[0];
  const buf = Buffer.from(await r.arrayBuffer());
  return { b64: buf.toString("base64"), mime };
}

async function listGeminiModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey()}&pageSize=200`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    const models = (data.models || [])
      .filter((mo) => {
        const name = (mo.name || "").toLowerCase();
        const methods = mo.supportedGenerationMethods || [];
        return name.includes("image") && methods.includes("generateContent");
      })
      .map((mo) => ({
        id: (mo.name || "").replace(/^models\//, ""),
        description: mo.description || mo.displayName || "",
      }));
    return models.length ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

async function uploadBlob(buffer, mime, name) {
  const { put } = await import("@vercel/blob");
  const ext = mime.includes("webp") ? "webp" : mime.includes("png") ? "png" : "jpg";
  const safe = (name || "image").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  const blob = await put(`gemini/${safe}.${ext}`, buffer, {
    access: "public",
    contentType: mime,
    addRandomSuffix: true, // unique URL per generation
  });
  return blob.url;
}

// Optional post-processing with sharp: exact resize/crop + format/quality.
// width+height -> cover-crop to exactly that size; one of them -> proportional.
// format: "webp" | "jpeg" | "png" (default: keep source format).
async function postProcess(buffer, mime, opts) {
  const { width, height, format, quality } = opts || {};
  if (!width && !height && !format && !quality) return { buffer, mime };
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new GenError("Post-processing unavailable: the sharp package is not installed in this deployment.");
  }
  let img = sharp(buffer);
  if (width || height) {
    img = img.resize({
      width: width || null,
      height: height || null,
      fit: width && height ? "cover" : "inside",
      position: "attention", // crop toward the most interesting region
      withoutEnlargement: false,
    });
  }
  const q = Math.min(100, Math.max(1, quality || 82));
  let fmt = (format || "").toLowerCase();
  if (fmt === "jpg") fmt = "jpeg";
  if (fmt === "webp") { img = img.webp({ quality: q }); mime = "image/webp"; }
  else if (fmt === "jpeg") { img = img.jpeg({ quality: q, mozjpeg: true }); mime = "image/jpeg"; }
  else if (fmt === "png") { img = img.png(); mime = "image/png"; }
  else if (quality) {
    // quality given without format: keep family, apply quality where it applies
    if (mime.includes("png")) { img = img.png(); }
    else if (mime.includes("webp")) { img = img.webp({ quality: q }); }
    else { img = img.jpeg({ quality: q, mozjpeg: true }); mime = "image/jpeg"; }
  }
  const out = await img.toBuffer();
  return { buffer: out, mime };
}

// ---- tools -------------------------------------------------------------- //
async function toolGenerateImage(args) {
  let prompt = args.prompt;
  if (!prompt || typeof prompt !== "string") throw new GenError("prompt (string) is required.");
  // Aspect ratio is a soft hint appended to the prompt; width/height do a real crop.
  if (args.aspect_ratio) {
    prompt += `\n\nComposition: ${args.aspect_ratio} aspect ratio, well-framed for that ratio.`;
  } else if (args.width && args.height) {
    prompt += `\n\nComposition: framed for a ${args.width}x${args.height} crop.`;
  }
  const { b64, mime: rawMime } = await geminiGenerate([{ text: prompt }], args.model);
  const processed = await postProcess(Buffer.from(b64, "base64"), rawMime, args);
  const url = await uploadBlob(processed.buffer, processed.mime, args.name);
  return JSON.stringify({
    url, mime: processed.mime, bytes: processed.buffer.length,
    model: args.model || DEFAULT_MODEL,
    width: args.width || null, height: args.height || null,
    aspect_ratio: args.aspect_ratio || null,
  }, null, 2);
}

async function toolEditImage(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== "string") throw new GenError("prompt (string) is required.");
  // Accept one image (image_url) or several (image_urls) — e.g. composite/style transfer.
  const refs = Array.isArray(args.image_urls) && args.image_urls.length
    ? args.image_urls
    : args.image_url ? [args.image_url] : [];
  if (!refs.length) throw new GenError("Provide image_url or image_urls (at least one).");
  if (refs.length > 4) throw new GenError("At most 4 input images.");
  const parts = [];
  for (const ref of refs) {
    const src = await fetchImageBytes(ref);
    parts.push({ inline_data: { mime_type: src.mime, data: src.b64 } });
  }
  parts.push({ text: prompt });
  const { b64, mime: rawMime } = await geminiGenerate(parts, args.model);
  const processed = await postProcess(Buffer.from(b64, "base64"), rawMime, args);
  const url = await uploadBlob(processed.buffer, processed.mime, args.name || "edited");
  return JSON.stringify({
    url, mime: processed.mime, bytes: processed.buffer.length,
    model: args.model || DEFAULT_MODEL,
    width: args.width || null, height: args.height || null,
    sources: refs,
  }, null, 2);
}

async function toolListModels() {
  const models = await listGeminiModels();
  return JSON.stringify({ default: DEFAULT_MODEL, models }, null, 2);
}

async function toolListImages(args) {
  const { list } = await import("@vercel/blob");
  const res = await list({
    prefix: "gemini/",
    limit: Math.min(1000, Math.max(1, (args && args.limit) || 100)),
    cursor: (args && args.cursor) || undefined,
  });
  const images = res.blobs.map((b) => ({
    url: b.url, pathname: b.pathname, size: b.size, uploaded_at: b.uploadedAt,
  }));
  const totalBytes = res.blobs.reduce((s, b) => s + (b.size || 0), 0);
  return JSON.stringify({
    count: images.length, total_bytes: totalBytes,
    has_more: res.hasMore || false, cursor: res.cursor || null, images,
  }, null, 2);
}

// Bring image bytes INTO the client as base64. Exists because some sandboxed
// clients (e.g. Claude Cowork) cannot fetch the Blob domain directly — but MCP
// tool results always get through. Downscales/compresses by default to keep
// the payload reasonable.
async function toolFetchImage(args) {
  const src = await fetchImageBytes(args.url);
  let buffer = Buffer.from(src.b64, "base64");
  let mime = src.mime;
  const maxDim = args.max_dimension === 0 ? 0 : (args.max_dimension || 1024);
  const wantsRaw = args.raw === true;
  if (!wantsRaw) {
    try {
      const sharp = (await import("sharp")).default;
      let img = sharp(buffer);
      if (maxDim > 0) {
        img = img.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });
      }
      const q = Math.min(100, Math.max(1, args.quality || 80));
      img = img.webp({ quality: q });
      buffer = await img.toBuffer();
      mime = "image/webp";
    } catch { /* sharp unavailable: fall through with original bytes */ }
  }
  if (buffer.length > 4 * 1024 * 1024) {
    throw new GenError(`Image too large to return inline (${buffer.length} bytes). ` +
      "Lower max_dimension/quality, or use raw:false.");
  }
  return JSON.stringify({
    data_url: `data:${mime};base64,${buffer.toString("base64")}`,
    mime, bytes: buffer.length, source: args.url,
    note: wantsRaw ? "raw original bytes" : `re-encoded to webp (max ${maxDim || "original"}px)`,
  }, null, 2);
}

async function toolDeleteImage(args) {
  const { del } = await import("@vercel/blob");
  const urls = Array.isArray(args.urls) && args.urls.length
    ? args.urls
    : args.url ? [args.url] : [];
  if (!urls.length) throw new GenError("Provide url or urls (at least one Blob URL to delete).");
  if (urls.length > 100) throw new GenError("At most 100 URLs per call.");
  await del(urls);
  return JSON.stringify({ deleted: urls.length, urls }, null, 2);
}

// Shared output-shaping properties for generate_image / edit_image.
const OUTPUT_PROPS = {
  width: { type: "integer", description: "Optional exact output width in px (with height: cover-crop to exactly WxH, e.g. 1200x630 for OG)." },
  height: { type: "integer", description: "Optional exact output height in px." },
  format: { type: "string", enum: ["webp", "jpeg", "jpg", "png"], description: "Optional output format. webp/jpeg strongly reduce file size for blogs." },
  quality: { type: "integer", description: "Optional 1-100 compression quality for webp/jpeg (default 82)." },
  name: { type: "string", description: "Optional base filename (a random suffix is added for uniqueness)." },
  model: { type: "string", description: "Optional Gemini model id (see list_models). Defaults to gemini-2.5-flash-image." },
};

const TOOLS = {
  generate_image: {
    handler: toolGenerateImage,
    schema: {
      name: "generate_image",
      description: "Generate an image with Google Gemini from a text prompt, store it in Vercel " +
        "Blob, and return a public image URL (usable directly as <img src> or an OG image). " +
        "Supports exact sizing (width/height cover-crop) and webp/jpeg compression. " +
        "For clean results, describe subject, style, lighting and say 'no text, no logos'. " +
        "Blog hero/OG tip: width 1200, height 630, format webp.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate." },
          aspect_ratio: { type: "string", description: "Optional composition hint, e.g. '16:9', '1:1', '9:16' (soft hint; use width/height for a hard crop)." },
          ...OUTPUT_PROPS,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  edit_image: {
    handler: toolEditImage,
    schema: {
      name: "edit_image",
      description: "Edit existing image(s) with Google Gemini. Provide one image (image_url) or up to 4 " +
        "(image_urls, e.g. composite two images or transfer style) plus a prompt describing the change " +
        "(recolor, add/remove an element, change background, restyle). Accepts http(s) URLs — e.g. ones " +
        "returned by generate_image — or data: URLs. Returns a new public image URL. " +
        "Supports the same width/height/format/quality output options as generate_image.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "Source image to edit: an http(s) URL or a data: URL." },
          image_urls: { type: "array", items: { type: "string" }, description: "Multiple source images (max 4) for composites/style transfer. Use instead of image_url." },
          prompt: { type: "string", description: "What to change, e.g. 'make the background dark navy, keep the apple'." },
          ...OUTPUT_PROPS,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  list_models: {
    handler: toolListModels,
    schema: {
      name: "list_models",
      description: "List Google Gemini models that can generate/edit images through this server " +
        "(the :generateContent path). Use the returned id as the `model` argument to generate_image " +
        "or edit_image. Returns the default model too.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  list_images: {
    handler: toolListImages,
    schema: {
      name: "list_images",
      description: "List images stored in this server's Vercel Blob store (the gemini/ prefix): URL, " +
        "size, and upload time, plus total bytes. Use to review or clean up generated images.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max images to return (default 100, max 1000)." },
          cursor: { type: "string", description: "Pagination cursor from a previous call's `cursor` field." },
        },
        additionalProperties: false,
      },
    },
  },
  fetch_image: {
    handler: toolFetchImage,
    schema: {
      name: "fetch_image",
      description: "Fetch an image's bytes as a base64 data URL through this server. Use when your " +
        "environment cannot download the Blob domain directly (e.g. a sandboxed client) but you need " +
        "the actual bytes locally — save the data URL's base64 part to a file. By default re-encodes " +
        "to webp at max 1024px to keep the payload small; set raw:true for the untouched original.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Image URL to fetch (e.g. a Blob URL from generate_image)." },
          max_dimension: { type: "integer", description: "Max width/height in px before re-encoding (default 1024; 0 = no resize)." },
          quality: { type: "integer", description: "webp quality 1-100 (default 80)." },
          raw: { type: "boolean", description: "true = return original bytes untouched (may be large; 4 MB cap)." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  delete_image: {
    handler: toolDeleteImage,
    schema: {
      name: "delete_image",
      description: "Delete image(s) from the Vercel Blob store by URL (as returned by generate_image, " +
        "edit_image, or list_images). Deletion is permanent — any blog post embedding the URL will " +
        "show a broken image, so check usage before deleting.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "One Blob URL to delete." },
          urls: { type: "array", items: { type: "string" }, description: "Multiple Blob URLs to delete (max 100). Use instead of url." },
        },
        additionalProperties: false,
      },
    },
  },
};

// ---- JSON-RPC / MCP dispatch (mirrors vercel-blogger-mcp) ---------------- //
async function dispatch(msg) {
  const method = msg.method;
  const id = msg.id;
  const isNotification = !("id" in msg);

  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: Object.values(TOOLS).map((t) => t.schema) } };
  }
  if (method === "tools/call") {
    const params = msg.params || {};
    const tool = TOOLS[params.name];
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    try {
      const text = await tool.handler(params.arguments || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
    } catch (e) {
      const text = e instanceof GenError ? `Error: ${e.message}` : `Unexpected error: ${e.message}`;
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
    }
  }
  if (isNotification) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, mcp-protocol-version");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const expected = (process.env.MCP_AUTH_TOKEN || "").trim();
  if (!expected) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Server not configured: MCP_AUTH_TOKEN is unset." })); }
  let qToken = "";
  try { qToken = new URL(req.url, "http://localhost").searchParams.get("token") || ""; } catch {}
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${expected}` && qToken !== expected) {
    res.statusCode = 401; res.setHeader("WWW-Authenticate", "Bearer");
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }
  if (req.method === "GET") { res.statusCode = 405; return res.end(JSON.stringify({ error: "Method Not Allowed" })); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  const payload = await readBody(req);
  if (payload === null) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const m of messages) { const r = await dispatch(m); if (r !== null) responses.push(r); }
  if (responses.length === 0) { res.statusCode = 202; return res.end(); }

  const out = JSON.stringify(Array.isArray(payload) ? responses : responses[0]);
  const accept = req.headers["accept"] || "";
  if (accept.includes("text/event-stream")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    return res.end(`event: message\ndata: ${out}\n\n`);
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(out);
};
