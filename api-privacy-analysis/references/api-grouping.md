# API Grouping Rules (Shared-Source Grouping / Co-location Grouping; Portable Skill-Builtin Version)

> This file is the **portable abstract version** of the shared-source grouping rules and contains no concrete domain cases, for direct reuse when first landing in a new project/domain.
>
> Positioning: together with three-layer permission annotation, parameter analysis rules, and data-flow analysis rules it forms a **convergence loop** (rather than a linear pass executed once), explicitly organizing the shared-implementation relations discovered during code review into a grouping table. The role of grouping is to convert "compare against whom" from an open-ended search into **structured enumeration within a group coordinate system**, avoiding a situation where "cross-API association" is discovered only when an analyst happens to notice it.
>
> Corresponds to sub-step **3a** of the Steps 3-6 convergence loop; the loop mechanism is described in `convergence-loop.md`.

## Why This Step Is Needed: The Necessity of Three Progressive Layers

1. **Scale**: pairwise pairing of all APIs is on the order of n²/2; after grouping, enumeration is needed only within groups, compressing the candidate scale by roughly an order of magnitude.
2. **Composability (the more essential layer)**: by the definition of capability equivalence, if two paths point at the same capability goal, their identity must be carried by some **shared mechanism**; therefore APIs capable of achieving capability escalation through composition **necessarily share some product**, i.e. necessarily fall into the same group, while those sharing no product whatsoever cannot produce equivalent capability through composition. Grouping thus delimits the search space of composition — **only compositions within a group are worth enumerating; cross-group compositions need not be considered**.
3. **Mechanistic explanation**: what grouping records is the concretely shared artifact, which supplies the **mechanism** of "why they are equivalent" rather than merely a phenomenological description; that mechanism directly determines what to observe and perturb during validation.

Cross-API equivalence/coupling findings (state coupling, parameter-equivalent reads, reverse-probe channels) tend to concentrate among a small cluster of APIs that "share some underlying implementation". If each API is analyzed in isolation, such associations easily get scattered across different analysis batches and can only be found by chance, creating a risk of systematic omission. Performing grouping explicitly once turns "chance discovery" into "a mandatory check item".

## Grouping Answers Two Questions

Grouping answers two mutually orthogonal questions; neither may be missing:

1. **Why APIs are in the same group** — answered by the **shared-artifact category** (three kinds, below);
2. **How they are paired once grouped** — answered by the **relation type** (two kinds, below).

Together the two delimit a group: **if the relation type differs over the same shared artifact, they are separated into different groups**.

---

## Dimension One: Shared-Artifact Category (Answers "On What Basis to Group")

The grouping basis is **derived back from the definition of capability equivalence**, not enumerated from experience: if two APIs point at the same capability goal, their identity must be carried by some shared mechanism, and what is shared must be a concrete entity, called the **shared artifact**. Shared artifacts fall into three categories:

| ID | Category | Criterion | Typical artifact forms |
|---|---|---|---|
| **A1** | **Shared data object** | Produce or operate on the same piece of data | Shared state fields / instance properties / module-level variables in code; data produced by APIs (same data shape); shared cache / rate-limit variables; cases where input and output stand in a geometric or numeric duality (one party's output is exactly the other's input) |
| **A2** | **Shared underlying resource** | Manipulate the same hardware, system service, or software capability (software capability is filed here together with hardware and system services) | The same hardware adapter / sensor; the same system-service invocation; the same class of outward-facing capability (e.g. network egress) |
| **A3** | **Shared event channel** | Interact via the same subscription or callback link | The same event bus / subscription channel; the same callback registration link; the `onX`/`offX` naming family |

### The Dual Role of Category

A category is not merely a label; it simultaneously determines the **retrieval direction** and the **semantic position of pairing**:

| Category | Retrieval anchor (analysis side) | Semantic position of pairing (analysis side) | Collection target (validation side) |
|---|---|---|---|
| **A1** data object | Retrieve by return-value fields and state variables | Can be paired with its **writer** or **reader** (composition); can also be paired with **another producer of the same data** (substitution) | Collect its returned data, readable directly; decision is most straightforward |
| **A2** underlying resource | Retrieve by hardware and system-service invocations | Can be paired with the resource's **opener** and **result reader** (composition); can also be paired with **another path achieving the same capability** (substitution) | Must observe **observable consequences** (scope of effect, reversibility, audit trail) rather than return values — many capability-type APIs have no meaningful return data |
| **A3** event channel | Retrieve by event name, callback registration, and the `onX` naming family | Can be paired with the channel's **trigger** and **responder** (composition); can also be paired with **another trigger or another responder** (substitution — multiple triggers and responders may legitimately coexist on the same event, so the channel category also has a symmetric coordination relation) | Must explicitly set up callback registration and an asynchronous wait point, collecting the callback's parameters after it fires, and must **collect the output and authorization trace of the trigger side and the callback side separately** — data in a channel is not statically obtainable, and the permissions of the two sides must be observed separately; observing only one side leads to misjudgment |

If one uses only the umbrella term "shared artifact" without categorizing, the retrieval anchor, semantic axis, and collection target are all lost, and the analysis degrades into blind trial and error over candidates.

### One API May Belong to Multiple Groups via Different Shared Artifacts (Must Be Observed)

The unit of grouping is the **shared artifact**, not the API. Therefore:

- **An API that touches several different shared artifacts should appear in several groups**;
- **Do not merge different shared artifacts into one group for the sake of "each API lands in only one group"** — merging loses the semantic axis, and the enumeration space for later substitution/composition is consequently mismatched.

### Important: The Shared Artifact Is Not the Location Where Sharing Happens (Using "Where the Code Artifact Lands" as the Shared Artifact Is Forbidden)

- The **shared artifact** is **the entity that is shared** (some piece of data, some resource, some channel);
- whereas "both call the same native method", "both register in the same stretch of code", and "both belong to the same component" are merely the **location/mechanism where the sharing occurs**.

Substituting mechanism for entity scatters APIs that "produce the same data shape" along their respective invocation paths, and also wrongly clusters APIs that are "merely within the same component but have different data shapes" — both error directions occur.

### Completeness and Open-Set Design

The completeness of this classification is guaranteed by **ontological derivation**: if two APIs point at the same capability goal, what they share must be an entity; and the entities that can be shared by two APIs are none other than the three classes of data object, underlying resource, and event channel — either data both touch, or a capability/resource both manipulate, or a channel through which they interact. Apart from "object", "capability", and "channel", there is no fourth kind of shareable thing.

**It must be emphasized**: "all confirmed findings fall within one of the three classes" does not constitute evidence of completeness — the classification was after all induced from those very findings, so using it to prove itself is circular. The mechanism for addressing omission risk is **open-set design**: the three classes are not a closed list; if auxiliary analysis discovers a new type of shared artifact, it is admitted as a new shared-artifact category and triggers re-examination and re-convergence of existing grouping (adding a category must follow the confirmation-protection flow of Step 13 in `SKILL.md`).

### Important: Permission Is Not a Shared Artifact (Using Permission Identifiers as a Grouping Basis Is Forbidden)

- The **shared artifact** answers "by sharing what entity are they grouped", and that sharing entails the **possibility** of capability equivalence;
- **Permission** is a **derived attribute** the framework assigns to each path, and sharing the same permission identifier **does not entail data equivalence**.

**Counter-example (must be remembered)**: two APIs may be registered under the same permission identifier (e.g. both belonging to some location-class scope/jsapi group) while their outputs are respectively a wireless-environment identifier and latitude/longitude — entirely different data shapes. If grouped by permission identifier, these two APIs would be wrongly placed in one group, and the grouping would itself lose the premise that "sharing entails the possibility of equivalence".

**Permission plays three roles in this method, none of which is a grouping basis**:
1. An **annotation output** of the grouping stage (member-level `permVector`, delivered with the group);
2. A **same-domain retrieval clue** in the transformation stage (hinting "possibly relevant, worth checking");
3. A **comparison dimension** in the decision stage (comparing the permission gap when constructing scenarios).

