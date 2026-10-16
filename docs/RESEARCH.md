# Research and prior art

Reviewed 16 October 2026 using primary papers and official protocol documentation. Forge is an architectural synthesis and product hypothesis. This review does not establish research novelty, exhaustive market differentiation, or production reliability.

| Source | Design lesson for Forge | Evidence boundary |
| --- | --- | --- |
| [Runtime-Independent Persistent Agents, September 2026, v2](https://arxiv.org/abs/2609.00546) | Preserve durable work outside replaceable runtime bindings; transfer continuation authority deliberately. | The paper's migration evidence is bounded. It does not establish arbitrary session migration, behavioral equivalence, or general exactly-once external effects. |
| [Portable Agent Memory, May 2026](https://arxiv.org/abs/2605.11032) | Evaluate a versioned portable memory format, provenance, and selective disclosure before inventing another transport. | A research protocol and reference implementation need compatibility and security evaluation before adoption. Tamper evidence does not make recalled content true. |
| [AgentRM, March 2026](https://arxiv.org/abs/2603.13110) | Treat concurrency, abandoned resources, provider limits, and context growth as one operational problem. | The paper explicitly uses simulated workloads. Its performance numbers are not expected Forge improvements or laptop benchmarks. |
| [AIOS, COLM 2025](https://arxiv.org/abs/2403.16971) | Separate shared resource services from individual agent applications. | Framework-level research does not demonstrate control over every proprietary native harness or desktop application. |
| [MemGPT, 2023/2024](https://arxiv.org/abs/2310.08560) | Use bounded active context with retrieval from durable tiers. | Context management does not solve authority, process ownership, or billing reconciliation. |
| [LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813) | Evaluate temporal recall, corrections, cross-session reasoning, extraction, and abstention. | Benchmark performance is not a guarantee about an individual user's private memories or work outcomes. |
| [Dominant Resource Fairness, NSDI 2011](https://www.usenix.org/conference/nsdi11/dominant-resource-fairness-fair-allocation-multiple-resource-types) | Allocate across different resource bottlenecks, with explicit fairness assumptions. | Laptop workloads have uncertain demands, interactive headroom needs, and weak native isolation. Classical guarantees do not transfer automatically. |
| [AgenticOS, June 2026](https://arxiv.org/abs/2606.21129) | Keep task authorization and side-effect enforcement outside the reasoning model. | A system architecture is not a proof that a hook or MCP connection confines an unrestricted native process. |

## What we should actually contribute

The useful contribution to test is a coherent, lightweight implementation that connects durable agent and task continuity, replaceable Hermes/OpenClaw-style runtimes, heterogeneous native harnesses, ownership-based resource control, and attributable cost. These mechanisms have substantial prior art individually and in adjacent combinations.

An [initial product-level reuse audit](REUSE_AUDIT.md) now identifies substantial overlap with existing tools. Practical integration and whole-product fit remain untested. The architecture does not establish that its proposed core functions are absent elsewhere. Before implementation, evaluate candidates, adopt or extend what fits, and build only a verified remaining gap. If an existing product meets the full need, use it rather than duplicate it.

The product should make its strongest claim through a reproducible demonstration: continue meaningful artifact-producing work across two different harnesses, preserve the task record and accounting, reject stale authority, and keep the host responsive under a measured workload. Publish the unsuccessful scenarios too.

The memory format and adapter contract should be open. Private installed state should stay with the user. Reuse compatible upstream protocols and implementations only after checking their license, threat model, and conformance evidence.

## Evaluation plan

- Use LongMemEval-style abilities and project-specific evidence questions, including changed preferences, stale facts, and deliberate unanswerable questions.
- Compare same-harness resumes with cross-harness continuations on the same artifact tasks. Separate model, harness, and host changes where possible.
- Inject faults before dispatch, during tool execution, after an external effect but before its receipt, during approval, and during successor activation.
- Measure core overhead, whole-stack overhead, peak memory pressure, swap growth, interactive responsiveness, lost work, recovery correctness, and cost per accepted outcome.
- Compare simple admission policies with more elaborate scheduling using real traces. Do not add complexity merely because a paper contains it.
- Verify dollar reports against available billing records and distinguish estimates, partial coverage, and unallocated charges.

Official integration sources and their caveats are maintained in [ADAPTERS.md](ADAPTERS.md). Documentation is evidence of an upstream surface, not an implemented Forge capability.

For optional trace interoperability, use the maintained [OpenTelemetry GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai) and pin a supported version. The former website sections redirect readers to this separate specification repository. Telemetry naming does not establish invoice accuracy.
