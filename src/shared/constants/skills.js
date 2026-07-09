// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Scope: intelligent chat/model routing (not multi-modal media).
// Raw fetch URL (agents):  /api/skills/<id>
// Human viewer:            /dashboard/skills/<id>

export const SKILLS = [
  {
    id: "switchboard",
    name: "Switchboard (Entry)",
    description:
      "Setup, model discovery, combos & Auto routing. Start here — one /v1 endpoint, multi-provider gateway.",
    endpoint: "/v1",
    icon: "hub",
    isEntry: true,
  },
  {
    id: "switchboard-chat",
    name: "Chat",
    description:
      "Chat / code-gen via OpenAI, Anthropic, or Responses formats — streaming, tools, combo as model.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
  },
];

/** Fetchable raw markdown path for agents (relative to origin). */
export function getSkillRawUrl(id) {
  return `/api/skills/${id}`;
}

/** In-app viewer path (human-readable). */
export function getSkillBlobUrl(id) {
  return `/dashboard/skills/${id}`;
}
