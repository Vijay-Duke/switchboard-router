import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;
const distDir = process.env.NEXT_DIST_DIR || ".next";
// Workspace tracing can see build trees left by other commands. Exclude only
// stale dist directories: excluding the active one removes its server chunks
// and creates a server that boots but responds with empty 200s.
const staleDistExcludes = readdirSync(projectRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(".next") && entry.name !== distDir)
  .map((entry) => `./${entry.name}/**/*`);
const proxyClientMaxBodySize = process.env.SWITCHBOARD_PROXY_CLIENT_MAX_BODY_SIZE || "128mb";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  output: "standalone",
  serverExternalPackages: [
    "better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "node-machine-id", "bindings",
    "open-sse"
  ],
  // Next.js 16 blocks /_next/* cross-origin in dev by default. Without this,
  // opening the app via 127.0.0.1 or a LAN IP leaves React unhydrated — login
  // form does a dead native GET submit and appears to "do nothing".
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "*.local",
  ],
  turbopack: {
    root: tracingRoot
  },
  outputFileTracingRoot: tracingRoot,
  outputFileTracingExcludes: {
    "*": [
      "./gitbook/**/*",
      "./tests/**/*",
      "./cli/app/**/*",
      "./cli/.build-home/**/*",
      ...staleDistExcludes,
    ]
  },
  // Ship skills/*.md with standalone so /api/skills/[id] can serve them.
  // catalog.json is read via runtime fs (process.getBuiltinModule — invisible
  // to nft tracing), so include it explicitly for every route.
  outputFileTracingIncludes: {
    "*": ["./open-sse/providers/generated/catalog.json"],
    "/api/skills/[id]": ["./skills/**/*"],
    "/api/skills/*": ["./skills/**/*"],
  },
  images: {
    unoptimized: true
  },
  env: {},
  experimental: {
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
  },
  webpack: (config, { isServer, nextRuntime }) => {
    // Ignore Node-only modules in browser bundle  
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        zlib: false,
        http: false,
        https: false,
        net: false,
        tls: false,
        os: false,
        url: false,
        querystring: false,
        string_decoder: false,
        util: false,
        events: false,
        dns: false,
        dgram: false,
        cluster: false,
        child_process: false,
      };
    }
    
    // Server-side: Externalize Node built-ins and native modules
    // The instrumentation.js file imports Node-native modules that webpack can't bundle
    if (isServer) {
      const nodeExternals = [
        /^node:/,           // node: prefixed built-ins
        /^bun:/,            // bun: prefixed built-ins
        "fs", "path", "os", "net", "https", "http", "tls", "url",
        "querystring", "string_decoder", "util", "events", "dns", "dgram",
        "cluster", "child_process", "crypto", "stream", "zlib", "buffer",
        "timers", "tty", "vm", "assert", "constants", "console", "domain",
        "punycode", "process", "v8", "worker_threads", "perf_hooks", "async_hooks",
        "diagnostics_channel", "trace_events", "inspector", "module", "readline",
        "repl", "stream/web", "sys", "timers/promises",
        "wasi", "webcrypto", "http2"
      ];
      
      // Handle both function and array forms of config.externals
      if (typeof config.externals === 'function') {
        const originalExternals = config.externals;
        config.externals = (ctx, callback) => {
          const { request } = ctx;
          if (nodeExternals.some(ext => 
            typeof ext === 'string' ? request === ext : ext.test(request)
          )) {
            return callback(null, `node-commonjs ${request}`);
          }
          return originalExternals(ctx, callback);
        };
      } else {
        config.externals = config.externals || [];
        if (!Array.isArray(config.externals)) {
          config.externals = [config.externals];
        }
        // Use webpack's node externals pattern for Node built-ins
        config.externals.push(({ request }, callback) => {
          if (nodeExternals.some(ext => 
            typeof ext === 'string' ? request === ext : ext.test(request)
          )) {
            return callback(null, `node-commonjs ${request}`);
          }
          callback();
        });
      }
    }
    
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*"
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  }
};

export default nextConfig;
