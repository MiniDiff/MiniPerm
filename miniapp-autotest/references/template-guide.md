# Generic Test-Page Template Usage Guide

## Decision-Text Symbol Conventions (Important; Must Be Observed When Writing Handlers)

When annotating results in decision text such as `this._log(sid, ...)`, **any colored emoji icon is forbidden** (not limited to warning triangles / check marks / crosses — any emoji icon may render as a box, question mark, or blank image in some terminals, editors, and IDEs, harming readability). Use plain text / symbols uniformly:

| Scenario meaning | Use uniformly |
|---|---|
| Warning / undecidable / needs attention | `!` (exclamation mark) |
| Holds / passed / consistent / vulnerability exists | `√` (root / check symbol) |
| Does not hold / failed / inconsistent / vulnerability does not exist | `×` (multiplication / cross symbol) |
| Event callback fired (formerly possibly expressed with a signal-type icon) | `[event]` |
| Waiting / operation in progress (formerly possibly expressed with an hourglass-type icon) | `[waiting]` |
| Data statistics / result summary (formerly possibly expressed with a chart-type icon) | `[summary]` |
| Other semantics with no fixed symbol | Uniformly rewrite as `[bracket + English label]` text form; do not invent new graphic symbols |

The first three rows above are fixed symbol conventions; the later rows are generic rewrites for cases with no dedicated symbol (bracketed text labels replace any graphical emoji). **Exemption**: the circled method numbers in `methodTags` (e.g. `①` / `⑥` / `⑨`) are themselves plain-text numbering symbols rather than colored emoji, are not subject to this rule, and continue to be used as before. The example code below in this document already uses the above symbols uniformly; when writing new scenarios please follow the same style and do not switch back to emoji icons.

## Core Design: Scenario Registration Mode

The template `assets/testpage-template/index.js` adopts a **data-driven scenario registration mode**:

- `SCENARIOS` is a global object; the code generator (Step 10) registers scenarios into it
- Each scenario has a `handler` function taking a `scenarioId` parameter
- The template automatically renders the buttons, result areas, and log areas of all registered scenarios
- **The upper-layer analysis workflow needs only to write into the `SCENARIOS` registration region, not to modify the template's core logic**

## Template Files

| File | Purpose |
|---|---|
| `index.js` | Core logic: `SCENARIOS` registration + `Page()` + built-in helpers |
| `index.wxml` | UI: `wx:for` dynamic scenario rendering + environment-info area |
| `index.wxss` | Styles (generic; no modification needed) |

## Usage Steps

### Step 1: Copy the Template

Copy the three files under `assets/testpage-template/` over `assets/testproject/pages/AutoTest/`.

### Step 2: Register Test Scenarios

Add scenarios in `index.js`'s `// ==================== scenario registration ====================` region:

```javascript
// ==================== scenario registration ====================

SCENARIOS['MyTest'] = {
  title: 'permission-trace comparison — some API',
  desc: 'validate whether authSetting changes after invoking some API',
  methodTags: ['①'],
  prerequisites: 'clear historical authorization records first',
  handler: async function(scenarioId) {
    // ---- 1. baseline collection ----
    const baseline = await this._getAuthSetting();
    this._log(scenarioId, 'baseline authSetting: ' + JSON.stringify(baseline));

    // ---- 2. execute the target API ----
    try {
      // wx.someApi({ ... callback ... });
      this._log(scenarioId, 'API invocation issued');
    } catch (e) {
      this._log(scenarioId, 'API invocation exception: ' + e.message);
    }

    // ---- 3. await the callback ----
    await this._sleep(3000);

    // ---- 4. compare permissions ----
    const current = await this._getAuthSetting();
    const diff = this._diffAuth(baseline, current);
    this._log(scenarioId, 'permission change: ' + JSON.stringify(diff));

    // ---- 5. output the decision ----
    if (!diff.changed) {
      this._log(scenarioId, '√ decision: vulnerability exists — authSetting shows no change at all');
    } else {
      this._log(scenarioId, '× decision: vulnerability does not exist — authSetting changed: ' + diff.added.join(', '));
    }
  }
};

// ==================== end scenario registration ====================
```

