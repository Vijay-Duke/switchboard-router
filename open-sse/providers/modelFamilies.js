// Dependency-free model-family predicates shared by translators and executors.

// Gemini 4 (Argon) drops sampling params and requires functionResponse-last merged user turns.
export function isGemini4Model(model) {
  return /(?:^|\/)gemini-4(?:$|[-.])/i.test(String(model || ""));
}
