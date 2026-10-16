# Data-Flow Analysis Rules (General)

> Goal: rather than looking in isolation at "which fields an API returns", fully trace where the data **originates → what processing/caching/permission checks it passes through → where it flows**, identifying undocumented data sources, hidden state coupling, and the dependency between "control-flow APIs" and "data-flow APIs"; and, at the **output endpoint**, annotate each API's **capability nature** (ACQUIRE data acquisition / ACT-Hardware hardware control / ACT-Egress network egress / pure control flow), supplying upstream labels for Step 8's cross-category sweep, Step 9's validation-method selection, and Step 12's tiering description.

## Cyclic Collaboration with Shared-Source Grouping and Parameter Analysis (Important)

This rule forms a **convergence loop** with `api-grouping.md` and `parameter-analysis.md`; it is not a linear pass executed once:
- The output of step three, "cross-method / cross-invocation state-coupling detection" (the writers and readers of a state field), is exactly the precondition required by mode three of parameter analysis. When parameter analysis suspects that an API depends on some state but cannot locate the details, proactively switch to step three of this rule to dig deeper, then return to parameter analysis;
- Once a state-coupling link is confirmed, immediately check whether the grouping table already covers every method touching that state; if not, go back and add the grouping, then re-run this rule and parameter analysis for the newly included members;
- Convergence criterion: repeatedly execute "grouping update → permission annotation → parameter analysis → data-flow analysis" for the same group until a round produces no new group members and no new state-coupling findings; only then is that group deemed converged on this dimension.

## Step One: Classify Data Sources

For every API in the target functional domain, first determine the **true origin** of its data; do not substitute the API name or documentation description for code verification:

| Data-source type | Characteristics | Privacy implication |
|---|---|---|
| Device sensor / system measurement | Produced by real-time measurement via hardware or system APIs | Passive collection; the user can only "consent/refuse", not change the content |
| Active user input / selection on the spot | Produced by the user's active operation on an interactive UI | Active disclosure; content decided by the user and possibly untrue |
| Server-issued | Returned by a backend interface; the client only forwards/displays it | May have been desensitized/fuzzed server-side, or may be dynamically relaxed by the server (whitelist) |
| Internal cache / instance state field | Written by some earlier invocation, read directly by the current one | Prone to "cross-method / cross-invocation state coupling"; the writer must be investigated |
| Third-party / upstream source relay | Written by an external source via redirect parameters, referrer, and similar channels | The source party is itself bound by the same permission framework; this party is only the receiver |
| Developer-supplied (consuming type) | The parameter is itself the data; the API only displays/forwards it | Produces no new data; usually no permission check needed |

## Step Two: Path-Tracing Method

1. Starting from the API's invocation entry code, locate the permission-decision functions it depends on internally (e.g. a `scope` check function), formatting/normalization functions, cache variables, and event-bus objects;
2. Determine whether that function/variable is **shared by multiple APIs** — sharing means those APIs have a hidden equivalence in permission decision or data source (see `api-composition-and-equivalence-channels.md`);
3. Where event-subscription patterns appear (`on`/`off` in pairs), distinguish the "API that opens the data flow" (the real data source / permission subject) from the "API that merely serves as an event pipe" (usually no independent permission; permission is entirely inherited from the opener);
4. Where caching / rate-limiting logic appears (time-window reuse, invocation-frequency limits), bring it into the value assessment of "actual obtainable frequency", rather than treating it as the binary question "is there a cache".

## Step Three: Cross-Method / Cross-Invocation State-Coupling Detection (Key Point)

This is the class of risk most easily missed by "analyzing each API in isolation":

1. Check whether **instance state fields** or **module-level variables** exist within the target functional domain that are written by method A and read by method B;
2. If so, evaluate separately:
   - Method A's permission requirement when invoked alone (may be very low, even empty, because it returns no data itself);
   - Method B's permission requirement when invoked alone and A has never been invoked (may also be very low, because it reads only a meaningless default/historical state);
   - The permission requirement and data value of the **composed invocation** A → B when specific preconditions hold (this often jumps to equivalence with some high-permission API);
3. Whenever the value of the composed invocation is significantly higher than that of either method invoked alone, the two methods must be annotated in the document as one "composite" with a permission requirement, and the exact preconditions needed to trigger the composite effect must be stated (e.g. some switch/parameter/invocation order).

### 3.1 Mandatory Check: State-Field "Write Precondition × Post-Read Value" Matrix (Must Be Executed; Qualitative Description Alone Is Insufficient)

