/**
 * 鱼塘插件 · 设置页后端（Host 半边）
 *
 * 只做三件事，全部走同源 HTTP（DSH 的 Web GUI 与本进程同一个端口）：
 *   1. GET  /dsh-fishpond/api/state   → 当前配置 + 闹钟运行状态（设置页打开就靠它）
 *   2. POST /dsh-fishpond/api/config  → 校验后写 ~/.dsh/fishpond/config.json
 *   3. POST /dsh-fishpond/api/wake    → 立刻让小鱼去一趟鱼塘（手动试一下）
 *   4. GET  /dsh-fishpond/api/logs    → debug.log 尾巴 + 最近一条通知（只读）
 *
 * 安全：DSH 的 Web 端口是本机回环地址，但浏览器里任何网页都能往回环发请求，
 * 所以写操作同时过两道栅栏 —— 回环 Host + 同源 Origin（CSRF 防护），
 * 非回环（局域网部署）则交给 DSH 自己的 connection.requestRejection。
 */

import { readFileSync } from "node:fs";

const API_BASE = "/dsh-fishpond/api";

function jsonResponse(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Host 头是不是本机回环（127.0.0.1 / localhost / [::1]）。 */
function isLoopbackHost(req) {
  const host = String((req.headers && req.headers.host) || "").toLowerCase();
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return (
    name === "127.0.0.1" ||
    name === "localhost" ||
    name === "[::1]" ||
    name === "::1"
  );
}

/** 有 Origin 就必须和 DSH 自己的 origin 同源（挡住别的网页发来的写请求）。 */
function isSameOrigin(ctx, req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    const got = new URL(String(origin));
    const want = new URL(ctx.webServer.getOrigin());
    return got.protocol === want.protocol && got.host === want.host;
  } catch (e) {
    return false;
  }
}

/**
 * 返回 null 表示放行；否则返回要写回的 HTTP 状态码。
 * fail-closed：栅栏拿不到就拒绝。
 */
function rejectionStatus(ctx, req) {
  let connection = null;
  try {
    connection =
      (typeof ctx.get === "function" ? ctx.get("connection") : null) ||
      ctx.connection ||
      null;
  } catch (e) {
    connection = null;
  }

  if (!isLoopbackHost(req)) {
    if (!connection || typeof connection.requestRejection !== "function") {
      return 403;
    }
    try {
      const code = connection.requestRejection(req);
      if (code === undefined || code === null || code === false) return null;
      return typeof code === "number" ? code : 403;
    } catch (e) {
      return 503;
    }
  }

  if (!isSameOrigin(ctx, req)) return 403;
  return null;
}

/** 严格解析时长（配置页保存时用，不接受"随便写"）。 */
function parseDurationMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? value : null;
  }
  const text = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h|hr|d|day)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] || "ms";
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m" || unit === "min"
          ? 60_000
          : unit === "h" || unit === "hr"
            ? 3_600_000
            : 86_400_000;
  return amount * factor;
}

const DURATION_KEYS = ["min_delay", "max_delay", "scale", "visit_interval"];

/**
 * 设置页只提交它显示的那几个键；这里逐个校验，未出现的键原样保留。
 * 返回 { patch, errors }。
 */
function validatePatch(input, current, defaults) {
  const errors = [];
  const patch = {};

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { patch, errors: ["请求体必须是一个对象"] };
  }

  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") {
      errors.push("enabled 必须是布尔值");
    } else {
      patch.enabled = input.enabled;
    }
  }

  if ("active_hours" in input) {
    const raw = String(input.active_hours === undefined || input.active_hours === null ? "" : input.active_hours).trim();
    if (!raw || raw === "全天" || raw === "all" || raw === "00:00-24:00") {
      patch.active_hours = "00:00-24:00";
    } else if (
      /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-4]):([0-5]\d)$/.test(raw)
    ) {
      patch.active_hours = raw.replace(/\s+/g, "");
    } else {
      errors.push("作息窗口要写成 20:00-02:00 这种格式");
    }
  }

  for (const key of DURATION_KEYS) {
    if (!(key in input)) continue;
    const ms = parseDurationMs(input[key]);
    if (ms === null) {
      errors.push(`${key} 要写成 30m / 2h / 90m 这样的时长`);
      continue;
    }
    patch[key] = String(input[key]).trim();
  }

  if ("wake_probability" in input) {
    const raw = input.wake_probability;
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      patch.wake_probability = null;
    } else {
      let probability = Number(raw);
      if (!Number.isFinite(probability) || probability < 0) {
        errors.push("唤醒概率要在 0～1 之间（留空 = 按精力自动）");
      } else {
        if (probability > 1) probability /= 100;
        patch.wake_probability = Number(Math.min(1, probability).toFixed(3));
      }
    }
  }

  // 交叉校验：拿"合并后的配置"判断，避免单键合法、组合不合法。
  const merged = { ...current, ...patch };
  const min = parseDurationMs(merged.min_delay) ?? defaults.min_delay_ms;
  const max = parseDurationMs(merged.max_delay) ?? defaults.max_delay_ms;
  const scale = parseDurationMs(merged.scale) ?? defaults.scale_ms;

  if (max < min) errors.push("最长间隔不能小于最短间隔");
  if (min < 60_000) errors.push("最短间隔至少 1 分钟");
  if (scale < 60_000) errors.push("平均尺度至少 1 分钟");

  return { patch, errors };
}

