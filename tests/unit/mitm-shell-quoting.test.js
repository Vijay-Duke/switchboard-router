import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoPath = (p) => path.resolve(__dirname, "../..", p);
const source = fs.readFileSync(repoPath("src/mitm/manager.js"), "utf-8");

/**
 * Regression: stopServer() escaped `'` in SERVER_PATH and then interpolated the
 * result into a *double*-quoted `pkill -f "..."`. Inside double quotes `'` is
 * already inert while `"`, `$` and backticks are not — and the command is
 * handed to execWithPassword (sudo). Source-scanned rather than executed,
 * matching tests/unit/security-audit.test.js: importing this module spawns.
 */
describe("mitm/manager.js shell quoting", () => {
  it("quotes the pkill pattern with shellQuoteSingle, not a double-quoted string", () => {
    expect(source).not.toMatch(/pkill[^\n]*-f\s*"\$\{/);
    expect(source).toMatch(/pkill -SIGKILL -f \$\{quoted\}/);
    expect(source).toContain("const quoted = shellQuoteSingle(SERVER_PATH);");
  });

  it("no longer hand-rolls single-quote escaping outside shellQuoteSingle", () => {
    const handRolled = [...source.matchAll(/replace\(\/'\/g/g)];
    // Only the one inside shellQuoteSingle itself may remain.
    expect(handRolled.length).toBe(1);
    expect(source).toMatch(/function shellQuoteSingle[\s\S]{0,120}replace\(\/'\/g/);
  });

  it("only writes a sudo password to stdin when one exists", () => {
    expect(source).toContain("if (sudoPassword) serverProcess.stdin.write(");
    expect(source).not.toMatch(/^\s*serverProcess\.stdin\.write\(`\$\{sudoPassword\}/m);
  });

  it("does not inline the gateway key or router base into the sudo sh -c string (C5)", () => {
    expect(source).not.toContain("ROUTER_API_KEY=");
    expect(source).not.toContain("MITM_ROUTER_BASE=");
    // HOME stays inline (sudo resets it); secrets travel via spawn env.
    expect(source).toMatch(/HOME=\$\{shellQuoteSingle\(os\.homedir\(\)\)\}/);
  });

  it("passes the gateway key via spawn env under sudo -E (C5)", () => {
    expect(source).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*ROUTER_API_KEY:\s*apiKey,\s*MITM_ROUTER_BASE:\s*mitmRouterBase\s*\}/);
  });

  it("mixes the per-install cli-secret into the sudo-password key and keeps pre-secret ciphertext readable (C5)", () => {
    expect(source).toContain("cli-secret");
    expect(source).toMatch(/function deriveKey\(cliSecret = loadCliSecretComponent\(\)\)/);
    // Decrypt falls back to the legacy key and the loader re-seals under the current one.
    expect(source).toMatch(/decryptPasswordWithKey\(stored, deriveKey\(""\)\)/);
    expect(source).toMatch(/result\.legacy && _updateSettings/);
  });
});
