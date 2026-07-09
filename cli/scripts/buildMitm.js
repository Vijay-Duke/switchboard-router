const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { execSync } = require("child_process");

// ── Build config ─────────────────────────────────────────
const BUILD_CONFIG = {
  bundle: true,
  minify: true,
  cleanPlainFiles: true,
};
// ─────────────────────────────────────────────────────────

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const cliMitmDir = path.join(cliDir, "app", "src", "mitm");
// Bundle everything — no externals. This keeps MITM runtime self-contained so
// it can be copied to DATA_DIR/runtime/ and spawned from there (escapes
// node_modules file locks that block `npm i -g switchboard-router@latest` on Windows).
const EXTERNALS = [];
const ENTRIES = ["server.js"];

/**
 * Resolve esbuild from cli/ or monorepo root. Auto-install into cli/ if missing
 * (devDependency — not always present after a root-only npm install).
 */
function loadEsbuild() {
  const tryPaths = [
    path.join(cliDir, "node_modules", "esbuild"),
    path.join(appDir, "node_modules", "esbuild"),
  ];
  // Default require resolution (cwd / NODE_PATH)
  try {
    return require("esbuild");
  } catch {
    /* try explicit paths */
  }
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch {
      /* next */
    }
  }
  // createRequire from this file for nested resolution
  try {
    const req = createRequire(path.join(cliDir, "package.json"));
    return req("esbuild");
  } catch {
    /* install */
  }

  console.log("📦 esbuild not found — installing cli devDependency…");
  try {
    execSync("npm install --include=dev esbuild@^0.25.12 --no-fund --no-audit", {
      cwd: cliDir,
      stdio: "inherit",
      env: { ...process.env, npm_config_audit: "false" },
    });
  } catch (e) {
    console.error(
      "❌ Could not install esbuild. From the monorepo run:\n" +
        "   cd cli && npm install\n" +
        "then re-run the CLI build."
    );
    throw e;
  }
  return require(path.join(cliDir, "node_modules", "esbuild"));
}

const esbuild = loadEsbuild();

async function buildEntry(entry) {
  const mitmSrc = path.join(appDir, "src", "mitm");
  const output = path.join(cliMitmDir, entry);

  if (!fs.existsSync(path.join(mitmSrc, entry))) {
    throw new Error(`MITM entry not found: ${path.join(mitmSrc, entry)}`);
  }
  fs.mkdirSync(cliMitmDir, { recursive: true });

  const buildPlugin = {
    name: "build-plugin",
    setup(build) {
      // Stub .git file scanned by esbuild
      build.onResolve({ filter: /\.git/ }, (args) => ({
        path: args.path,
        namespace: "git-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "git-stub" }, () => ({
        contents: "module.exports={}",
        loader: "js",
      }));
    },
  };

  const steps = [];

  if (BUILD_CONFIG.bundle) {
    await esbuild.build({
      entryPoints: [path.join(mitmSrc, entry)],
      bundle: true,
      minify: BUILD_CONFIG.minify,
      platform: "node",
      target: "node18",
      external: EXTERNALS,
      plugins: [buildPlugin],
      outfile: output,
    });
    steps.push("bundled");
    if (BUILD_CONFIG.minify) steps.push("minified");
  }

  console.log(`✅ ${steps.join(" + ")} → ${output}`);
}

async function run() {
  const flags = Object.entries(BUILD_CONFIG)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  console.log(`⚙️  Config: ${flags}`);

  for (const entry of ENTRIES) await buildEntry(entry);

  if (BUILD_CONFIG.cleanPlainFiles && fs.existsSync(cliMitmDir)) {
    const keep = new Set(ENTRIES);
    for (const name of fs.readdirSync(cliMitmDir)) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(cliMitmDir, name), { recursive: true, force: true });
      }
    }
    console.log("✅ Removed plain MITM files from CLI bundle");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