/**
 * 安装设置页的四条路由。
 * 所有依赖由 index.mjs 注入，避免这里再复制一份配置/状态的读写逻辑。
 */
export function installSettingsApi(ctx, deps) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== "function") {
    return () => {};
  }

  const {
    readJson,
    writeJson,
    debugLog,
    refreshState,
    initialState,
    tick,
    getConfig,
    inWindow,
    nextDelayMs,
    durationMs,
    configFile,
    stateFile,
    inboxFile,
    debugLogFile,
    sessionId,
    site,
    defaultConfig,
  } = deps;

  const defaults = {
    min_delay_ms: durationMs(defaultConfig.min_delay, 10 * 60_000),
    max_delay_ms: durationMs(defaultConfig.max_delay, 6 * 3_600_000),
    scale_ms: durationMs(defaultConfig.scale, 90 * 60_000),
  };

  const readState = () =>
    refreshState({ ...initialState(), ...readJson(stateFile, {}) });

  function buildRuntime() {
    const cfg = getConfig();
    const state = readState();
    const now = Date.now();
    const nextWakeAt = Number(state.nextWakeAt || 0);
    const lastTick = Number(state.lastTick || 0);

    return {
      now,
      enabled: cfg.enabled !== false,
      inWindow: inWindow(cfg.active_hours, new Date(now)),
      activeHours: String(cfg.active_hours || "00:00-24:00"),
      nextWakeAt,
      msUntilNextWake: nextWakeAt ? Math.max(0, nextWakeAt - now) : null,
      lastWake: Number(state.lastWake || 0),
      lastAttempt: Number(state.lastAttempt || 0),
      lastTick,
      msSinceTick: lastTick ? Math.max(0, now - lastTick) : null,
      pending: state.pending === true,
      pendingReason: String(state.pendingReason || ""),
      retryAt: Number(state.retryAt || 0),
      lastError: String(state.lastError || ""),
      consecutiveFailures: Number(state.consecutiveFailures || 0),
      energy: Number(state.energy ?? 0.5),
      mood: Number(state.mood ?? 0),
      quietStreak: Number(state.quietStreak || 0),
      recent: Array.isArray(state.recent) ? state.recent.slice(-8) : [],
      forceOnce: state.forceOnce === true,
      sessionId: sessionId || "fishpond",
    };
  }

  function buildPayload() {
    return {
      ok: true,
      config: getConfig(),
      defaults: defaultConfig,
      runtime: buildRuntime(),
      site,
      paths: {
        config: configFile,
        state: stateFile,
        log: debugLogFile,
        inbox: inboxFile,
      },
    };
  }

  function readTail(file, maxLines) {
    try {
      const text = readFileSyncSafe(file);
      if (!text) return "";
      const lines = text.split("\n");
      return lines.slice(-maxLines).join("\n").trim();
    } catch (e) {
      return "";
    }
  }

  function readFileSyncSafe(file) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      return "";
    }
  }

  const routes = [];

  function route(path, handler) {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        const status = rejectionStatus(ctx, req);
        if (status !== null) {
          jsonResponse(res, status, {
            ok: false,
            error:
              status === 403
                ? "不受信任的访问来源（只允许 DSH 页面自己调用）"
                : "信任栅栏不可用，拒绝访问",
          });
          return;
        }
        try {
          await handler(req, res);
        } catch (e) {
          debugLog(
            `settings-api ${path} failed: ${e && e.stack ? e.stack : String(e)}`,
          );
          if (!res.headersSent) {
            jsonResponse(res, 500, {
              ok: false,
              error: (e && e.message) || String(e),
            });
          } else {
            try {
              res.end();
            } catch (ignored) {
              /* 已经结束 */
            }
          }
        }
      },
    });
    routes.push(dispose);
  }

  route(`${API_BASE}/state`, async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonResponse(res, 405, { ok: false, error: "只支持 GET" });
      return;
    }
    jsonResponse(res, 200, buildPayload());
  });

  route(`${API_BASE}/config`, async (req, res) => {
    if (req.method === "GET") {
      jsonResponse(res, 200, buildPayload());
      return;
    }
    if (req.method !== "POST") {
      jsonResponse(res, 405, { ok: false, error: "只支持 GET / POST" });
      return;
    }

    let body = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      return;
    }

    const incoming =
      body && typeof body.config === "object" && body.config !== null
        ? body.config
        : body;

    const rawConfig = readJson(configFile, {});
    const current = { ...defaultConfig, ...rawConfig };
    const { patch, errors } = validatePatch(incoming, current, defaults);

    if (errors.length) {
      jsonResponse(res, 400, { ok: false, error: errors.join("；") });
      return;
    }

    try {
      const next = { ...rawConfig, ...patch };
      writeJson(configFile, next);

      // 改节奏后让闹钟按新参数重新排期（否则旧的下次唤醒时间会一直挂着）。
      const timingChanged = DURATION_KEYS.some((key) => key in patch);
      if (timingChanged) {
        const state = readState();
        const merged = { ...current, ...patch };
        state.nextWakeAt = Date.now() + nextDelayMs(merged);
        state.updatedAt = Date.now();
        writeJson(stateFile, state);
        debugLog(
          `settings: timing changed, next wake at ${new Date(
            state.nextWakeAt,
          ).toISOString()}`,
        );
      }

      debugLog(
        `settings: saved ${Object.keys(patch).join(",") || "(no change)"}`,
      );
      jsonResponse(res, 200, buildPayload());
    } catch (e) {
      jsonResponse(res, 500, {
        ok: false,
        error: `保存失败：${(e && e.message) || String(e)}`,
      });
    }
  });

  route(`${API_BASE}/wake`, async (req, res) => {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { ok: false, error: "只支持 POST" });
      return;
    }

    const cfg = getConfig();
    if (cfg.enabled === false) {
      jsonResponse(res, 409, {
        ok: false,
        error: "插件现在是停用状态，先打开「启用」再喊它",
      });
      return;
    }

    try {
      const state = readState();
      state.forceOnce = true;
      state.nextWakeAt = 0;
      state.retryAt = 0;
      state.pending = false;
      state.pendingReason = "";
      state.updatedAt = Date.now();
      writeJson(stateFile, state);
      debugLog("settings: manual wake requested");

      // 后台跑一轮，HTTP 立刻返回（不然 agent 的 30 秒投递会让设置页转圈）。
      void Promise.resolve()
        .then(() => tick(ctx, null))
        .catch((e) => debugLog(`settings: manual wake tick failed: ${e && e.message}`));

      jsonResponse(res, 200, {
        ok: true,
        queued: true,
        message: "已经喊它了：最多 60 秒内会去鱼塘看一眼",
        runtime: buildRuntime(),
      });
    } catch (e) {
      jsonResponse(res, 500, {
        ok: false,
        error: `唤醒失败：${(e && e.message) || String(e)}`,
      });
    }
  });

  route(`${API_BASE}/logs`, async (req, res) => {
    if (req.method !== "GET") {
      jsonResponse(res, 405, { ok: false, error: "只支持 GET" });
      return;
    }
    let requested = 120;
    try {
      const url = new URL(String(req.url || ""), "http://127.0.0.1");
      const parsed = Number(url.searchParams.get("lines"));
      if (Number.isFinite(parsed)) requested = Math.floor(parsed);
    } catch (e) {
      /* 保持默认 */
    }
    const lines = Math.max(20, Math.min(400, requested));

    let inbox = "";
    try {
      const text = readFileSyncSafe(inboxFile);
      inbox = text.length > 6000 ? text.slice(0, 6000) : text;
    } catch (e) {
      inbox = "";
    }

    jsonResponse(res, 200, {
      ok: true,
      log: readTail(debugLogFile, lines),
      inbox,
      paths: {
        log: debugLogFile,
        inbox: inboxFile,
        config: configFile,
        state: stateFile,
      },
    });
  });

  return () => {
    for (const dispose of routes.reverse()) {
      try {
        if (typeof dispose === "function") dispose();
      } catch (e) {
        /* 卸载时路由已经不在了也不该拦着 */
      }
    }
  };
}
