# Quick Start

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/Vijay-Duke/switchboard-router/master/install.sh | bash
```

You can also install from the release package:

```bash
npm i -g https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz
```

## 2. Run

```bash
switchboard
```

Open the dashboard:

```text
http://localhost:20128/dashboard
```

The API base URL is:

```text
http://localhost:20128/v1
```

## 3. Add A Provider

Go to **Providers** and add an OAuth provider or an API key provider. The model list is built from the providers you have connected.

## 4. Create A Key

Go to **Endpoint & Keys** and create an API key. Copy it when it appears; the full key is shown only once.

## 5. Point A Client At Switchboard

```bash
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk-..."
```

Then choose a model from the dashboard or from:

```bash
curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

## 6. Optional: Create A Combo

Go to **Combos** if you want one model name that can route across several models.