The fact that the same state field yields different data values under different read/write combinations is the risk point most easily reduced to "record it if you happen to find it". For every shared state field found in step 1, the following matrix must be built rather than described qualitatively in a sentence or two:

**List all writers and all readers of that state field** (searching within the same functional domain and among members already placed in the same shared-source group; see `api-grouping.md`), and lay out the cross matrix:

| Writer (including invocation form, e.g. "invoked without arguments") | Reader | Precondition at read time (e.g. whether some switch/state holds) | Data value after composition | Equivalent to some higher-permission API? |
|---|---|---|---|---|

**Three relations that must be checked when filling the matrix**:
1. **Does the "write mode" of the same state field have differentiated value**: when the same method is invoked with different parameters, does it correspond respectively to "writes no valid state" and "writes a state populated by high-value data"? If so, the two invocation forms must be split into two separate rows in the matrix, not merged into one vague row.
2. **Does the state field have "multiple readers with different read modes"**: besides the most direct read method, are there other methods that **indirectly** depend on the same state (e.g. accessing it via coordinate conversion / geometric computation / comparison logic), even though they themselves check no permission at all? For each newly found reader, open a separate row in the matrix and annotate whether its permission decision is independent of the primary reader.
3. **For indirect readers, do either of these hold: "a parameter value makes the output equal to the state itself" or "the output depends monotonically on the state and is reverse-probeable"**: for each newly found indirect reader of type 2, apply mode three of `parameter-analysis.md` and its corollary one by one to determine which case applies, and note it in the last column of the matrix.

**Trigger signals (any one means you must stop and develop a dedicated analysis)**:
- The same state field has ≥2 different write-triggering paths whose "final value sensitivity" differs (low-sensitivity default vs. possibly genuine high-value data);
- The same state field has ≥2 readers (not limited to the one first discovered), especially auxiliary APIs within the group classified as "pure geometric / pure rendering / pure query";
- Some reader and the primary reader operate on the same coordinate space / same data type, even if the code implementations are entirely independent.

**Output format**: this matrix is a standalone subsection of the data-flow analysis output and must not be omitted. Rows annotated "yes" in the "equivalent to some higher-permission API?" column must also be written into the "parameter form × data-value matrix" of the parameter analysis document (see `parameter-analysis.md`); the two matrices should corroborate and cross-reference each other on the same finding, and writing it into only one place is not allowed.

### 3.2 Composition-Value Enumeration: Do Not Wait to "Discover" Shared State, Actively "Look" (Operationalization of the Core Principle)

The matrix in 3.1 rests on a hidden premise: **that a shared state field is already known to exist**. But in real analysis, "whether two APIs that each look zero-value behave differently when placed together" is usually suspected first, and the shared state field is found afterward by actively trying invocation sequences — not by first seeing the state field and then thinking of the composition. Therefore a check independent of 3.1 must be added: **without relying on prior discovery of shared state, systematically enumerate invocation sequences among the group's APIs and test whether value non-additivity exists**.

**Core principle**: an API's data value cannot be determined only by analyzing that API in isolation. **Two APIs whose static permission judgment is both "low/none" may, when composed, have a value far higher than either invoked alone** — this "1+1>2" value escalation (value non-additivity) is itself a signal to be actively sought, not something to be passively verified after "happening" to find a shared state field during some later grouping or parameter analysis.

**Enumeration method (execute for every pair of APIs in the same group, or for cross-group API pairs that appear business-related)**:

1. Take any two APIs in the group (call them A and B) and first confirm their **isolated** data values (usually already done during permission annotation and single-API analysis; denote them `V(A)`, `V(B)`);
2. Enumerate the following invocation sequences and assess each one's data value (`V(seq)`):
   - `A()` immediately followed by `B()` (default / simplest parameters);
   - `B()` immediately followed by `A()` (reversed order, to test for directional dependence);
   - `A(no arguments)` then `B()`, and `A(with arguments)` then `B()` (testing separately whether A's invocation form affects B's output, covering the composite forms of modes one/three);
   - If A/B both have switch-type preconditions (some component property, whether some mode is on), enumerate the two orderings "invoke before the switch is on" and "invoke after the switch is on";
3. Determine **value non-additivity**: if any sequence yields `V(seq) > max(V(A), V(B))`, the composition is deemed to exhibit a "1+1>2" effect, even if `V(A)` and `V(B)` were each judged "no privacy value" in isolation;
4. Once non-additivity is determined, **work backwards** to locate the underlying mechanism that makes it hold (usually some shared state field or shared permission-decision branch), and move to the 3.1 matrix for systematic recording — 3.2 and 3.1 are opposite directions of each other: 3.1 is "given the state, derive composition value", 3.2 is "suspect composition value, work back to the shared state". Alternate between them until convergence (no further non-additive sequences are found in the same group).

