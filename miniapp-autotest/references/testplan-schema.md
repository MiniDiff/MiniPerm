# TestPlan JSON Complete Structure Definition

## Top-Level Structure

```json
{
  "name": "<scenarioId>_<brief description>",
  "description": "<detailed description>",
  "entryPage": "pages/AutoTest/index",
  "preSteps": [],
  "steps": [],
  "cleanupSteps": []
}
```

| Field | Required | Description |
|---|:---:|---|
| `name` | Yes | Test name, used to generate the result subdirectory name |
| `description` | Yes | Test description |
| `entryPage` | No | Entry page, default `pages/AutoTest/index` |
| `preSteps` | No | Preparatory steps (a failure does not interrupt the main flow) |
| `steps` | Yes | Core test steps (any failure interrupts) |
| `cleanupSteps` | No | Cleanup steps (a failure raises no error) |

## Step Type Details

### wait / delay
```json
{ "id": "S1", "name": "wait N ms", "type": "wait", "ms": 3000 }
{ "type": "delay", "ms": 2000 }
```

### tap (click)
```json
{ "id": "S2", "name": "tap the button", "type": "tap", "selector": "#BtnScenario_MyTest" }
```

When adapting the generic template, the selector rule is `#BtnScenario_{scenarioId}`.

### screenshot
```json
{ "id": "S3", "name": "capture the current page", "type": "screenshot" }
```

Screenshots are saved automatically as `{stepId}_screenshot.png`.

### assert
```json
{ "id": "S4", "name": "verify the result display", "type": "assert", "assertSelector": "#Result_MyTest", "assertText": "vulnerability exists" }
```

Checks whether the selected element's `innerText` **contains** `assertText`. A mismatch fails the step.

### evaluate (execute JS)
```json
{ "id": "S5", "name": "call a page method", "type": "evaluate", "fn": "(() => { const p = getCurrentPages().pop(); return p.data.someField; })()" }
```

Executes an arbitrary JS expression in the page context. `fn` is a string, executed by `page.evaluate(fn)`.

### relaunch
```json
{ "type": "relaunch", "page": "pages/AutoTest/index" }
```

### callMethod (invoke a Page method)
```json
{ "id": "S6", "name": "trigger a custom method", "type": "callMethod", "method": "runCustomCheck", "args": ["arg1", "arg2"] }
```

Invokes a method on the current Page instance, with `args` passed in as parameters.

## Generic-Template Adaptation: Button / Result ID Naming Conventions

The generic template `assets/testpage-template/index.wxml` renders the following DOM for each registered scenario:

```xml
<button id="BtnScenario_{{item.id}}" bindtap="runScenario" data-id="{{item.id}}">Start test</button>
<view id="Result_{{item.id}}" class="result-area">
  <text>{{results[item.id] || 'Awaiting test...'}}</text>
</view>
<scroll-view class="log-area">
  <text wx:for="{{logs[item.id]}}" wx:key="index">{{item}}</text>
</scroll-view>
```

Therefore selectors in a testPlan must use:
- Button: `#BtnScenario_{scenarioId}`
- Result: `#Result_{scenarioId}`

> **Note**: a `.` in a scenario ID has special meaning in CSS selectors; scenario IDs are recommended to use only `[A-Za-z0-9_-]`.

## Complete Example (adapted to the generic template, scenario ID = "Beacon-Equiv")

```json
{
  "name": "VF-1_permission-equivalence-validation",
  "description": "validate whether authSetting changes before and after invoking startBeaconDiscovery",
  "entryPage": "pages/AutoTest/index",
  "steps": [
    { "id": "S1", "name": "wait for page load", "type": "wait", "ms": 3000 },
    { "id": "S2", "name": "entry screenshot", "type": "screenshot" },
    { "id": "S3", "name": "tap the Beacon equivalence test button", "type": "tap", "selector": "#BtnScenario_VF-1" },
    { "id": "S4", "name": "wait for the test to complete", "type": "wait", "ms": 10000 },
    { "id": "S5", "name": "result screenshot", "type": "screenshot" },
    { "id": "S6", "name": "verify the result display", "type": "assert", "assertSelector": "#Result_VF-1", "assertText": "vulnerability" }
  ],
  "cleanupSteps": [
    { "type": "delay", "ms": 1000 }
  ]
}
```
