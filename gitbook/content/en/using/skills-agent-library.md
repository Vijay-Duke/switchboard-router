# Skills & Agent Library

Switchboard exposes two related tools with different responsibilities.

## Skills

The **Skills** page publishes agent-readable instructions for using Switchboard. You can open a readable page or copy the raw `/api/skills/<id>` URL into an agent prompt.

These are product skills served by the running Switchboard app. They are not media providers and they do not change a client’s local configuration by themselves.

## Agent Library

The **Agent library** keeps a Switchboard-owned collection of skills and MCP server definitions under:

```text
~/.switchboard/agent-library
```

It can project selected entries into Claude Code, Codex, OpenCode, Gemini CLI, and Cursor.

## Safe Sync

- Managed skills and MCP keys use the `sb-` namespace.
- **Dry-run** previews a sync without writing target configuration.
- **Apply sync** copies or links enabled entries into supported agents.
- **Doctor** reports invalid or conflicting library state.
- User-owned paths are protected by default; Switchboard skips entries it does not own instead of overwriting them.
- Copy mode is the safe default on Windows. Symlink mode makes library updates immediate but can require extra privileges.

Use global scope for user-level agent configuration or project scope when you want the projection limited to one repository.