Likewise, **API name similarity and documentation-directory placement** can serve only as **candidate hints** for prioritized checking; the final grouping basis must land on some concrete shared code artifact. Conversely, even if two APIs are documented in entirely different categories (belonging to different functional areas), as long as a shared artifact exists at the code level they should be recorded as standing in a "same-source" relation.

---

## Dimension Two: Relation Type (Answers "How to Pair Once Grouped")

The relation type describes the **form of relation among group members over that shared artifact**, principally of two kinds:

| ID | Type | Criterion | Example forms | Downstream use |
|---|---|---|---|---|
| **B1** | **Dependency** | One party's action result is consumed by the other; **a causal order exists** | write—read (one writes shared state, the other reads it out); trigger—listen (one triggers a UI/flow, the other receives data via callback); open—read (one opens a resource, the other reads the result) | **Composition**: construct as an invocation sequence, and a **degraded-control** variant must be added |
| **B2** | **Coordination** | The two parties independently produce or operate on the same target; **no causality between them** | equivalent output (both produce the same data shape); different implementation paths of the same capability | **Substitution**: the two sides are interchangeable or serve as controls for each other, executed independently during validation |

### Three Constraints

1. **Dependents compose; coordinators substitute** — this is the most direct guidance the relation type gives downstream; **coordination does not constitute composition** (composition requires role complementarity, i.e. dependency).
2. **The relation type characterizes only whether causality exists; it does not presuppose whether the two are equivalent** — equivalence is a **conclusion** decided by later paired experiments, and must not be presupposed at the grouping stage. Therefore the phenomenon "substitutable for one another after transformation" is **not listed separately as a third type**; it is judged later after parameter-sensitivity analysis (3c) fixes the values.
3. **A different relation type over the same shared artifact means a different group** — for example, over the same data object "map center", `{writer, reader}` is B1 dependency while `{standard interface, reader}` is B2 coordination; although both involve a data object, they belong to two groups.

---

## Cyclic Collaboration with Parameter Analysis and Data-Flow Analysis (Important)

This rule **cannot be executed only once**. Initial grouping can rest only on shared artifacts "visible at a glance" during code review, whereas more hidden shared state fields are often located concretely only when parameter analysis (mode three: a specific parameter value hits a runtime state) or data-flow analysis (tracing the writers/readers of a state field) is done in depth — the grouping table is almost inevitably incomplete in the early stages of analysis.

**Signals that trigger re-grouping** (on appearance, return and update the grouping table; only the affected groups need repair, not a full redo):
1. Parameter analysis or data-flow analysis discovers a shared state / shared function / shared variable not recorded in the current grouping table → add it to an existing group or create a new group;
2. The grouping table gains a member → a round of parameter analysis and data-flow analysis must be re-run for the new member;
3. Some member of a group is confirmed to have an "equivalent read under a specific parameter value" or a reverse-probe channel → parameter analysis must be re-run for other members of the same group, especially those standing in a geometric/numeric duality.

**Convergence determination**: one complete pass of "permission annotation → parameter analysis → data-flow analysis" over the current grouping table that yields no new group members, no new shared state, and no new equivalence finding is what counts as converged on this dimension. Before declaring convergence, additionally confirm: **no group remains annotated as "to be investigated / insufficient evidence / pending"** (see `convergence-loop.md`, Section 4).

## Grouping Basis: Err Toward Inclusiveness

What a group delimits is a **candidate space, not a conclusion** — sharing is only a **necessary, not sufficient**, condition of capability equivalence. Since the cost of wrongly including one group is merely redundant pairing enumeration, while the cost of omitting a group is **irreversible missed detection**, the grouping basis errs toward inclusiveness, leaving precision to later judgment and empirical testing.

