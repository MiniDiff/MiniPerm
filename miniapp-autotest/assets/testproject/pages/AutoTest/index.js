// ===== safety note =====
// This code is only for validating API behavior in a controlled environment.
// Test scope: permission-inventory inspection, data-equivalence comparison, invocation-sequence observation.
// It does not collect, store, or transmit real user data.
// After testing, clear the related authorization records and local data.
// ========================

// ==================== scenario registration ====================
// Register your test scenarios in this region. The template automatically renders
// the button / result / log areas of every registered scenario.
//
// Format:
//   SCENARIOS['scenarioId'] = {
//     title: 'scenario title',
//     desc: 'scenario description',
//     methodTags: ['①', '②'],          // validation method ids (optional; no tag shown when empty)
//     prerequisites: 'precondition notes',     // optional
//     handler: async function(scenarioId) {
//       // use this._log(scenarioId, msg) to record logs
//       // use this._getAuthSetting() to inspect permissions
//       // use this.setData({ ['results.' + scenarioId]: verdict }) to set the conclusion
//     }
//   };
//
// Button ID rule:   #BtnScenario_{scenarioId}
// Result area rule: #Result_{scenarioId}
// ==================== end scenario registration ====================
var SCENARIOS = {};

// ==================== template core logic (do not modify) ====================
Page({
  data: {
    platform: '',
    systemInfo: '',
    scenarios: [],
    results: {},
    logs: {},
  },

  onLoad() {
    console.log('[AutoTest] generic test page loaded');
    this.updateSystemInfo();
    this._registerAllScenarios();
    console.log("onLoad");
    wx.login({
      success (res) {
        console.log(res);
        if (res.code) {
          // initiate a network request
          wx.request({
            url: 'https://example.com/onLogin',
            data: {
              code: res.code
            }
          })
        } else {
          console.log('login failed: ' + res.errMsg)
        }
      }
    })
  },

  onHide() {
    console.log('[AutoTest] mini-program went to background');
  },

  onShow() {
    console.log('[AutoTest] mini-program returned to foreground');
  },

  // ========== scenario registration and rendering ==========

  _registerAllScenarios() {
    var list = Object.keys(SCENARIOS).map(function(id) {
      var s = SCENARIOS[id];
      return {
        id: id,
        title: s.title || id,
        desc: s.desc || '',
        methodTags: s.methodTags || [],
        prerequisites: s.prerequisites || '',
        hasMethodTags: (s.methodTags && s.methodTags.length > 0),
        hasPrerequisites: !!(s.prerequisites),
      };
    });
    this.setData({ scenarios: list });

    // initialize results and logs
    var initResults = {};
    var initLogs = {};
    list.forEach(function(item) {
      initResults[item.id] = 'Awaiting test...';
      initLogs[item.id] = [];
    });
    this.setData({ results: initResults, logs: initLogs });
  },

  /** Diagnostic: return the handler type of each registered scenario, for the automation engine to troubleshoot scenarios that never ran. */
  diagScenarios() {
    var out = {};
    Object.keys(SCENARIOS || {}).forEach(function (k) {
      var s = SCENARIOS[k];
      out[k] = {
        has: !!s,
        handlerType: s ? typeof s.handler : 'MISSING',
        title: s ? s.title : '',
      };
    });
    return out;
  },

  async runScenario(e) {
    // supports two invocation forms:
    //   1) triggered by the WXML button bindtap -> e is an event object, id from e.currentTarget.dataset.id
    //   2) the automation engine calls page.runScenario('VF-x') directly via evaluate -> e is a string
    var id = typeof e === 'string'
      ? e
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : null);
    if (!id) {
      console.error('[AutoTest] cannot resolve the scenario id, argument received: ' + JSON.stringify(e));
      return;
    }
    var scenario = SCENARIOS[id];
    if (!scenario || !scenario.handler) {
      console.error('[AutoTest] scenario ' + id + ' is not registered or has no handler');
      return;
    }

    // running state
    var update = {};
    update['results.' + id] = '[waiting] running...';
    update['logs.' + id] = [];
    this.setData(update);

    try {
      await scenario.handler.call(this, id);
      // after the handler finishes, the verdict is extracted from the logs automatically
      this._resolveResult(id);
    } catch (err) {
      this._log(id, '[error] fatal exception: ' + (err && err.message ? err.message : String(err)));
      var errUpdate = {};
      errUpdate['results.' + id] = '! undecidable: execution exception — ' + (err && err.message ? err.message : String(err));
      this.setData(errUpdate);
      console.error('[AutoTest] scenario ' + id + ' exception:', err);
    }
  },

  /** Extract the verdict text from the logs automatically and set it into the result area. */
  _resolveResult(scenarioId) {
    var logs = this.data.logs[scenarioId] || [];
    if (logs.length === 0) {
      this.setData({ ['results.' + scenarioId]: '! no log output' });
      return;
    }
    // scan backwards for the last log line containing a verdict keyword
    for (var i = logs.length - 1; i >= 0; i--) {
      var line = logs[i];
      var content = line.replace(/^\[[^\]]+\]\s*/, '');
      var _k = content.toLowerCase();
      if (_k.indexOf('漏洞存在') !== -1 || _k.indexOf('vulnerability exists') !== -1) {
        this.setData({ ['results.' + scenarioId]: '√ ' + content.substring(0, 80) });
        return;
      }
      if (_k.indexOf('漏洞不存在') !== -1 || _k.indexOf('does not exist') !== -1) {
        this.setData({ ['results.' + scenarioId]: '× ' + content.substring(0, 80) });
        return;
      }
      if (_k.indexOf('无法判定') !== -1 || _k.indexOf('undecidable') !== -1) {
        this.setData({ ['results.' + scenarioId]: '！ ' + content.substring(0, 80) });
        return;
      }
    }
    // no verdict keyword found; fall back to the last log line
    this.setData({ ['results.' + scenarioId]: logs[logs.length - 1].substring(0, 80) });
  },

  // ========== built-in helper methods ==========

  /** Record a log into the given scenario. */
  _log(scenarioId, msg) {
    var time = new Date().toISOString().substring(11, 23);
    var entry = '[' + time + '] ' + msg;
    console.log('[AutoTest][' + scenarioId + '] ' + msg);

    var current = this.data.logs[scenarioId] || [];
    current.push(entry);
    var update = {};
    update['logs.' + scenarioId] = current.slice(-100); // keep the latest 100 entries
    this.setData(update);
  },

  /** Get a clean authSetting (keeping only scope keys plus boolean values). */
  _extractAuthData(obj) {
    if (!obj) return {};
    var result = {};
    // prefer the authSetting sub-object
    var source = obj.authSetting || obj;
    Object.keys(source).forEach(function(k) {
      if (k.indexOf('scope.') === 0 && typeof source[k] === 'boolean') {
        result[k] = source[k];
      }
    });
    return result;
  },

  /** Promise wrapper around wx.getSetting. */
  _getAuthSetting() {
    var self = this;
    return new Promise(function(resolve) {
      wx.getSetting({
        success: function(res) {
          resolve(self._extractAuthData(res));
        },
        fail: function(err) {
          console.error('[AutoTest] wx.getSetting failed:', JSON.stringify(err));
          resolve({});
        }
      });
    });
  },

  /** Compare the difference between two authSettings. */
  _diffAuth(before, after) {
    before = before || {};
    after = after || {};
    var allKeys = Object.keys(before).concat(Object.keys(after))
      .filter(function(v, i, a) { return a.indexOf(v) === i; });

    var added = [];
    var changed = [];
    allKeys.forEach(function(k) {
      if (!(k in before) && (k in after)) {
        added.push(k);
      } else if ((k in before) && !(k in after)) {
        // removed — out of analysis scope
      } else if (before[k] !== after[k]) {
        changed.push(k + ': ' + before[k] + ' → ' + after[k]);
      }
    });

    return {
      added: added,
      changed: changed,
      unchanged: (added.length === 0 && changed.length === 0),
    };
  },

  /** Check whether authSetting has changed in any way. */
  _hasAuthChanged(before, after) {
    return !this._diffAuth(before, after).unchanged;
  },

  /** Judge whether an error is a "non-permission error" (environment not supported, etc.). */
  _isNonAuthError(err) {
    if (!err) return false;
    var msg = (err.errMsg || err.message || '').toLowerCase();
    return msg.indexOf('not support') !== -1
      || msg.indexOf('不支持') !== -1
      || msg.indexOf('fail') !== -1;
  },

  /** Promise-based delay. */
  _sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  },

  // ========== environment info ==========

  updateSystemInfo() {
    var self = this;
    try {
      var sys = wx.getSystemInfoSync();
      self.setData({
        platform: sys.platform + ' ' + sys.version,
        systemInfo: sys.model + ' | ' + sys.system + ' | SDK ' + sys.SDKVersion,
      });
      console.log('[AutoTest] system info: ' + self.data.systemInfo);
    } catch (e) {
      console.error('[AutoTest] failed to get system info:', e);
    }
  },

  showEnv() {
    this.updateSystemInfo();
    wx.showToast({ title: 'refreshed', icon: 'success', duration: 1000 });
  },
});
