const moduleDefault = {
  id: "selfhosted-stt",
  priority: 50,
  alias: "selfhosted-stt",
  display: {
    name: "Self-hosted STT",
    icon: "mic",
    color: "#14B8A6",
    textIcon: "ST",
    website: "https://github.com/ggml-org/whisper.cpp",
  },
  category: "apikey",
  authType: "apikey",
  noAuth: true,
  models: [
    { id: "whisper-1", name: "Whisper (self-hosted)", params: ["language", "response_format", "temperature", "prompt"], kind: "stt" },
  ],
  serviceKinds: ["stt"],
  sttConfig: {
    identity: "openai-node",
    authType: "none",
    authHeader: "bearer",
    format: "openai",
  },
};

export default moduleDefault;