**The same API may belong to multiple shared-source groups by sharing different things** (e.g. some read-type API belongs to an A1/B1 group by sharing a state field and also to an A1/B2 group by producing the same data shape) — grouping delimits a candidate space and is **not a mutually exclusive partition**; do not force each API into only one group.

---

## Grouping Output Format: The Five-Tuple

Each shared-source group is formalized as a **five-tuple**:

```
⟨id, API list, shared artifact, shared-artifact category, relation type⟩
```

| Field | Meaning |
|---|---|
| **ID** | The group's identifier (e.g. `G1`) |
| **API list** | The set of paths that share this artifact in this way |
| **Shared artifact** | The concrete artifact **instance** (e.g. "the center state field `<field name>` of some map component"), not the category name |
| **Shared-artifact category** | Which of the three classes this artifact belongs to (`A1`/`A2`/`A3`) |
| **Relation type** | The form of relation among group members over this artifact (`B1`/`B2`); **a different type means a different group** |

### Member-Level Annotations Delivered With the Group

The final output of grouping is not only the shared-source groups themselves but also three annotations per member (filled by 3b/3d), delivered downstream together with the groups:

| Annotation | Source | Downstream use |
|---|---|---|
| **Permission vector** `permVector` (code layer / platform layer / user layer, including the link-layer `osGate`) | 3b three-layer permission annotation (see `permission-layering-framework.md`) | A same-domain retrieval clue in the transformation stage; judging the permission gap in the scenario-construction stage |
| **Capability nature** `capability` | 3d data-flow analysis (see `data-flow-analysis.md` 4.1) | Decides whether the decision goes by **data comparison** or **effect comparison** |
| **Read-write role** `rw` (writer/reader/trigger/listener/opener, etc.) | 3d read-write inventory | Determines invocation order under B1 dependency (which is the writer, which the reader) |

**Note on the granularity of capability nature**: `data-flow-analysis.md` 4.1 annotates four values — `ACQUIRE` (data acquisition) / `ACT-Hardware` (hardware control) / `ACT-Egress` (network egress) / pure control flow. **Retain these four fine-grained values** when persisting; when deciding the decision-target type downstream, `ACQUIRE` goes to a **data target**, `ACT-*` uniformly goes to an **effect target**, and pure control flow does not by itself constitute a capability target (it serves only as an intermediate link in a sequence).

**Note**: the capability natures of members within one group are **often complementary** — the writer belongs to effect achievement while the reader belongs to data acquisition. Therefore capability nature must be **annotated item by item** and cannot be derived directly from the shared-artifact category.

### Mandatory Persistence

The grouping result is the input contract of all subsequent steps and **must be persisted as a structured intermediate file** `tmp/<domain>analysis-<YYYYMMDD>/_stageA_groups.json` (and, by convention, a readable `_tmp_<domainAbbr>_step3-6_convergence.md` recording the convergence process and the trigger signals of each round). Schema:

```json
{ "domain": "<functional domain name>", "generatedAt": "<YYYY-MM-DD>",
  "groups": [
    { "id": "G1",
      "members": ["<apiName1>", "<apiName2>"],
      "sharedArtifact": "<concrete artifact instance, including code location clues>",
      "category": "A1",            // A1 data object | A2 underlying resource | A3 event channel
      "relation": "B1",            // B1 dependency | B2 coordination
      "relationDetail": "write—read",
      "evidence": ["code:<file>:<startLine>-<endLine>"],
      "members_meta": {
        "<apiName1>": { "permVector": {"code":"-","platform":"-","user":"-","osGate":"-"},
                        "capability": "ACT-Hardware",
                        "rw": "writer" },
        "<apiName2>": { "permVector": {"code":"-","platform":"-","user":"-","osGate":"-"},
                        "capability": "ACQUIRE",
                        "rw": "reader" } } } ] }
```

Members of a group are preferentially compared with one another in later steps:
- The parameter analysis stage asks "does this parameter affect state that other members of the group depend on";
- The data-flow analysis stage asks "does this group contain a combination where the writer has low permission and the reader's permission decision depends on that state".

---

