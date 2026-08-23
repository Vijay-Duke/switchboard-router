const moduleDefault = {
  id: "selfhosted-tts",
  priority: 50,
  alias: "selfhosted-tts",
  display: {
    name: "Self-hosted TTS",
    icon: "record_voice_over",
    color: "#14B8A6",
    textIcon: "TT",
    website: "https://github.com/remsky/Kokoro-FastAPI",
  },
  category: "apikey",
  authType: "apikey",
  noAuth: true,
  models: [
    { id: "kokoro", name: "Kokoro (self-hosted)", params: ["voice", "response_format", "speed"], kind: "tts" },
  ],
  serviceKinds: ["tts"],
  ttsConfig: {
    identity: "openai-node",
    authType: "none",
    authHeader: "bearer",
    format: "openai",
    defaultModel: "kokoro",
  },
};

export default moduleDefault;
