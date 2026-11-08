// Bundle the existing file writers for `connect` and `show`. They run in this
// process, with no Next server or database and no duplicated config schemas.
const path = require("node:path");
const { build } = require("esbuild");
const root = path.resolve(__dirname, "../..");
async function buildConfigWriters(outfile = path.join(root, "cli/app/config-writers.cjs")) {
  return build({
    absWorkingDir: root,
    entryPoints: ["src/lib/cli/standaloneWriters.js"],
    outfile, platform: "node", target: "node20", format: "cjs", bundle: true,
    alias: { "@": path.join(root, "src"), "open-sse": path.join(root, "open-sse"), "jsonc-parser": path.join(root, "node_modules/jsonc-parser/lib/esm/main.js") },
    plugins: [{ name: "standalone-config-deps", setup(builder) {
      builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "response", namespace: "config-deps" }));
      builder.onResolve({ filter: /^@\/lib\/db\/index(?:\.js)?$/ }, () => ({ path: "catalog", namespace: "config-deps" }));
      builder.onLoad({ filter: /.*/, namespace: "config-deps" }, ({ path: name }) => ({ contents: name === "response"
        ? "export const NextResponse = Response;"
        : "export const getCombos = async () => []; export const getCustomModels = async () => []; export const getProviderNodes = async () => [];", loader: "js" }));
    } }],
  });
}
module.exports = { buildConfigWriters };
if (require.main === module) buildConfigWriters(process.argv[2]).catch(error => { console.error(error); process.exit(1); });