## Boundaries of Use (Avoiding Introducing New Problems)

### Boundary One: Grouping Cannot Replace Cross-Group / Cross-Category Retrieval

Shared-source groups are partitioned by **shared code artifacts**, whereas a cross-functional-domain substitution channel may share **data content** rather than a code artifact (two APIs in entirely different functional domains, with no shared artifact at all, yet able to reconstruct the same datum). Therefore, after shared-source grouping is complete, the transformation stage must still **additionally step outside the shared-source group boundary** for a round of investigation (see `api-composition-and-equivalence-channels.md`, pattern D); one must not stop cross-group retrieval merely because "grouping is done".

### Boundary Two: Do Not Assume Shared Preconditions Merely From "Identical Forwarding"

If a group contains members for which "no permission-judgment code can be found at the JS layer / pure native bridge forwarding" holds, it is **forbidden to assume, merely because "the forwarding method is the same (e.g. both use the same bridge function)", that they share the same precondition as other already-authenticated members of the group** — the unconditional-trigger rule of pattern A2 in `api-composition-and-equivalence-channels.md` must be validated before concluding.

**A real misjudgment case**: one analysis, relying only on "both APIs use the same kind of bridge forwarding", wrongly placed a zero-permission API that is in fact entirely independent of the authentication state into an already-authenticated group, judging it "no risk".

### Boundary Three: Grouping May Be Adjusted as Analysis Deepens

Grouping itself may be adjusted/merged/split as analysis deepens: if a later step discovers that an API originally placed in a different group in fact shares an unnoticed state, the grouping table should be updated promptly rather than rigidly adhering to the initial grouping.

---

## Relation to Existing Grouping Documents in the Project

If grouping-type documents already exist in the project, they should serve as a reference starting point, but every dimension in them must be re-examined against the above criteria:

| Original dimension type | Disposition |
|---|---|
| Dimensions leaning toward "data source / event mechanism / hardware resource" | Can be mapped to one of the three shared-artifact categories and reused directly as a grouping basis |
| Dimensions leaning toward "permission decision / permission identifier" | **May not serve as a grouping basis** (see "permission is not a shared artifact"); convert to member-level `permVector` annotation |
| Dimensions leaning toward "surface documentation features" (e.g. parameter structure, lifecycle description) | May serve only as a supplementary explanation column of the grouping table, not as a grouping basis on their own |

---

## Analysis Procedure (Insertion Point: After Code-Layer Implementation Review, as 3a of the Steps 3-6 Convergence Loop)

> Steps 1-5 and step 7 are all semantic judgments, executed uniformly per the "Shared-Source Grouping Judgment Prompt (3a Unified Template)" at the end of this file: `mode=build` is used in steps 1-5, `mode=audit` in step 7 for convergence determination.

1. Aggregate all shared artifacts discovered during code review — shared state fields, the **entities** pointed to by shared mapping-table entries (note: the entities, not the permission identifiers themselves), shared event buses, cache variables, hardware/system-service invocation points;
2. For each shared artifact, determine its **category** (A1/A2/A3) and list all APIs involved;
3. For members over the same artifact, determine the pairwise **relation type** (B1/B2) — **a different type means splitting into a different group**;
4. For API pairs whose input and output stand in a geometric/numeric duality, identify them separately and file them into the relevant A1 group;
5. Fill in member-level annotations (`permVector` / `capability` / `rw`), where `capability` and `rw` come from 3d and `permVector` from 3b;
6. Produce the grouping table in five-tuple form and **persist `_stageA_groups.json`**, serving as the retrieval inventory for later permission annotation, parameter analysis, and data-flow analysis, and as the candidate space for the transformation stage;
7. Once convergence determination (see "Cyclic Collaboration" above) passes, deliver to the transformation stage;
8. Besides within-group enumeration, the transformation stage still mandatorily performs cross-group / cross-category retrieval; the investigation scope must not be narrowed merely because grouping exists.

---

## Shared-Source Grouping Judgment Prompt (3a Unified Template)

