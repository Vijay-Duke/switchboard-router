# Token Saver

Token Saver reduces repeated tool output before it is sent back to a model. It is designed for agent sessions where large command results, file reads, or logs would otherwise be carried through many turns.

## How It Works

Switchboard’s RTK hooks inspect `tool_result` content and apply configured compression filters. The hooks are fail-open: if compression cannot process a result safely, the original content continues through instead of failing the request.

## Dashboard

Open **Token saver** to inspect its status and token diagnostics. The page reports Switchboard’s estimate of tokens handled or saved; it is not a provider billing statement.

## Headroom

Headroom is a separate optional proxy that can perform additional context compression and Claude/OpenAI shape conversion. It is not bundled into the Switchboard Docker image. When you run it separately, configure Switchboard with the Headroom service URL shown by that deployment.

## Troubleshooting

If a tool result looks unexpectedly shortened, disable Token Saver temporarily and repeat the request. Keep detailed request logging off unless needed for diagnosis because logs may contain prompt, response, and tool-result data.
