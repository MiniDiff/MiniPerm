# Convergence Loop Rules (Steps 3-6)

> Corresponds to Steps 3-6 of `SKILL.md`: shared-source grouping / three-layer permission annotation / parameter-sensitivity analysis / data-flow and state-coupling analysis. The four sub-steps are mutually prerequisite and must be advanced repeatedly as a loop; Step 7 may be entered only after convergence.

## 1. Why the Loop Is Necessary

- The initial grouping of Step 3 can only rest on shared artifacts visible at a glance during the surface-level review of Step 2 (e.g. same-named entries in a mapping table). Genuinely hidden shared state fields are often located only during parameter analysis (3c, mode three) or data-flow tracing (3d).
- Conversely, the determination of 3c mode three requires knowing which runtime state an API depends on and who may populate that state — which is precisely the output of 3d.
- A new finding at any sub-step can render earlier grouping or annotation incomplete or stale.

## 2. The Four Sub-Steps and Their Rules

| Sub-step | What it does | Rules file |
|---|---|---|
| 3a Shared-source grouping | Group APIs into shared-source groups by three kinds of shared artifact (A1 data object / A2 underlying resource / A3 event channel) × two kinds of relation (B1 dependency / B2 coordination), producing a five-tuple | `api-grouping.md` |
| 3b Permission annotation | Annotate known APIs with three permission layers (code / platform / user, including the link-layer `osGate`). Before the loop converges this is only a draft; when combination effects are later confirmed, one must return and revise it | `permission-layering-framework.md` |
| 3c Parameter-sensitivity analysis | Three modes; preferentially compare among members of the same group whether a parameter affects state that other members of the group depend on. When suspecting that an API depends on some runtime state but the writer/reader is unconfirmed, pause and transfer to 3d | `parameter-analysis.md` |
| 3d Data-flow and state-coupling analysis | Preferentially examine within a group the combination "writer has low permission, reader's permission decision depends on that state"; at the output endpoints annotate each member's capability nature (ACQUIRE / ACT-Hardware / ACT-Egress / pure control flow) and read-write role; for ACT-type members perform an "effect-scope non-additivity enumeration" in parallel | `data-flow-analysis.md` |

The grouping basis of 3a must be an artifact genuinely shared at the code level; name similarity or documentation-directory placement counts only as a candidate hint. If Steps 1/2 used the automated filtering tools, the `groupingHints` from `export` are only clues and must be re-verified before being written into the formal grouping table.

## 3. Signals That Trigger Another Round

Any one of these signals sends execution back to the corresponding sub-step; only the affected groups need re-examination, not a full rerun:

1. 3c or 3d discovers a shared state or shared function not yet recorded in the grouping table → return to 3a and add all APIs touching that state to a group (or create a new group);
2. 3a adds a member → redo 3c for the new member (is there a parameter value that degrades it into an equivalent read of a high-value state within the group?) and 3d (is it a new reader/writer of that state?);
3. 3c confirms on some member an "equivalent read under a specific parameter value" or a "reverse-probe channel" → trigger a redo of 3c for other members of the same group, especially those with a geometric/numeric duality (e.g. `<map-reader-API>` and `toScreenLocation`);
4. 3d confirms that some composed invocation produces a permission/value escalation → return and revise the 3b annotation of the APIs involved.

## 4. Stopping Conditions

- One complete pass of 3b→3c→3d over the current grouping table that yields no new group members, no new shared state, and no new equivalence finding is deemed converged.
- **Necessary precondition for convergence**: the grouping table must not contain any group still annotated as "to be investigated / insufficient evidence / pending / TODO". Before declaring convergence, re-check the grouping table once more; if such entries exist, first make an explicit decision — either continue investigating until a conclusion can be drawn, or record the downgrade rationale and inform the user (the rationale must state "compared with which already-investigated groups, and on what signal, this one is judged lower value"; vague grounds such as "time budget" are unacceptable). A "to be investigated" state must not be passively carried into the converged result merely because the loop's stopping condition does not cover it.
- **Three grouping self-checks that must be performed before convergence** (per `api-grouping.md`, "the shared artifact is not the location where sharing happens" and "one API may belong to multiple groups via different shared artifacts"):
  1. **Same-data-shape self-check** — any APIs that produce the same data shape (e.g. both produce `{latitude, longitude}`) must belong together to at least one group; if they are split apart, the grouping basis is mechanism rather than shared artifact and must be redone.
  2. **Mechanism ≠ shared artifact self-check** — inspect each `sharedArtifact` individually: it must be the entity that is shared, not the stretch of code in which the sharing occurs.
  3. **Multi-membership self-check** — for any API that appears in only one group, one must be able to explain why it does not touch other shared artifacts; inability to explain makes it suspicious.
- **Pre-execution requirement**: before creating groups, 3a must **actually open and read `api-grouping.md` in full**; do not infer the basis from memory of a previous run or the shape of an existing grouping table. The literal definition of the grouping basis is that file.

## 5. Output and Persistence

- **`_stageA_groups.json`** (mandatory; schema in `api-grouping.md`, "Grouping Output Format"): after convergence, write the final grouping table. For every member, `permVector` (3b), `capability` (3d capability nature), and `rw` (3d read-write role) must all be filled in — these three, together with the shared-source group itself, constitute the entire input handed to Step 8.
- **`_tmp_<domainAbbr>_step3-6_convergence.md`**: record the convergence process, retaining a brief trace of "how many rounds were run and what finding triggered each round". The conclusions of parameter-sensitivity analysis (3c) are also recorded here, for Step 9 to draw parameter values from.
- The completeness gate that must be passed before entering Step 8 is in `api-composition-and-equivalence-channels.md`, Section 9.