> One template covers all 3a semantic judgments, with `mode` switching the purpose: **`build`** (creating and revising groups, procedure steps 1-5) / **`audit`** (convergence self-check, procedure step 7).
> The input organization follows Section 6 of `documentation-and-code-collection.md`: **matched keywords and code locations + verbatim hit content + other hint data**.

### How to Use

| mode | When to use | Input focus | Output focus |
|---|---|---|---|
| `build` | First-round group creation; or returning to patch after 3c/3d discovers new shared state / new members | Candidate artifact inventory + code context + current grouping table | `groups[]`: complete five-tuple + member-level annotations |
| `audit` | Convergence determination after one pass of 3b→3c→3d | The current complete grouping table + this round's 3b/3c/3d output | `audit{}`: three self-checks + pending disposition + `converged` |

**Prompt Template**

````text
[Task]
You are the shared-source grouper for mini-program API privacy analysis. Complete the determination as directed by mode, using only the material given below, and do not supplement field names, line numbers, or invocation relations from memory.

[Input]
mode：{{mode}}        # build | audit

Target functional domain：{{domain}}

Matched keywords and code locations this time (one of the three elements):
- Retrieval anchors / matched terms：{{matchedTerms}}      # shared state field names, mapping-table keys, event names, native method names, characteristic regexes
- Hit source：{{hitSource}}                # code review 3a aggregation / 3c parameter analysis / 3d data flow / pairing-check / extract-object-keys
- artifact code locations：{{artifactLocations}}   # file:startLine-endLine list

Verbatim hit content (the second of the three elements):
{{artifactContext}}
# For each artifact give: the code fragment, the enclosing function, which APIs touch it (write/read/trigger/listen/open), the return-value field or state field

Other hint data (the third of the three elements):
- Current grouping table (known groups and their five-tuples)：{{currentGroups}}
- Confirmed member-level annotations (permVector / capability / rw)：{{currentAnnotations}}
- Same-family / same-component API inventory：{{siblingApis}}
- The full registered set of the permission mapping table (scope / jsapi / triples)：{{registryKeys}}
- New findings of this round's 3b/3c/3d (required for audit)：{{roundFindings}}
- Judgment precedents from the previous round (to avoid self-contradiction)：{{precedents}}

Three categories of shared artifact：
- A1 shared data object：produce or operate on the same piece of data (shared state field / instance property / return data shape / shared cache / input-output geometric or numeric duality)
- A2 shared underlying resource：manipulate the same hardware, system service, or software capability (same adapter / sensor / system-service invocation / same class of outward-facing capability such as network egress)
- A3 shared event channel：interact via the same subscription or callback link (same event bus / callback registration link / onX-offX naming family)

Two kinds of relation type：
- B1 dependency：one party's action result is consumed by the other, with a causal order (write—read / trigger—listen / open—read) → downstream: composition
- B2 coordination：each independently produces or operates on the same target, with no causality between them (equivalent output / different implementation paths of the same capability) → downstream: substitution

[Criteria]
Hard constraints (self-check item by item; violating any one makes the output invalid):
1. The shared artifact must be the "entity" that is shared, not the location or mechanism where sharing occurs. Calling the same native method, registering in the same stretch of code, belonging to the same component, or using the same bridge function — these are only location/mechanism and may not serve as the shared artifact.
2. Permission identifiers (scope / jsapi / groupKey) may not serve as the shared artifact. Sharing the same permission does not entail data equivalence; permission serves only as the member-level permVector annotation.
3. API name similarity and documentation-directory placement may serve only as candidate hints; the final basis must land on a concrete artifact.
4. An API that touches several different shared artifacts should appear in several groups; do not merge different shared artifacts for the sake of "each API lands in only one group".
5. A different relation type over the same shared artifact means splitting into different groups; B2 coordination does not constitute composition (composition requires role complementarity, i.e. B1).
6. Member-level capability and rw must be annotated item by item and may not be derived from the shared-artifact category — the capability natures of members in the same group are often complementary (the writer belongs to effect achievement, the reader to data acquisition).
7. The grouping basis errs toward inclusiveness: a group delimits a candidate space, not a conclusion; omitting a group is irreversible, so doubtful cases are all included.
8. When material is insufficient, do not guess forcibly; set confidence=low and state in note what is missing.

