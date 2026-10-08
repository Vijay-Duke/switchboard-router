import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ localFont: vi.fn((options) => ({ options })) }));
vi.mock("next/font/local", () => ({ default: mocks.localFont }));
const { sans, mono } = await import("../../src/app/fonts.js");
const require = createRequire(import.meta.url);
const localLoader = require("next/dist/compiled/@next/font/dist/local/loader").default;
const fontkitModule = require("next/dist/compiled/@next/font/dist/fontkit").default;
const parseFont = fontkitModule.default || fontkitModule;
const fontsRoot = fileURLToPath(new URL("../../src/app/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(fontsRoot, "fonts/sources.json"), "utf8"));

describe("bundled dashboard fonts", () => {
  it.each([
    ["IBM Plex Sans", sans, ["400", "500", "600", "700"], "--font-sans"],
    ["IBM Plex Mono", mono, ["400", "500", "600"], "--font-mono"],
  ])("loads every original %s weight with Next's real local loader", async (family, font, weights, variable) => {
    const emitted = [];
    const result = await localLoader({
      functionName: "",
      variableName: family,
      data: [font.options],
      resolve: async (relative) => path.resolve(fontsRoot, relative),
      loaderContext: { fs },
      emitFontFile: (buffer, ext) => {
        const parsed = parseFont(buffer);
        expect(parsed.familyName.startsWith(family)).toBe(true);
        expect(buffer.subarray(0, 4).toString()).toBe("wOF2");
        expect(ext).toBe("woff2");
        emitted.push(parsed["OS/2"].usWeightClass.toString());
        return "/_next/static/media/local-" + emitted.length + ".woff2";
      },
    });
    expect(emitted.sort()).toEqual(weights);
    expect(result.variable).toBe(variable);
    expect(result.css).toContain("font-display: swap");
    expect(result.css).not.toMatch(/https?:/);
    expect(result.css.match(/@font-face/g)).toHaveLength(weights.length);
  });

  it("ships the original OFL license and unchanged upstream font binaries", () => {
    const license = fs.readFileSync(path.resolve(fontsRoot, "../../public/fonts/IBM-Plex-LICENSE.txt"), "utf8");
    expect(license).toContain("SIL OPEN FONT LICENSE");
    expect(license).toContain("Copyright");
    const referenced = [...sans.options.src, ...mono.options.src].map((src) => path.basename(src.path));
    expect(manifest.assets.map((asset) => asset.file).sort()).toEqual(referenced.sort());
    for (const asset of manifest.assets) {
      const buffer = fs.readFileSync(path.join(fontsRoot, "fonts", asset.file));
      expect(crypto.createHash("sha256").update(buffer).digest("hex")).toBe(asset.sha256);
      expect(asset.source).toContain("/IBM/plex/" + manifest.commit + "/");
    }
  });
});
