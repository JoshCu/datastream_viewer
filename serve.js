#!/usr/bin/env bun
// Static file server for local development. Run with:  bun serve.js
// Serves this folder over HTTP so ES modules and the module Web Worker load
// (browsers refuse both from file://). Override the port with PORT=3000.
//
// Live reload: files under ROOT are watched and open pages are told over a
// server-sent-events stream (/__reload) to reload — or, for a .css-only
// change, to swap their local stylesheets in place. Bun's own HMR isn't used
// because it runs index.html through the bundler, which doesn't handle
// `new Worker(new URL(...))` (see build.sh). Disable with RELOAD=0.
import { watch } from "node:fs";
import { resolve, join, relative, isAbsolute, extname } from "node:path";

const ROOT = import.meta.dir;
const port = Number(process.env.PORT) || 8000;
const liveReload = process.env.RELOAD !== "0";

const RELOAD_PATH = "/__reload";
// Top-level paths whose changes never affect the page.
const IGNORED = /^(\.git|\.claude|dist|node_modules|wasm[\\/]mc_route[\\/]target)([\\/]|$)/;

// Injected into every served HTML page.
const CLIENT = `<script>
(() => {
  const es = new EventSource(${JSON.stringify(RELOAD_PATH)});
  es.addEventListener("css", () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      if (url.origin !== location.origin) continue;
      url.searchParams.set("t", Date.now());
      link.href = url.href;
    }
  });
  es.addEventListener("reload", () => location.reload());
})();
</script>`;

const clients = new Set();
const encoder = new TextEncoder();

function broadcast(event) {
  const chunk = encoder.encode(`event: ${event}\ndata: \n\n`);
  for (const controller of clients) {
    try {
      controller.enqueue(chunk);
    } catch {
      clients.delete(controller);
    }
  }
}

function reloadStream() {
  let self;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      clients.add(controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      clients.delete(self);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

if (liveReload) {
  // Editors fire several events per save, so coalesce them; a batch of only
  // .css files hot-swaps stylesheets, anything else reloads the page.
  let pending = new Set();
  let timer = null;
  watch(ROOT, { recursive: true }, (_event, filename) => {
    if (!filename || IGNORED.test(filename)) return;
    pending.add(filename);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending = new Set();
      const cssOnly = files.every((f) => extname(f) === ".css");
      console.log(`${cssOnly ? "css" : "reload"}: ${files.join(", ")}`);
      broadcast(cssOnly ? "css" : "reload");
    }, 50);
  });
}

const server = Bun.serve({
  port,
  // The reload stream sits idle between saves; don't let Bun time it out.
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (liveReload && pathname === RELOAD_PATH) return reloadStream();

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

    if (liveReload && file.name.endsWith(".html")) {
      const html = await file.text();
      const i = html.lastIndexOf("</body>");
      const body = i < 0 ? html + CLIENT : html.slice(0, i) + CLIENT + html.slice(i);
      return new Response(body, {
        headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    // Bun infers Content-Type from the extension (text/javascript for .js, etc.).
    return new Response(file, {
      headers: { "Cache-Control": "no-cache" },
    });
  },
});

console.log(
  `Serving ${ROOT}\n  → http://localhost:${server.port}/` +
    (liveReload ? "\n  live reload on (RELOAD=0 to disable)" : ""),
);