**Enumeration priority (to avoid unbounded combinatorial explosion, focus on high-likelihood scenarios)**: prioritize the following API-pair shapes, which most readily produce composition effects:
- A "control-flow / setter-type" API (usually returns no data itself, e.g. `set*` / `enable*` / a method that only accepts parameters) paired with a "read / query-type" API (usually returns data but appears merely to read UI/internal state);
- Two APIs both judged "consuming / pure geometric / pure rendering" (because these are most easily misjudged as "no value" during isolated analysis and thereby skipped in composition testing);
- API pairs with a "set-get" correspondence in naming/semantics (e.g. `set*` / `get*`), even if the parameter structures are entirely different.

**Trigger signals (any one means this section's enumeration must be executed; not omissible)**:
- The group contains at least one "control-flow-type" API and at least one "read-type" API;
- During permission annotation, ≥2 APIs in the group were annotated "three-layer permission all empty/none" — **all-empty permission is precisely the signal that most warrants suspecting a composition effect**, because a review regime is inherently unable to catch "two individually compliant APIs composing into a non-compliant effect";
- Some API's documentation/code shows behavior depending on "whether this is the first invocation" or "whether a historical invocation record exists" (implying state persistence, even if the concrete field name has not yet been located).

**Output format**: the enumeration process and conclusions must be recorded as a standalone subsection containing at least: `API pair (A,B) | invocation sequences enumerated | data value of each sequence | value non-additivity present? | shared mechanism derived by backward inference (if located)`. If enumeration finds no non-additivity, record "checked, none found" so that later analysts do not repeat the work or mistake it for uncovered.

## Step Four: Output Endpoint Check (and Capability-Nature Annotation Based on It)

The same datum flowing to different endpoints carries different privacy implications, and the analysis must distinguish them explicitly:
- Returned to the caller's JS code (callback/Promise) — the most direct "read" path;
- Written to local storage / persisted — involves "residence duration" risk;
- Reported to the server — involves "transmission / trace-leaving" risk;
- Used only for current UI rendering, neither persisted nor reported — lowest risk, but one must still confirm that the code truly has no bypass reporting logic.

### 4.1 Capability-Nature Annotation (New; Reuses Existing Definitions, Invents No New Standard)

The endpoints above directly determine an API's **capability nature**. Values reuse the three definitions of "Axis Three: Capability Nature" in `unified-theory-equivalence-and-permission-flaws.md`, plus one value corresponding to Tier 6 "no data / pure control flow" of `data-value-framework.md`:

| Capability nature | Criterion (output / flow) | Corresponding endpoint here | Corresponding item in `data-value-framework.md` |
|---|---|---|---|
| **ACQUIRE** (data acquisition) | Substantive information is returned to the mini-program JS layer after invocation | Returned to caller JS; written to local storage (data persisted) | Line one, "data acquisition" — apply the six dimensions and six tiers |
| **ACT-Hardware** (hardware control) | The invocation produces an effect on physical hardware and returns no new data | **Acts on hardware / produces an external physical effect (endpoint class newly added; see note below)** | Line two, "hardware control / output" — use independent risk dimensions instead |
| **ACT-Egress** (network egress / output) | The invocation sends data to an external network destination (data leaves the device) | Reported to server / sent to external network | Line two, "hardware control / output" — use independent risk dimensions instead |
| **Pure control flow** (no data returned) | Only changes component or instance internal state / rendering; neither returns data nor produces an external effect | Used only for current UI rendering, not persisted, not reported | Tier 6, "no data / pure control flow" |

**Endpoint class newly added (completing capability-nature coverage)**: beyond the original four endpoint classes, add "**acts on hardware / produces an external physical effect but returns no data**" (corresponding to ACT-Hardware; e.g. vibration, NFC tag writing, HCE response). The original four could only map to ACQUIRE / ACT-Egress / pure control flow; without this class, ACT-Hardware has nothing to map to.

**Blind spot that must be watched (do not skip because of "no data")**: ACT-Hardware and pure-control-flow members have **no data flow at all** and appear in none of the three endpoints "returned to JS / local storage / reported to server", so they are easily mistaken for "no output, no analysis needed" and skipped wholesale. Any member whose code confirms it triggers an external hardware effect, or merely writes internal state, must likewise have its capability nature annotated and be included in subsequent enumeration; **the absence of returned data is not grounds for omitting it from the table**.

**Nature of the annotation (does not change which step holds decision authority)**: this is a **pre-annotation**, delivered with the data-flow inventory — for Step 8 to split the sweep into data and effect groups by capability nature (pattern D), for Step 9 to read and reuse directly when routing by capability nature (no need to re-decide), and for Step 12 to choose between the six-tier score and independent risk dimensions. **Final tiering remains with Step 12** (see `data-value-framework.md`, "Two Parallel Lines of Analysis"); this step does not replace Step 12's decision authority, nor does it affect inclusion/exclusion decisions in Steps 1/2.

### 4.2 Effect-Scope Non-Additivity Enumeration (For ACT-Type Members; Parallel to 3.2, Does Not Replace It)

The "value non-additivity" enumeration of 3.2 targets **data value** and does not apply to ACT-Hardware / ACT-Egress members (their data value is identically 0, so the enumeration detects no escalation). Therefore, for members annotated as ACT, an **effect-scope non-additivity** enumeration must be run in parallel — testing whether "the **external effect scope** achieved by two APIs in composition exceeds that of each invoked alone":

1. Take a pair of APIs (A, B) in the group, at least one annotated ACT-Hardware / ACT-Egress;
2. Enumerate the same invocation sequences as in 3.2 (`A()`→`B()`, `B()`→`A()`, different parameter forms, before/after a switch is on);
3. Compare the **observable effect characteristics** achieved by each sequence: the target and scope of the effect (e.g. the range of destination addresses one can send to, the tag sectors one can overwrite), the reversibility of the effect, and whether an audit trace is left (see `unified-theory-equivalence-and-permission-flaws.md`, §4.4, `EffectEquivDegree`);
4. If some sequence's effect scope is significantly greater than `max(effect(A), effect(B))`, judge that **effect non-additivity** exists, work backwards to its shared mechanism (shared permission-decision branch / shared precondition state / a path lacking a control that should have applied), and move to the 3.1 matrix for recording (for ACT types, the "data value after composition" column is rewritten as "effect scope after composition").

**Output format**: `API pair (A,B) | invocation sequences enumerated | effect scope of each sequence | effect non-additivity present? | shared mechanism derived by backward inference (if located)`. Where enumeration finds nothing, likewise record "checked, none found".

**Trigger signal**: the group contains an ACT-type member and another member (whether ACQUIRE or ACT) that can form a sequence with it — **ACT-type members should especially be paired for enumeration with strongly controlled reference APIs in the same functional domain** (e.g. `<udp-API>.send` and `<network-request-API>`: the former performs no domain validation, the latter is governed by a whitelist; when the two stand in an effect-substitutable relation, this constitutes a structural bypass of an effect that should have been controlled).

## Step Five: Compare Against Documentation

Data-flow analysis conclusions must be cross-checked against the literal documentation (see `doc-code-cross-validation.md`), focusing on:
- Whether the documented "return value" field list fully reflects the fields the code actually populates (is there post-hoc zeroing/downgrading that the documentation has not kept up with);
- Whether the documentation discloses mechanisms such as state coupling, cache reuse, and rate limiting that "take effect from the very first invocation".

## Output Requirements

The artifact should contain:
- A data-source classification table for all APIs in the functional domain;
- The **state-field "write precondition × post-read value" matrix** (step three, 3.1; mandatory, not omissible);
- The **value non-additivity enumeration record table** (step three, 3.2: `API pair | invocation sequences enumerated | data value of each sequence | non-additivity present? | shared mechanism derived by backward inference`; mandatory — even if nothing is found, record "checked, none found");
- A discovered state-coupling link diagram/table (method A → state field → method B, plus the preconditions that trigger the composite effect);
- A description of the endpoints where data flows in/out;
- The **capability-nature annotation table** (step four, 4.1: `API | capability nature | basis (output endpoint) | corresponding data-value line`; mandatory, delivered with the data-flow inventory for Steps 8/9/12 to read and reuse);
- The **effect-scope non-additivity enumeration record table** (step four, 4.2; applies to ACT-type members, delivered **in parallel** with the 3.2 data-value enumeration; even if nothing is found, record "checked, none found");
- Where "composed invocation value escalation" is found, annotate it simultaneously in the permission analysis document, the parameter analysis document, and the pattern C investigation results of `api-composition-and-equivalence-channels.md` — do not write it into only one place.
