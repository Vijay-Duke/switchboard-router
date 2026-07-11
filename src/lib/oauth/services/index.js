/**
 * OAuth service classes still in use.
 *
 * Provider login runs server-side through src/lib/oauth/providers.js (driven by
 * the /api/oauth/[provider]/[action] route). The classes below are the ones
 * that add bespoke handling on top of that flow and are imported by real routes.
 *
 * The former claude/codex/gemini/qwen/iflow/antigravity/github/openai service
 * classes were an orphaned parallel implementation: never instantiated, they
 * imported a `../config/index.js` that does not exist (so they could not even
 * load), and posted to an `/api/cli/providers/*` endpoint that was never built.
 * Their logins are handled by providers.js, so they were removed rather than
 * resurrected.
 */

export { OAuthService } from "./oauth.js";
export { QoderService } from "./qoder.js";
export { KiroService } from "./kiro.js";
export { CursorService } from "./cursor.js";
export { KimchiService } from "./kimchi.js";
export { XaiService } from "./xai.js";
