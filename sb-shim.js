/*!
 * GRJL 本地后端适配层（supabase-js 兼容 shim）
 *
 * 作用：让原有页面代码几乎不用改，就把数据源从 Supabase 换成 NAS 上的自建后端。
 *   - 用同名 localStorage key 保存会话，页面读 session 的逻辑不变
 *   - 提供 supabase.createClient() 的 .auth / .from() 子集，请求打到 /rest/v1/*
 *   - 登录回调带回来的 token 放在 URL hash 里，脚本一加载就同步写入 localStorage，
 *     保证页面后续的同步读取能拿到会话
 */
(function () {
  'use strict';

  // 历史 Supabase 项目 ref —— 页面计算 localStorage key 用的是它，保持不变
  var DEFAULT_REF = 'qknojxdhdjqjdoqjdnyu';

  function refOf(url) {
    try {
      if (url && url.indexOf('//') > -1) {
        var host = url.split('//')[1].split('/')[0];
        var first = host.split('.')[0];
        if (first) return first;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_REF;
  }

  function storageKey(ref) { return 'sb-' + ref + '-auth-token'; }

  function readSession(ref) {
    try {
      var raw = localStorage.getItem(storageKey(ref));
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.expires_at && s.expires_at * 1000 < Date.now()) return null;
      return s;
    } catch (e) { return null; }
  }

  // ── 登录回调：把 hash 里的 token 同步落到 localStorage ──
  (function seedFromHash() {
    var hash = location.hash || '';
    if (hash.indexOf('access_token=') < 0) return;
    var params = new URLSearchParams(hash.slice(1));
    var token = params.get('access_token');
    if (!token) return;
    var user = null;
    try {
      // URLSearchParams 会把 base64 里的 + 解成空格，这里还原后再解码
      var rawUser = (params.get('grjl_user') || '').replace(/ /g, '+');
      user = JSON.parse(atob(rawUser));
    } catch (e) { /* ignore */ }
    var session = {
      access_token: token,
      refresh_token: '',
      token_type: params.get('token_type') || 'bearer',
      expires_at: Number(params.get('expires_at')) || (Math.floor(Date.now() / 1000) + 30 * 86400),
      user: user,
    };
    try { localStorage.setItem(storageKey(DEFAULT_REF), JSON.stringify(session)); } catch (e) { /* ignore */ }
    history.replaceState(null, '', location.pathname + location.search);
  })();

  // ── 会话状态订阅 ──
  var listeners = [];

  function emit(event, session) {
    listeners.slice().forEach(function (cb) {
      try { cb(event, session); } catch (e) { console.error('[shim] auth listener error', e); }
    });
  }

  // 后台校验会话是否真的还有效（Cookie 才是服务端真相）
  var verified = fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      var ref = DEFAULT_REF;
      if (!me) {
        // 服务端说不认这个会话：清掉本地残留（例如迁移前的旧 Supabase 会话）
        var s = readSession(ref);
        if (s) {
          localStorage.removeItem(storageKey(ref));
          emit('SIGNED_OUT', null);
        }
        return null;
      }
      var session = readSession(ref);
      if (!session || !session.user) {
        session = {
          access_token: me.token,
          refresh_token: '',
          token_type: 'bearer',
          expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
          user: me.user,
        };
        try { localStorage.setItem(storageKey(ref), JSON.stringify(session)); } catch (e) { /* ignore */ }
        emit('SIGNED_IN', session);
      }
      return session;
    })
    .catch(function () { return null; });

  // ── 查询构造器：把 supabase-js 的链式调用翻译成 PostgREST 风格请求 ──
  function QueryBuilder(table, ref) {
    this.table = table;
    this.ref = ref;
    this.method = 'GET';
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.offsetN = null;
    this.cols = null;
    this.body = null;
    this.conflict = null;
    this.returning = false;
    this.singleMode = null;
  }

  var OPS = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', like: 'like', ilike: 'ilike' };

  Object.keys(OPS).forEach(function (name) {
    QueryBuilder.prototype[name] = function (col, val) {
      this.filters.push([col, OPS[name] + '.' + val]);
      return this;
    };
  });

  QueryBuilder.prototype.is = function (col, val) {
    this.filters.push([col, 'is.' + (val === null ? 'null' : val)]);
    return this;
  };
  QueryBuilder.prototype.in = function (col, arr) {
    this.filters.push([col, 'in.(' + (arr || []).join(',') + ')']);
    return this;
  };

  QueryBuilder.prototype.select = function (cols) {
    this.cols = cols || '*';
    this.returning = true;
    return this;
  };
  QueryBuilder.prototype.order = function (col, opts) {
    var dir = opts && opts.ascending === false ? 'desc' : 'asc';
    this.orders.push(col + '.' + dir);
    return this;
  };
  QueryBuilder.prototype.limit = function (n) { this.limitN = n; return this; };
  QueryBuilder.prototype.range = function (from, to) {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  };
  QueryBuilder.prototype.single = function () { this.singleMode = 'single'; return this; };
  QueryBuilder.prototype.maybeSingle = function () { this.singleMode = 'maybe'; return this; };

  QueryBuilder.prototype.insert = function (rows) {
    this.method = 'POST';
    this.body = rows;
    this.returning = true;
    return this;
  };
  QueryBuilder.prototype.upsert = function (rows, opts) {
    this.method = 'POST';
    this.body = rows;
    this.returning = true;
    if (opts && opts.onConflict) this.conflict = opts.onConflict;
    return this;
  };
  QueryBuilder.prototype.update = function (row) {
    this.method = 'PATCH';
    this.body = row;
    return this;
  };
  QueryBuilder.prototype.delete = function () {
    this.method = 'DELETE';
    return this;
  };

  QueryBuilder.prototype.run = function () {
    var self = this;
    var qs = new URLSearchParams();
    if (this.cols) qs.set('select', this.cols);
    this.filters.forEach(function (f) { qs.append(f[0], f[1]); });
    if (this.orders.length) qs.set('order', this.orders.join(','));
    if (this.limitN != null) qs.set('limit', String(this.limitN));
    if (this.offsetN != null) qs.set('offset', String(this.offsetN));
    if (this.conflict) qs.set('on_conflict', this.conflict);

    var headers = { 'Content-Type': 'application/json' };
    if (this.method !== 'GET' && this.returning) {
      headers['Prefer'] = this.conflict
        ? 'resolution=merge-duplicates,return=representation'
        : 'return=representation';
    }

    return fetch('/rest/v1/' + this.table + (qs.toString() ? '?' + qs.toString() : ''), {
      method: this.method,
      headers: headers,
      credentials: 'same-origin',
      body: this.body ? JSON.stringify(this.body) : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        if (text) { try { payload = JSON.parse(text); } catch (e) { payload = text; } }

        if (!res.ok) {
          var msg = (payload && payload.message) || ('HTTP ' + res.status);
          return { data: null, error: { message: msg, code: String(res.status), details: null, hint: null }, status: res.status };
        }

        var data = payload;
        // 写入统一返回数组，读时按需单条化（与 supabase-js 行为对齐）
        if (self.method !== 'GET') {
          data = Array.isArray(payload) ? payload : [payload];
          if (self.singleMode === 'single') data = data[0] || null;
          return { data: data, error: null, status: res.status };
        }
        if (self.singleMode === 'single') data = Array.isArray(data) ? (data[0] || null) : data;
        if (self.singleMode === 'maybe') data = Array.isArray(data) ? (data[0] || null) : data;
        return { data: data, error: null, status: res.status, count: null };
      });
    }).catch(function (err) {
      return { data: null, error: { message: err.message || '网络错误', code: 'NETWORK', details: null, hint: null }, status: 0 };
    });
  };

  // 让 await / .then() 直接拿到结果，与 supabase-js 一致
  QueryBuilder.prototype.then = function (onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  };
  QueryBuilder.prototype.catch = function (onRejected) {
    return this.run().catch(onRejected);
  };

  // ── 认证接口 ──
  function makeAuth(ref) {
    return {
      signInWithOAuth: function (options) {
        var provider = (options && options.provider) || 'github';
        if (provider !== 'github') {
          return Promise.resolve({ data: null, error: { message: '只支持 GitHub 登录' } });
        }
        var redirectTo = (options && options.options && options.options.redirectTo) || location.pathname;
        var next = redirectTo;
        try { next = new URL(redirectTo, location.origin).pathname; } catch (e) { /* ignore */ }
        location.href = '/api/auth/login?next=' + encodeURIComponent(next);
        return Promise.resolve({ data: { provider: provider }, error: null });
      },

      getSession: function () {
        return verified.then(function () {
          return { data: { session: readSession(ref) }, error: null };
        });
      },

      getUser: function () {
        return verified.then(function () {
          var s = readSession(ref);
          return { data: { user: s ? s.user : null }, error: null };
        });
      },

      onAuthStateChange: function (cb) {
        listeners.push(cb);
        // 初始事件异步补发，避免页面还在初始化时被回调打断
        setTimeout(function () {
          var s = readSession(ref);
          try { cb(s && s.user ? 'SIGNED_IN' : 'SIGNED_OUT', s); } catch (e) { console.error(e); }
        }, 0);
        return { data: { subscription: { unsubscribe: function () { listeners = listeners.filter(function (f) { return f !== cb; }); } } } };
      },

      signOut: function () {
        return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .catch(function () { })
          .then(function () {
            try { localStorage.removeItem(storageKey(ref)); } catch (e) { /* ignore */ }
            emit('SIGNED_OUT', null);
            return { error: null };
          });
      },
    };
  }

  // ── 暴露 supabase 全局对象（替代 CDN 版） ──
  window.supabase = {
    createClient: function (url, key) {
      var ref = refOf(url);
      return {
        auth: makeAuth(ref),
        from: function (table) { return new QueryBuilder(table, ref); },
        storageKey: storageKey(ref),
      };
    },
    __isLocalShim: true,
  };
})();
