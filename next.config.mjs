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
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite"],
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
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
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
