# Diagram design plan

Treatment: utilitarian architecture figure. Subject: ongoing AI work across heterogeneous harnesses. Audience: users and contributors deciding whether Forge's system boundary makes sense. Job: show who remembers, who decides, who executes, and where resource and cost evidence returns.

## Tokens

- Paper: `#F3F7F7`.
- Ink: `#18343E`.
- Accent: `#12665F`.
- Panel: `#FFFFFF`.
- Secondary text: `#4E666E`.
- Structure: `#B6C9CE`.

Typography: Avenir Next or a system sans-serif for the diagram; a system monospace for protocol identifiers. Use normal readable labels, no vendor logos, emojis, badges, or decorative illustrations.

Layout: follow intent downward from user surfaces through a persistent control plane into replaceable runtimes, harnesses, and workers. The selected agent runtime, such as Hermes or OpenClaw, and durable memory visibly flank the deterministic core. A separate return path carries events, usage, receipts, and resource measurements.

Content skeleton: product and concept name; access surfaces; replaceable runtime, core services, and memory; durable journal; dynamic component registry; execution choices; workers and enforcement boundary; explicit proposal and portability limits.

The subject-specific decision is to expose both resource ownership and cost accounting in the same durable work boundary. A generic agents-and-tools diagram would miss the reason Forge exists.
