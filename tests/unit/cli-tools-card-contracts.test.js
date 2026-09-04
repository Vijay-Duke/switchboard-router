// Source-contract regression tests for cli-tools card findings whose fix is a
// snippet/badge/wiring contract rather than pure logic (pattern: source-text
// assertions as used by pi-multi-model-ui). Each block names its finding ID.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const comp = (name) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../src/app/(dashboard)/dashboard/cli-tools/components/${name}.js`, import.meta.url)
    ),
    "utf8"
  );

describe("T55/T56 GeminiCliToolCard manual config", () => {
  const src = comp("GeminiCliToolCard");
  it("runHint matches the gemini binary the installer installs", () => {
    expect(src).toContain('runHint="After Apply: source ~/.gemini/.env && gemini"');
    expect(src).toMatch(/npm install -g @google\/gemini-cli/);
  });
  it("settings.json snippet tells manual followers to merge, not replace", () => {
    expect(src).toMatch(/merge these keys — keep your other settings/);
  });
});

describe("T57/T58 HermesToolCard", () => {
  const src = comp("HermesToolCard");
  it("local mode falls back to the sk_switchboard default key", () => {
    expect(src).toMatch(/\|\| \(!cloudEnabled \? "sk_switchboard" : null\)/);
    expect(src).toMatch(/!cloudEnabled \? "sk_switchboard" : "<API_KEY_FROM_DASHBOARD>"/);
  });
  it("uses named-regex flags, not bare /…/i URL matching", () => {
    expect(src).not.toMatch(/baseUrl\..*\/i[;)\s]/);
  });
});

describe("T60/T61 JcodeToolCard", () => {
  const src = comp("JcodeToolCard");
  it("manual snippet agrees with the route's --provider-profile flag", () => {
    expect(src).toContain("jcode --provider-profile switchboard");
    expect(src).not.toMatch(/--agent\s+switchboard/);
  });
  it("does not hardcode an agent/profile id", () => {
    expect(src).not.toMatch(/agents\.switchboard\b/);
  });
});

describe("T49 DeepSeekTuiToolCard badge", () => {
  const src = comp("DeepSeekTuiToolCard");
  it("uses matchKnownEndpoint so tunneled base URLs read as configured", () => {
    expect(src).toMatch(/matchKnownEndpoint\(openaiSection\.base_url, \{ tunnelPublicUrl, tailscaleUrl \}\)/);
  });
  it("labels its model input", () => {
    expect(src).toMatch(/aria-label="Default model"/);
  });
});


describe("T67/T69 MitmServerCard key field", () => {
  const src = comp("MitmServerCard");
  it("masks the gateway key input", () => {
    expect(src).toMatch(/type="password"/);
  });
  it("re-syncs the key selection while pristine when keys arrive late", () => {
    expect(src).toMatch(/apiKeyPristine && !selectedApiKey && apiKeys\?\.length > 0/);
  });
});

describe("T66 MitmLinkCard image", () => {
  it("hides the provider image on load error instead of showing a broken icon", () => {
    expect(comp("MitmLinkCard")).toMatch(/onError=\{\(e\) => \{ e\.target\.style\.display = "none"; \}\}/);
  });
});

describe("T65 KiloToolCard endpoint badge", () => {
  it("classifies foreign baseUrls as other via matchKnownEndpoint", () => {
    expect(comp("KiloToolCard")).toMatch(/matchKnownEndpoint\(status\.settings\?\.baseUrl, \{ tunnelPublicUrl, tailscaleUrl \}\) \? "configured" : "other"/);
  });
});

describe("T71/T72/T73 MitmToolCard mappings", () => {
  const src = comp("MitmToolCard");
  it("mapping updates go through the serialized save queue", () => {
    expect(src).toMatch(/const queueSaveMappings = \(mappings\) =>/);
    expect(src).toMatch(/queueSaveMappings\(setMappingValue\(alias, value\)\)/);
  });
  it("clearing a mapping updates state and schedules the save", () => {
    expect(src).toMatch(/queueSaveMappings\(updated\)/);
  });
  it("placeholder picks warn instead of silently mapping to nothing", () => {
    expect(src).toMatch(/is a placeholder — connect the provider first/);
  });
});

describe("T74 ModelCatalogInput", () => {
  it("renders a visible label with the model count", () => {
    const src = comp("ModelCatalogInput");
    expect(src).toMatch(/\{label\} \{models\.length > 0 \?/);
  });
});

describe("T75/T77 OpenAiCompatToolCard", () => {
  const src = comp("OpenAiCompatToolCard");
  it("seeds the endpoint select from the server-configured baseUrl", () => {
    expect(src).toMatch(/status\?\.settings\?\.baseUrl && !customBaseUrl/);
  });
  it("gates Apply in cloud mode when no key is available", () => {
    expect(src).toMatch(/cloudEnabled && !selectedApiKey\?\.trim\(\) && !\(apiKeys\?\.length > 0\)/);
  });
});

describe("T78/T79/T80 OpenClawToolCard", () => {
  const src = comp("OpenClawToolCard");
  it("local mode falls back to the sk_switchboard default key", () => {
    expect(src).toMatch(/\|\| \(!cloudEnabled \? "sk_switchboard" : null\)/);
  });
  it("vetoes removing a model still used by a visible agent", () => {
    expect(src).toMatch(/usedBy\.length > 0/);
  });
  it("only round-trips agents that actually render (agentDir set)", () => {
    expect(src).toMatch(/filter\(\(agent\) => agent\.agentDir\)/);
  });
});

describe("T83/T85 OpenCodeToolCard chips", () => {
  const src = comp("OpenCodeToolCard");
  it("chips are real buttons with aria-pressed/aria-label", () => {
    expect(src).toMatch(/aria-pressed=\{model === activeModel\}/);
    expect(src).toMatch(/aria-label=\{`Remove \$\{model\}`\}/);
  });
  it("failed model removal surfaces an error message", () => {
    expect(src).toMatch(/Failed to remove \$\{model\}/);
  });
});

describe("T86/T87/T88 PiToolCard manual config", () => {
  const src = comp("PiToolCard");
  it("tells manual followers to merge settings rather than replace", () => {
    expect(src).toMatch(/merge these keys — keep your other settings/);
  });
  it("ships models.json alongside the v18 models.yml", () => {
    expect(src).toMatch(/~\/\.pi\/agent\/models\.json/);
    expect(src).toMatch(/models\.yml/);
  });
});
