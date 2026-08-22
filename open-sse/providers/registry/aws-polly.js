const moduleDefault = {
  id: "aws-polly",
  alias: "polly",
  display: {
    name: "AWS Polly",
    icon: "record_voice_over",
    color: "#FF9900",
    textIcon: "PL",
    website: "https://aws.amazon.com/polly/",
    notice: {
      text: "Use AWS Secret Access Key as API key; set providerSpecificData.accessKeyId and optional region.",
      apiKeyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "tts"
  ],
  ttsConfig: {
    identity: "openai-node",
    baseUrl: "https://polly.{region}.amazonaws.com/v1/speech",
    authType: "apikey",
    authHeader: "aws-sigv4",
    format: "aws-polly",
    models: [
      {
        id: "standard",
        name: "Standard"
      },
      {
        identity: "openai-node",
        id: "neural",
        name: "Neural"
      },
      {
        identity: "openai-node",
        id: "long-form",
        name: "Long-form"
      },
      {
        identity: "openai-node",
        id: "generative",
        name: "Generative"
      }
    ]
  },
  hasProviderSpecificData: true
};

export default moduleDefault;
