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
const SERVER_INFO = { name: "gemini-image", version: "0.2.0" };
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
  const ext = mime.includes("png") ? "png" : "jpg";
  const safe = (name || "image").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  const blob = await put(`gemini/${safe}.${ext}`, buffer, {
    access: "public",
    contentType: mime,
    addRandomSuffix: true, // unique URL per generation
  });
  return blob.url;
}

// ---- tools -------------------------------------------------------------- //
async function toolGenerateImage(args) {
  let prompt = args.prompt;
  if (!prompt || typeof prompt !== "string") throw new GenError("prompt (string) is required.");
  // Aspect ratio is a soft hint appended to the prompt (no server-side crop).
  if (args.aspect_ratio) {
    prompt += `\n\nComposition: ${args.aspect_ratio} aspect ratio, well-framed for that ratio.`;
  }
  const { b64, mime } = await geminiGenerate([{ text: prompt }], args.model);
  const buffer = Buffer.from(b64, "base64");
  const url = await uploadBlob(buffer, mime, args.name);
  return JSON.stringify(
    { url, mime, bytes: buffer.length, model: args.model || DEFAULT_MODEL, aspect_ratio: args.aspect_ratio || null },
    null, 2);
}

async function toolEditImage(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== "string") throw new GenError("prompt (string) is required.");
  const src = await fetchImageBytes(args.image_url);
  const parts = [
    { inline_data: { mime_type: src.mime, data: src.b64 } },
    { text: prompt },
  ];
  const { b64, mime } = await geminiGenerate(parts, args.model);
  const buffer = Buffer.from(b64, "base64");
  const url = await uploadBlob(buffer, mime, args.name || "edited");
  return JSON.stringify(
    { url, mime, bytes: buffer.length, model: args.model || DEFAULT_MODEL, source: args.image_url },
    null, 2);
}

async function toolListModels() {
  const models = await listGeminiModels();
  return JSON.stringify({ default: DEFAULT_MODEL, models }, null, 2);
}

const TOOLS = {
  generate_image: {
    handler: toolGenerateImage,
    schema: {
      name: "generate_image",
      description: "Generate an image with Google Gemini from a text prompt, store it in Vercel " +
        "Blob, and return a public image URL (usable directly as <img src> or an OG image). " +
        "For clean results, describe subject, style, lighting and say 'no text, no logos'.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate." },
          aspect_ratio: { type: "string", description: "Optional composition hint, e.g. '16:9', '1:1', '9:16'. Soft hint (no hard crop)." },
          name: { type: "string", description: "Optional base filename (a random suffix is added for uniqueness)." },
          model: { type: "string", description: "Optional Gemini model id (see list_models). Defaults to gemini-2.5-flash-image." },
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
      description: "Edit an existing image with Google Gemini. Provide the image (a public http(s) URL, " +
        "e.g. one returned by generate_image, or a data: URL) plus a prompt describing the change " +
        "(recolor, add/remove an element, change background, restyle). Returns a new public image URL.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "Source image to edit: an http(s) URL or a data: URL." },
          prompt: { type: "string", description: "What to change, e.g. 'make the background dark navy, keep the apple'." },
          name: { type: "string", description: "Optional base filename for the result (random suffix added)." },
          model: { type: "string", description: "Optional Gemini model id (see list_models). Defaults to gemini-2.5-flash-image." },
        },
        required: ["image_url", "prompt"],
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
