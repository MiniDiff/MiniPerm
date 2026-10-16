# Parameter Analysis Rules (General)

> Goal: go beyond the surface question "what permission does this API require" and check the **implementation code** of each target API item by item, examining how different ways of passing arguments (whether an argument is passed, its value, its type, implicit environment parameters) affect the **actual value of the returned data** (precision, whether authorization is bypassed, whether it is equivalent to another API's data), and identify data-acquisition channels hidden behind "seemingly harmless parameters / argument-free invocations".

## Cyclic Collaboration with Shared-Source Grouping and Data-Flow Analysis (Important)

This rule forms a **convergence loop** together with `api-grouping.md` and `data-flow-analysis.md`; it is not a linear pass executed once:
- Determining mode three (a specific parameter value hits a runtime state) presupposes knowing "which runtime state this API depends on and who may populate it" — that precondition often has to be confirmed by state-coupling tracing in data-flow analysis. When the details cannot be located for the time being, proactively switch to data-flow analysis to dig deeper, and return to complete the determination afterward;
- Once mode three or its reverse-probe corollary is confirmed, it must trigger **re-execution of this rule** for other members of the same group, especially those with a geometric/numeric duality — this is the concrete execution point of the reminder "this paradigm should be consulted for re-review";
- If an API is found to be related to another API not previously placed in the same group, return to the grouping rules to add the group, then run this rule once more for the new member.

## Three Modes of Value Layering (Listed in Order of Discovery; All Three Must Be Checked)

### Mode One: Whether an Argument Is Passed Determines the Permission Branch

Checkpoints:
- Does this parameter have two entirely different code branches for "passed vs not passed"?
- If passed, is the data source "known data supplied by the developer" (consuming type, usually unchecked); if not passed, does it trigger an additional privacy check or state change (producing type, possibly the only entry point for obtaining new data)?
- Counter-intuitive signal: **the branch that does not pass the parameter is often the one that actually "produces/obtains" the data**, because the data in the branch with an argument is supplied by the developer and naturally needs no review; the branch without an argument requires the system to "find a value itself", and that value-finding process is where the privacy risk lies.

### Mode Two: Parameter Value/Type Determines the Data-Path Fork

Checkpoints:
- Within the parameter's value domain, do a "default value" and an "explicit value" correspond to different data-processing paths (e.g. different coordinate-system conversion, precision handling, or formatting functions)?
- Does explicitly declaring a value that "looks more standard / more common" instead trigger downgrade/encryption/fuzzing, while the default (omitted or another value) preserves more raw data? Do not assume "default = conservative / low value"; verify each case.
- Does some special value (a scene value, a privilege flag, an internal Symbol) switch the API entirely onto another data-source branch that is not bound by the permission regime?

### Mode Three: A Specific Parameter Value Hits a Runtime State Populated by High-Value Data (Key Point; Most Easily Overlooked)

Applies to: APIs that **depend on some mutable runtime state** (viewport center, last invocation result, cached value, selected item, map center, etc.) as a computation input — especially APIs that look like "mere geometric computation / pure rendering / utility functions".

Determination steps:
1. Does the API depend on some runtime state as input or as a conversion baseline?
2. Could that state be populated by **real data from another high-value API** (real location, user identity, account balance, etc.)? First find in the code "who writes this state field".
3. Does there exist a set of **specific parameter values** making the API's output numerically equal to the state itself (i.e. "pass in the coordinate/index/identifier of the current state to trade for the state")?
4. If such a parameter value can be constructed, treat it as an **indirect equivalent-read channel** — even if the API itself has no permission-check branch at all, it should be flagged as high risk, because it is a bypass that reads high-value data "in parallel" and often triggers no prompt and no review.

> **Execution discipline (new)**: step 3 of mode three — **explicitly constructing** a specific parameter value and checking output equivalence — and the "**implicit** default-parameter/value branches" examined in modes one/two are two independent checks that must be **performed separately and cannot substitute for each other**. Having completed the check "does omitting this parameter trigger implicit acquisition of new data" (modes one/two) does not mean mode three is covered. The **sole criterion** for whether an API needs mode three is "does this API take parameters whose semantics could point at a known runtime state within the group" (coordinates, indices, identifiers, screen positions, etc.) — not whether the method name literally looks like "pure geometric conversion / pure utility". The literal impression of a method name is not grounds for skipping mode three. For every parameter satisfying the above, one must **actually construct the concrete test case "parameter value = current value of that known state"** (even if only as a paper derivation or pseudocode check, without actually running it) and write it into the corresponding row of the "mandatory self-check matrix" below; a missing row means the mode-three check is incomplete and the draft cannot be submitted.

### Corollary of Mode Three: Reverse-Probe / Oracle Channels (Applies Even Without a Direct Return Value)

Even if an API never directly "emits" the target datum (e.g. it returns only a boolean, a derived coordinate, or a comparison result), as long as its output depends **monotonically or affinely** on some hidden state, the API can be used repeatedly as a "comparator (oracle)":
- Construct known reference values (e.g. pixel coordinates of a known layout) and, through repeated invocations plus binary search / gradient approximation, make the guessed value converge on the true value of the hidden state;
- Such a channel is usually slower than the direct back-computation of mode three (it needs many invocations), but it is **equally unconstrained by the permission-decision logic of the API that owns the target state**, and its threat level should be treated as the same tier as mode three.

## Mandatory Self-Check: Parameter-Form × Data-Value Matrix (Operationalization of Modes One/Three; Must Be Executed)

Mode one above (the same API's data value differs sharply between invocations with and without an argument) and mode three (a specific parameter value is equivalent to another API's data) are essentially two facets of one class of problem: **the same underlying capability/state can be reached through multiple "invocation forms", and the data value across different forms — even across different APIs — may be unequal, or may happen to be exactly equal**. Merely "checking modes one/two/three item by item" tends to stop at "record what you see" and lacks systematicity. Therefore, for every API in a group (especially members of the same group that share state or a shared artifact), the following matrix **must** be built rather than conducting a free-form investigation:

**Step 1: List all "invocation forms" of each API**, covering at least:
- Not passing the parameter (taking the default branch);
- Passing the "common/recommended" value of the parameter (the documented example value);
- Passing a boundary/special value of the parameter (0, empty, **the known value of the current viewport/state**, a value with the same name as a field returned by another API) — **this item is mandatory and must not be omitted**: whenever the parameter could semantically point at a known runtime state within the group (coordinate/index/identifier/etc.), the concrete row "parameter value = current value of that known state" must actually be written into the matrix. It must not be treated as covered merely because the "parameter omitted" form (modes one/two) was already examined — the two are independent check items;
- The same invocation while implicit environment state differs (e.g. whether a prerequisite method has already been called, whether some switch is on).

**Step 2: Annotate the data-value tier of each invocation form** (tiering criteria may be customized per target domain, e.g. continuous trajectory > single high-precision value > fuzzy value > indirectly reverse-lookupable signal > user active disclosure > no data), producing an "API × invocation form → data-value tier" matrix.

**Step 3: Compare the matrix twice, looking for value discontinuities and value equivalences (the key action most easily missed)**:
1. **Horizontal comparison within one API**: does the data-value tier jump between different invocation forms of that API? If so, identify which parameter and which value triggers it (corresponding to modes one/two), and check whether the form that "looks more conservative / simpler" (e.g. omitting the parameter) is in fact the higher-value side — this is where intuition most easily misleads.
2. **Vertical comparison across APIs (within the group)**: look at the cells in the matrix that share the same data-value tier or equal values, and check whether they belong to different APIs. If so, a cross-API equivalence channel exists, and one must move to mode three / `api-composition-and-equivalence-channels.md` for deeper verification: confirm whether a shared state exists, whether preconditions are required, and whether the target API thereby bypasses the permission-decision logic of the other API.

**Trigger signals (any one means you must stop and analyze it separately; do not gloss over it)**:
- An API's "parameter omitted" invocation form has a higher data-value tier than its "parameter passed" form (direct signal of mode one);
- An API's data-value tier under some special value is exactly the same as that of another API in the group under any invocation form (direct signal of mode three);
- An API's return value or intermediate state happens to be the input-parameter field name of another API in the group, or semantically identical (direct signal of geometric/numeric duality; check whether the two are inverse operations of each other).

**Output format**: the matrix must be included as a standalone section in the final document, with columns: `API | invocation form | data-value tier | equivalent to another row? (yes/no; if yes, state which row) | trigger condition`. The matrix is not a draft of the analysis process; it is a **mandatory deliverable**, because the matrix form makes both "value discontinuities" and "cross-row equivalences" immediately visible, whereas narrative description easily omits them.

## Implicit (Non-User-Controllable) Parameters Also Fall Within Scope

The following factors must be treated as "hidden parameters" and brought into the analysis of modes two/three, even though they are not explicit arguments a developer can pass at invocation time:
- Scene values (launch source `scene`, referrer information, and other environment context)
- System current time / timestamp thresholds (which may trigger a permanent behavior change after some date)
- Device/system state (network type, system switches, connected devices)
- Instance state / global state left behind by prior invocations

## Analysis Procedure (Suggested Order)

1. List all parameters of the target API (including optional ones), annotating required/optional and value type/domain;
2. For each optional parameter, locate the "passed vs not passed" branch decision in the implementation code, and check one by one whether the two branches agree on data source and permission check (mode one);
3. For each parameter's value domain, check whether there is normalization logic under which default and explicit values map to different processing paths (mode two);
4. Check whether implicit environment parameters have analogous branch decisions (the implicit version of modes two/three);
5. For all auxiliary APIs that look "purely geometric / purely rendering / purely query", specifically check whether a runtime-state dependency exists (mode three); if so, trace back to the writer of that state and judge whether it could be populated by high-value data;
6. For APIs confirmed to have a runtime-state dependency but for which an equivalent parameter value cannot be constructed directly, evaluate whether a reverse-probe/oracle channel can be constructed;
7. **Build the "mandatory self-check: parameter-form × data-value matrix"** (previous section), systematically checking value discontinuities and cross-API equivalence for every API in the group; do not rely only on the free-form checks of steps 2-6;
8. Organize all findings by "whether the data value changes qualitatively" into a highlighted finding table (columns: API / influencing factor / core finding / flag level), marking severity with ★/★★/★★★, for later inclusion in the document.

## Output Requirements

The artifact should contain:
- A core findings overview table (API, influencing factor, core finding, flag level);
- The **parameter-form × data-value matrix** (previous section; mandatory, not omissible);
- A standalone subsection for each finding of ★★ and above: code evidence (with line-number references) + trigger condition + before/after data-value comparison + whether it bypasses the permission-decision logic of the target API or a related API;
- A conclusions summary ordered from highest to lowest flag level, stating which analysis paradigm each class of finding corresponds to (mode one/two/three/corollary), so that other analysts can reuse the paradigm rather than merely remember the conclusion.