> **Important**: do not modify the template's core code (`Page({...})` definition) between the `SCENARIOS` definition line and the end-comment line.

### Step 3: Generate a testPlan

After a scenario is registered, each scenario gets a button `#BtnScenario_{scenarioId}` and a result area `#Result_{scenarioId}`. The testPlan taps those buttons.

### Step 4: Execute the Test

```bash
# run at the workspace root
node .codebuddy/skills/miniapp-autotest/auto.js --batch --clear-auth --auto-authorize --retries 3 \
  --test-project-path ".codebuddy/skills/miniapp-autotest/assets/testproject" \
  --test-plan-path "./testPlan_MyTest.json"
```

## Built-in Helper Method API

### this._getAuthSetting()
Returns a clean `authSetting` object processed by `_extractAuthData()` (keeping only scope keys and boolean values).

### this._diffAuth(before, after)
Returns `{ added: [...], removed: [...], changed: [...], unchanged: true/false }`.

### this._hasAuthChanged(before, after)
Returns `boolean`.

### this._extractAuthData(raw)
Extracts a clean authSetting from the raw object returned by `wx.getSetting()`.

### this._isNonAuthError(err)
Judges whether an error is a "non-permission error" (e.g. unsupported by DevTools).

### this._log(scenarioId, msg)
Records a log. Automatically appended to `this.data.logs[scenarioId]`, triggering a UI update.

### this._sleep(ms)
Promise-based delay.

## The `this` Context Inside a Scenario Handler

Handlers are invoked via `.call(this, scenarioId)`, so `this` points to the Page instance, allowing direct use of:
- `this._log(scenarioId, msg)` — record a log
- `this._getAuthSetting()` — get permissions
- `this.setData({ ... })` — update the UI
- `this._sleep(ms)` — delay

## Common Patterns

### Pattern A: Permission-Trace Comparison (validation method ①)

```javascript
handler: async function(sid) {
  const before = await this._getAuthSetting();
  this._log(sid, 'baseline: ' + JSON.stringify(before));

  // invoke the API...
  await this._sleep(3000);

  const after = await this._getAuthSetting();
  const diff = this._diffAuth(before, after);

  if (!diff.changed) {
    this._log(sid, '√ vulnerability exists: authSetting shows no change');
  } else {
    this._log(sid, '× vulnerability does not exist: newly added permissions ' + diff.added.join(', '));
  }
}
```

### Pattern B: Data-Acquisition Capability Validation (validation methods ⑥+⑨)

```javascript
handler: async function(sid) {
  this._log(sid, 'starting high-frequency invocation...');
  let successCount = 0, failCount = 0;

  for (let i = 0; i < 10; i++) {
    try {
      // invoke the API...
      successCount++;
      this._log(sid, `attempt ${i+1}: succeeded`);
    } catch (e) {
      failCount++;
      this._log(sid, `attempt ${i+1}: failed — ${e.message}`);
    }
    await this._sleep(500);
  }

  if (failCount === 0) {
    this._log(sid, '√ vulnerability exists: all 10 high-frequency invocations succeeded, no rate control');
  } else {
    this._log(sid, `! partial rate control: ${failCount}/10 failed`);
  }
}
```

### Pattern C: Exception Handling and "Undecidable"

```javascript
handler: async function(sid) {
  try {
    const result = await someAPICall();
    if (result && result.errcode) {
      this._log(sid, `! undecidable: the API returned an error — ${result.errmsg}`);
      return;
    }
    // normal decision...
  } catch (e) {
    if (this._isNonAuthError(e)) {
      this._log(sid, '! undecidable: DevTools does not support this API (real-device testing needed)');
    } else {
      this._log(sid, '! undecidable: execution exception — ' + e.message);
    }
  }
}
```
