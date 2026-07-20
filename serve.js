#!/usr/bin/env bun
// Static file server for local development. Run with:  bun serve.js
// Serves this folder over HTTP so ES modules and the module Web Worker load
// (browsers refuse both from file://). Override the port with PORT=3000.
import { resolve, join, relative, isAbsolute } from "node:path";

const ROOT = import.meta.dir;
const port = Number(process.env.PORT) || 8000;

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    // Decode %20 etc., drop the leading slash, default "/" to index.html.
    let rel = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";

    // Resolve against ROOT and reject anything that escapes it (path traversal).
    const path = resolve(ROOT, rel);
    const within = relative(ROOT, path);
    if (within.startsWith("..") || isAbsolute(within)) {
      return new Response("Forbidden", { status: 403 });
    }

    let file = Bun.file(path);
    // Directory requests -> that directory's index.html.
    if (rel.endsWith("/") || !(await file.exists())) {
      const indexFile = Bun.file(join(path, "index.html"));
      if (await indexFile.exists()) file = indexFile;
    }

    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    // Bun infers Content-Type from the extension (text/javascript for .js, etc.).
    return new Response(file, {
      headers: { "Cache-Control": "no-cache" },
    });
  },
});

console.log(`Serving ${ROOT}\n  → http://localhost:${server.port}/`);
