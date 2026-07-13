# Quick Start

## 1. Install And Run

```bash
curl -fsSL https://raw.githubusercontent.com/Vijay-Duke/switchboard-router/master/install.sh | bash
switchboard
```

Open `http://127.0.0.1:20128/dashboard` if the dashboard does not open automatically.

## 2. Connect A Provider

Open **Providers**, choose a provider, and follow its OAuth or API-key flow. Use the connection test before moving on. The available model catalog is built from your active connections.

## 3. Create A Gateway Key

Open **Endpoint & keys** and create an API key. The complete generated key is shown only once, so copy it before closing the dialog.

Examples in this guide use `sk_switchboard` as a placeholder. Replace it with the generated key.

## 4. Configure A Client

The easiest path is **CLI tools**, which generates settings for supported clients using your actual endpoint, key, and selected models.

For a generic OpenAI-compatible client:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20128/v1"
export OPENAI_API_KEY="sk_switchboard"
```

## 5. List Models

```bash
curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

Copy a model ID from this response or from the dashboard. Provider prefixes are part of the model ID.

## 6. Send A Request

```bash
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-provider/your-model",
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

## 7. Optional: Create A Combo

Open **Combos** when you want one stable model name backed by several models. Start with fallback; add round-robin, fusion, or Auto only when their routing behavior matches your use case.
