# Public work receipts

Choose Share receipt in a work record to review a public projection of that work. Copy Markdown or download Markdown/JSON. Forge does not upload, publish or message anyone.

The projection includes one canonical work record, an ordered sequence of built-in harness names, attempt/completion/original-closure counts, checkpoint and approval counts, reported token totals and USD estimates with partial-coverage disclosure. Custom provider names collapse to Custom harness. The sequence is limited to the last 32 harness changes and explicitly reports truncation.

The export excludes work titles, projects, goals, prompts, checkpoints' text, memory, account labels/identities, local paths, file content, native messages, timestamps, source descriptions, internal IDs and private credential references. It is an allowlist projection, separate from the existing user-selected context export and native Work Capsule.

The same overlap-aware usage summary is used by the workspace. Unknown prices remain unknown/incomplete; estimates remain separate from invoices. A delegated run is not counted as an original-process closure. Completed attempts do not certify that the desired outcome was accepted or that external effects settled.

Receipts are self-reported local records, not cryptographic or independent evidence of artifact correctness, complete native-state portability or provider charges. They can be edited after download. A receipt from the isolated demo always carries fictional-demo in JSON, a FICTIONAL DEMO notice in Markdown and a demo filename.

The read-only endpoint is GET /api/work/:id/public-receipt on the existing local/private authenticated surfaces. It validates the work and scopes every source row to that work in the selected workspace. It starts no native tool, reads no project file and creates no public URL.
