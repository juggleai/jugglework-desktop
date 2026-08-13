# jugglework-vision-mcp

Multi-provider image recognition MCP server. One command to install, works with Qwen-VL, OpenAI GPT-4o, Gemini, Claude, OpenRouter, Ollama, and any OpenAI-compatible endpoint.

Attach an image to a session and the model can call these tools for deep recognition: OCR text extraction, scene description, chart data interpretation.

## Quick start

```bash
npx jugglework-vision-mcp
```

No global install needed — `npx` downloads and runs it.

## Supported providers

| Provider | Default model | API key variable | Key required |
|---|---|---|---|
| **jugglework** | *(server-managed)* | `VISION_API_KEY` | ✅ |
| **dashscope** (Qwen-VL) | qwen-vl-max | `DASHSCOPE_API_KEY` | ✅ |
| **openai** | gpt-4o | `OPENAI_API_KEY` | ✅ |
| **gemini** (Google) | gemini-2.0-flash | `GEMINI_API_KEY` | ✅ |
| **anthropic** (Claude) | claude-3.5-sonnet | `ANTHROPIC_API_KEY` | ✅ |
| **openrouter** | google/gemini-2.0-flash-001 | `OPENROUTER_API_KEY` | ✅ |
| **ollama** (local) | llava | — | ❌ |
| **custom** | *(any)* | `VISION_API_KEY` | ❌ |

Every provider is reached through the same OpenAI-compatible `/chat/completions` endpoint, so the request and response shapes are identical.

## Tools

| Tool | Description |
|---|---|
| `recognize_image` | Recognize one image; returns OCR text plus a scene description |
| `recognize_images` | Recognize several images in one call |
| `vision_status` | Report the active provider configuration (the key is masked) |
| `vision_providers` | List every supported provider |

## Configuration

### JuggleWork gateway (server-managed keys)

The vendor key never reaches the desktop. An administrator configures the LLM provider once in the JuggleWork console; the desktop injects the gateway address and a short-lived gateway token, and this server talks to the gateway instead of the vendor.

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "VISION_PROVIDER": "jugglework",
        "VISION_BASE_URL": "https://your-server/jwork/api/gateway/v1/lpr_xxx",
        "VISION_MODEL": "kimi-k2.7-code",
        "VISION_API_KEY_ENV": "MCP_GATEWAY_KEY_LPR_XXX"
      }
    }
  }
}
```

Every value above is safe to commit — none of them is a credential. `VISION_API_KEY_ENV` names the variable that *holds* the gateway token; the token itself is written to the user's environment when they import the organization provider, and is read at runtime. JuggleWork picks the variable name for you when you bind a provider in the console.

### Qwen-VL / DashScope

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "VISION_PROVIDER": "dashscope",
        "DASHSCOPE_API_KEY": "sk-your-key",
        "VISION_MODEL": "qwen-vl-max"
      }
    }
  }
}
```

### OpenAI

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "VISION_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-xxx",
        "VISION_MODEL": "gpt-4o"
      }
    }
  }
}
```

### Ollama (local, free, no API key)

Pull a vision model first:

```bash
ollama pull llava
# or
ollama pull qwen2-vl
```

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "VISION_PROVIDER": "ollama",
        "VISION_MODEL": "llava"
      }
    }
  }
}
```

### Auto-detection

Set only a provider's API key variable and that provider is selected automatically:

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "GEMINI_API_KEY": "AIza-xxx"
      }
    }
  }
}
```

The config above resolves to the `gemini` provider.

### Custom OpenAI-compatible endpoint

```jsonc
{
  "mcp": {
    "vision": {
      "type": "local",
      "command": ["npx", "-y", "jugglework-vision-mcp"],
      "enabled": true,
      "environment": {
        "VISION_PROVIDER": "custom",
        "VISION_BASE_URL": "https://your-api.com/v1",
        "VISION_API_KEY": "your-key",
        "VISION_MODEL": "your-vision-model"
      }
    }
  }
}
```

## Claude Desktop

Edit `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["-y", "jugglework-vision-mcp"],
      "env": {
        "DASHSCOPE_API_KEY": "sk-your-key"
      }
    }
  }
}
```

## Cursor

Settings → MCP → Add MCP server:

- Command: `npx -y jugglework-vision-mcp`
- Env: `DASHSCOPE_API_KEY=sk-xxx`

## Environment variables

| Variable | Purpose |
|---|---|
| `VISION_PROVIDER` | Preset to use; omit to auto-detect |
| `VISION_BASE_URL` | Override the preset's base URL |
| `VISION_MODEL` | Override the preset's default model |
| `VISION_API_KEY` | Override the preset's API key |
| `VISION_API_KEY_ENV` | Name of the variable holding the key (indirection; never the key itself) |
| `VISION_MAX_IMAGE_BYTES` | Maximum raw image size, default 7 MB |

Precedence, highest first:

1. `VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` — override everything
2. `VISION_API_KEY_ENV` — read the key from the named variable
3. `VISION_PROVIDER` — take that preset's base URL and default model
4. Auto-detection — a resolvable `VISION_API_KEY_ENV` wins, then the first preset whose key variable is set

## Image limits

Supported extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`.

Images are rejected above 7 MB before encoding. Base64 inflates a payload by 4/3, and most endpoints cap request bodies around 10 MB — the check turns an opaque `413` into a clear message. Raise `VISION_MAX_IMAGE_BYTES` when your endpoint accepts more.

## Usage

Attach an image to the session, then ask:

- "Recognize this image"
- "Extract all the text from this screenshot"
- "What data is in this chart?"

The model calls `recognize_image` on its own.

## License

MIT
