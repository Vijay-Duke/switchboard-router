let writers;
function loadWriters() {
  if (!writers) writers = require("../../../app/config-writers.cjs");
  return writers;
}
module.exports = {
  applyCliToolSettings: (tool, body) => loadWriters().invoke(tool, "POST", body),
  resetCliToolSettings: (tool) => loadWriters().invoke(tool, "DELETE"),
  getCliToolSettings: (tool) => loadWriters().invoke(tool, "GET"),
  listCodexProfiles: () => loadWriters().invoke("codex-profiles", "GET"),
  saveCodexProfile: (name, model) => loadWriters().invoke("codex-profiles", "POST", { name, model }),
};