[Output]
Output：strictly output a single JSON object with no additional text. Fill in groups when mode=build, and audit when mode=audit:

{
  "mode": "build | audit",
  "domain": "<functional domain>",
  "groups": [
    {
      "id": "G<sequence>",
      "sharedArtifact": "<concrete artifact instance, including code location clues; not a category name>",
      "category": "A1 | A2 | A3 | new:<new category name>",
      "relation": "B1 | B2",
      "relationDetail": "write—read | trigger—listen | open—read | equivalent output | different paths to the same capability",
      "members": ["<apiName>"],
      "members_meta": {
        "<apiName>": {
          "capability": "ACQUIRE | ACT-Hardware | ACT-Egress | pure control flow",
          "rw": "writer | reader | trigger | listener | opener | ...",
          "permVector": {"code": "-", "platform": "-", "user": "-", "osGate": "-"}
        }
      },
      "evidence": ["code:<file>:<startLine>-<endLine>", "field:<fieldName>"],
      "entityCheck": {
        "isEntity": true,
        "rejectedAs": null
      },
      "confidence": "high | medium | low",
      "note": "<state here when doubtful or manual re-check is needed>"
    }
  ],
  "audit": {
    "sameDataPatternCheck": {
      "pass": true,
      "violations": [{"apis": ["<APIs producing the same data shape but split apart>"], "reason": "<explain that the grouping basis is mechanism rather than shared artifact>"}]
    },
    "mechanismNotArtifactCheck": {
      "pass": true,
      "violations": [{"groupId": "G?", "sharedArtifact": "<value judged to be a location / mechanism / permission identifier>", "reason": "<...>"}]
    },
    "multiMembershipCheck": {
      "pass": true,
      "suspicious": [{"api": "<API appearing in only one group>", "reason": "<cannot explain why it does not touch other shared artifacts>"}]
    },
    "pendingGroups": [
      {"id": "G?", "decision": "deepen | downgrade",
       "reason": "<downgrade must state compared with which already-investigated groups, and on what signal, this one is judged lower value; 'time budget' may not be written>"}
    ],
    "converged": true
  },
  "newArtifactsFound": ["<shared state / shared function / shared variable discovered this round but not recorded in the current grouping table>"],
  "warnings": ["<signals triggering another loop: need to return to 3a to add a group / need to redo 3c and 3d for new members / need to revise 3b>"],
  "note": "<overall explanation>"
}
````

### Quick Reference of Decision Points (Included in the Prompt; Replicated Here for Manual Re-Check)

| Check | Pass criterion |
|---|---|
| The shared artifact is an entity | `sharedArtifact` describes "the piece of data / the resource / the channel that is shared", not "in which stretch of code the sharing occurs" |
| Not a permission identifier | `sharedArtifact` contains no `scope.*` / `jsapi_*` / `groupKey` value |
| A different relation type means splitting | B1 and B2 are not mixed over the same artifact |
| Capability nature item by item | Within one group's `members_meta`, `capability` may differ (writer ACT-*, reader ACQUIRE) |
| Multi-membership | An API touching multiple artifacts appears in multiple groups |
| Err toward inclusiveness | Groups with `confidence=low` are still retained, not removed for being "uncertain" |

### Write-Back and Persistence

- `mode=build` → write into `_stageA_groups.json` per the schema in "Grouping Output Format: The Five-Tuple" (the three `members_meta` fields must all be filled); record `newArtifactsFound` / `warnings` into `_tmp_<domainAbbr>_step3-6_convergence.md`.
- `mode=audit` → Step 7 may be entered only after `converged=true` and `pendingGroups` is cleared; if `violations` is non-empty, return to procedure step 1 to re-group, and convergence must not be declared while violations remain.
