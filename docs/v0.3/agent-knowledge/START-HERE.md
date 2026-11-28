# Install Perch MCP development knowledge

Use these files with a Perch MCP Connector that reports contractVersion 2. The ZIP contains these instructions, the exact tool schemas, and the Perchance domain skills.

1. Extract the ZIP. In a ChatGPT Project, add AGENT-INSTRUCTIONS.md to project instructions or upload it as a project file, then upload TOOL-REFERENCE.md and the relevant Markdown skill and reference files. In another MCP client, install the same text in its project context. Check what your client actually indexes.
2. Ask the operator which Target to use. Call workspace_status and confirm the requested Workspace and Binding. If it is ambiguous, clarify before execution.
3. Keep file reads targeted. Batch **only statically validated, compatible actions on the same Target** to amortize the durable Gateway lifecycle. Never batch Save/POST, separate Targets, uncertain replay or an action requiring unsupported intermediate evidence. Use preview tools where available, and request a separate Save only when authorized and requested.

A Connector can discover multiple assigned Workspaces. Chats using the same Connector share its authority. For independent authority, use separate Connectors.

If the live tool catalog differs from the bundled contract, use the runtime schema for discovery only and ask for a compatible knowledge package before taking effects.
