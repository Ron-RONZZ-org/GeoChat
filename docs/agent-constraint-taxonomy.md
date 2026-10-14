# Agent Constraint Taxonomy

This document defines where GeoChat prompt constraints should live. The goal is to keep the main agent prompt small and stable while letting skills carry topic-specific drawing and explanation rules.

## Layers

| Layer | Scope | Examples | Location |
| --- | --- | --- | --- |
| Harness invariants | Always true for every run. These protect protocol correctness and state consistency. | Every tool call needs `reason`; first read the canvas; verify after canvas writes; call `setFinished` when done; do not write manual `canvas_state`. | `packages/app/src/agent-prompts.ts`, `packages/app/src/workflow-policy.ts`, `ToolLoopAgent.prepareStep` tests |
| GeoGebra safety invariants | Always true because they reflect runtime compatibility or common invalid commands. | GeoGebra 5 compatibility; no invented commands; declare free parameters before use; do not reassign `xAxis/yAxis/zAxis/xOyPlane`; prefer hiding helpers with `SetConditionToShowObject`; reject unsupported `SetOpacity`, `HideLabel`, `Maximum`, `Sphere(A,B,C,D)` with corrective feedback. | `agent-prompts.ts`, `functioncalls.ts`, `functioncall-schemas.ts`, `geogebra-style-policy.ts` |
| Workflow defaults | Usually true for the product experience, but not mathematical facts. | Visualization-first solving; deterministic recipes for parabola vertices/function intersections/ellipse foci-point; choice-card scenario separation; auxiliary-element review after construction. | `agent-prompts.ts`, construction recipes, card schemas |
| Runtime guardrails | Enforced by code when model output can damage stability or readability. | Max command batch size; dynamic text coordinate concat blocking; fixed-axis object blocking; unsupported-command rejection. Model output is never silently rewritten or dropped. | `geogebra-style-policy.ts`, AI SDK tool schema validation, targeted tests |
| Skill constraints | Only true for a subject, chapter, or task family. | Unit-circle angle order; prism textbook layering; 3D section label verification; circumsphere center strategy; conic focus-directrix language; probability event shading. | `backend/src/agent/builtin-skills.ts`, local/remote `SKILL.md` |
| Visual profiles | Presentation choices that should not be treated as proof. | Semantic color palette; 3D translucent face hierarchy; no gradients; dense textbook diagram versus exploratory dynamic diagram. | Skills and future visual profile data |
| Advanced drawing command semantics | Always true for skill-gated high-level drawing macros. These define argument evaluation, symbol handling, and composition boundaries. | Number args are backend literals; tagged `ggb_expr` args are GeoGebra expressions; `dynamic` preserves dependencies; `snapshot` uses `CopyFreeObject`; nested advanced commands are forbidden. | `docs/advanced-drawing-command-semantics.md`, `packages/app/src/advanced-drawing-tools.ts`, harness tests |

## Classification Rules

1. If violating the rule breaks tool protocol, runtime compatibility, or canvas state, keep it global.
2. If the rule is about a mathematical topic, textbook chapter, construction recipe, or visual convention, put it in a skill.
3. If the rule is about how a diagram should look but not whether the math is correct, put it in a visual profile or skill.
4. If the rule is a recovery policy after a failed command, keep only the general recovery shape global; put topic-specific repairs in skills.
5. If a rule mentions a concrete object pattern such as `Angle(XaxisRef, O, Pθ)` or `Intersect(plane, polyhedron)`, it is usually skill-specific unless it describes generic command syntax.

## Current Decisions

| Constraint | Decision | Reason |
| --- | --- | --- |
| `Angle(A, O, B)` point order matters | Global | This is generic GeoGebra syntax. |
| Unit-circle angle should use `Angle(XaxisRef, O, Pθ)` | Skill-specific | Only applies to polar/unit-circle diagrams. |
| Ordinary 2D diagrams should keep GeoGebra defaults | Global guidance + user approval | Prevents noisy autonomous styling. Enforced by prompt and, when the model styles without justification, a per-batch user approval card — never by silently stripping commands. |
| No silent GeoGebra command mutation | Runtime invariant | Model output is executed as written, rejected with feedback, or approved by the user. The old input refiner that stripped styles and repaired viewport was removed. |
| Unsupported commands (`SetOpacity`, `HideLabel`, `Maximum`) | Runtime rejection | These are not GeoGebra 5 commands; validation fails so the model retries with the correct command. |
| 1:1 viewport scale | Removed | The rule was arbitrary; viewport commands execute as written. |
| 2D semantic highlight may use color/filling | Runtime guardrail plus skill/profile guidance | Useful safety rule, but exact palette and roles are task-specific. |
| Colorblind-safe semantic palette | Skill/profile | Palette helps semantic diagrams, but should not be injected into every task. Based on Color Universal Design palette guidance from <https://jfly.uni-koeln.de/color/>. |
| Prism and section diagrams should be textbook-like | Skill-specific | Only applies to solid geometry and section skills. |
| Verify labels returned by multi-object commands | Global | The left-hand assignment may not be the object label. |
| Verify actual labels before styling `Intersect(plane, polyhedron)` | Skill-specific detail | It is the solid-section instance of the generic label rule. |
| Choice options should be separate scenarios | Workflow default | It is a product interaction pattern, not a theorem or skill. |

## Skill Selector Contract

The temporary SkillSelector is an assembler, not a solver.

It must:

1. List curriculum catalogs.
2. Search curriculum nodes for the problem.
3. Review the **full allowed skill catalog** (lightweight briefs: name, description, category, recipes, tags). A keyword/text pre-filter was removed because it dropped the right skill (for example, locus problems never surfaced `locus-envelope`).
4. Return at most 3 curriculum nodes, at most 5 `domainSkills` (subject mathematics), and at most 3 `craftSkills` (GeoGebra authoring/presentation). The backend routes each skill by `category` and enforces the per-group caps itself.
5. Load (read `SKILL.md`) only the skills it selects, on the backend, after the choice.

It must not:

1. Solve the problem.
2. Plan concrete GeoGebra command batches.
3. Inject the full skill catalog into the main agent prompt (only the compressed packet is injected).
4. Select a broad parent skill if a precise skill already covers all needed constraints.

If text retrieval is ever reintroduced (for a much larger remote catalog), it must be semantic, not lexical.
