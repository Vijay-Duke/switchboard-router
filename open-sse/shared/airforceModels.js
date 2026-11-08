// Airforce's public catalog mixes paid/chat/media entries. Only advertise its
// free chat tier; static registry models remain the offline fallback.
export function filterAirforceFreeModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter(m => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || ["chat", "text"].includes(m.media_type)))
    .map(m => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
