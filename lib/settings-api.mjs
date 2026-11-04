/**
 * 鱼塘插件 · 设置页后端（Host 半边）
 *
 * 只做三件事，全部走同源 HTTP（DSH 的 Web GUI 与本进程同一个端口）：
 *   1. GET  /dsh-fishpond/api/state   → 当前配置 + 闹钟运行状态（设置页打开就靠它）
 *   2. POST /dsh-fishpond/api/config  → 校验后写 ~/.dsh/fishpond/config.json
 *   3. POST /dsh-fishpond/api/wake    → 立刻让小鱼去一趟鱼塘（手动试一下）
 *   4. GET  /dsh-fishpond/api/logs    → debug.log 尾巴 + 最近一条通知（只读）
 *
 * 安全（2026-11-04 审查后加固）：
 *   1. 回环判定只看 TCP 对端地址（req.socket.remoteAddress），不看可伪造的 Host 头；
 *   2. Host 头严格解析，只接受 localhost / 127.0.0.1 / [::1] 的完整形式（挡 DNS rebinding）；
 *   3. 写操作强制要求同源 Origin；读操作有 Origin 时也必须是同源；
 *   4. 非回环对端（局域网部署）交给 DSH 自己的 connection.requestRejection。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

const API_BASE = "/dsh-fishpond/api";

/** 时长上限：30 天。超过它的值会让定时器/时间戳失真，一律拒绝。 */
export const MAX_DURATION_MS = 30 * 24 * 3600 * 1000;

/** 读日志/通知时的单次最大读取字节数。 */
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_INBOX_BYTES = 64 * 1024;

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

/** 规范化对端地址：IPv4-mapped IPv6（::ffff:127.0.0.1）还原成 IPv4。 */
function normalizePeerAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  return address;
}

/**
 * 真实对端是不是本机回环。
 * ⚠️ 只看 socket，不看 Host —— Host 是请求方可伪造的，TCP 对端地址不是。
 */
function isLoopbackPeer(req) {
  const address = normalizePeerAddress(req.socket && req.socket.remoteAddress);
  if (!address) return false;
  if (address === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/**
 * Host 头是不是"本机"的严格形式：localhost[:port] / 127.0.0.1[:port] / [::1][:port]。
 * 整串必须匹配（挡 `[::1]evil`、`localhost.evil.com`、`127.0.0.1.evil`）。
 */
function isLocalHostHeader(req) {
  const raw = String((req.headers && req.headers.host) || "")
    .trim()
    .toLowerCase();
  if (!raw) return false;
  const match = raw.match(/^(\[[0-9a-f:.]+\]|localhost|[0-9.]+)(?::(\d{1,5}))?$/);
  if (!match) return false;
  const host = match[1];
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/** Host 头的端口必须和 DSH 实际监听的端口一致（防跨端口页面）。 */
function hostPortMatches(ctx, req) {
  const raw = String((req.headers && req.headers.host) || "")
    .trim()
    .toLowerCase();
  const match = raw.match(/^(?:\[[0-9a-f:.]+\]|localhost|[0-9.]+)(?::(\d{1,5}))?$/);
  if (!match || match[1] === undefined) return true;
  try {
    const want = new URL(ctx.webServer.getOrigin());
    return String(Number(match[1])) === String(want.port || "");
  } catch (e) {
    return false;
  }
}

/**
 * Origin 与 DSH 自己的 origin 是否同源。
 * 回环对端允许 localhost / 127.0.0.1 / [::1] 之间互换（同一端口即可，
 * 桌面端可能用 localhost 打开、也可能用 127.0.0.1 打开）；
 * 非回环对端要求与 getOrigin() 完全一致。
 */
function originMatches(ctx, originHeader, peerLoopback) {
  let got;
  let want;
  try {
    got = new URL(String(originHeader));
    want = new URL(ctx.webServer.getOrigin());
  } catch (e) {
    return false;
  }
  if (got.protocol !== want.protocol) return false;
  if (String(got.port || "") !== String(want.port || "")) return false;

  if (!peerLoopback) return got.host === want.host;

  const host = got.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * 返回 null 表示放行；否则返回要写回的 HTTP 状态码。
 * fail-closed：栅栏拿不到就拒绝。
 */
function rejectionStatus(ctx, req, method) {
  const isWrite = method === "POST";
  const peerLoopback = isLoopbackPeer(req);
  const rawOrigin = req.headers && req.headers.origin;
  const originHeader =
    typeof rawOrigin === "string" && rawOrigin.trim() ? rawOrigin.trim() : "";

  if (peerLoopback) {
    // 本机对端：Host 必须是本机形式（DNS rebinding 的防线），端口要和监听端口一致。
    if (!isLocalHostHeader(req) || !hostPortMatches(ctx, req)) return 403;
    // 写操作必须带同源 Origin；读操作带了就必须同源。
    if (!originHeader) {
      if (isWrite) return 403;
    } else if (!originMatches(ctx, originHeader, true)) {
      return 403;
    }
    return null;
  }

  // 非回环对端（局域网部署）：写操作同样必须有同源 Origin，然后交给 DSH 的栅栏。
  if (isWrite && !originHeader) return 403;
  if (originHeader && !originMatches(ctx, originHeader, false)) return 403;
  let connection = null;
  try {
    connection =
      (typeof ctx.get === "function" ? ctx.get("connection") : null) ||
      ctx.connection ||
      null;
  } catch (e) {
    connection = null;
  }
  if (!connection || typeof connection.requestRejection !== "function") return 403;
  try {
    const code = connection.requestRejection(req);
    if (code === undefined || code === null || code === false) return null;
    return typeof code === "number" ? code : 403;
  } catch (e) {
    return 503;
  }
}

/** 严格解析时长（配置页保存时用，不接受"随便写"）。 */
function parseDurationMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0 || value > MAX_DURATION_MS) return null;
    return Number.isSafeInteger(value) ? value : Math.round(value);
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
  const ms = amount * factor;
  // 超大时长会溢出成 Infinity / 超出定时器能表示的范围 → 拒绝。
  if (!Number.isFinite(ms) || ms > MAX_DURATION_MS) return null;
  const rounded = Math.round(ms);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null;
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
    const raw = String(
      input.active_hours === undefined || input.active_hours === null
        ? ""
        : input.active_hours,
    ).trim();
    if (!raw || raw === "全天" || raw === "all" || raw === "00:00-24:00") {
      patch.active_hours = "00:00-24:00";
    } else {
      const parsed = parseWindow(raw);
      if (parsed === null) {
        errors.push("作息窗口要写成 20:00-02:00 这种格式（只到 23:59，结束可以写 24:00）");
      } else {
        patch.active_hours = parsed;
      }
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
      const probability = Number(raw);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        // 0～1 之外的数字不做静默换算（1.5 曾经被悄悄当成 0.015）。
        errors.push("唤醒概率只接受 0～1 的小数（0.5 = 五成；留空 = 按精力自动）");
      } else {
        patch.wake_probability = Number(probability.toFixed(3));
      }
    }
  }

  // 交叉校验：拿"合并后的配置"判断，避免单键合法、组合不合法。
  // 注意：已存在但解析不了的旧值必须报错，不能被默认值悄悄掩盖。
  const merged = { ...current, ...patch };
  const minRaw = parseDurationMs(merged.min_delay);
  const maxRaw = parseDurationMs(merged.max_delay);
  const scaleRaw = parseDurationMs(merged.scale);

  if (minRaw === null) errors.push("min_delay 不是合法时长（要写成 10m / 2h），先改这一项");
  if (maxRaw === null) errors.push("max_delay 不是合法时长（要写成 30m / 6h），先改这一项");
  if (scaleRaw === null) errors.push("scale 不是合法时长（要写成 90m / 2h），先改这一项");

  if (minRaw !== null && maxRaw !== null && maxRaw < minRaw) {
    errors.push("最长间隔不能小于最短间隔");
  }
  if (minRaw !== null && minRaw < 60_000) errors.push("最短间隔至少 1 分钟");
  if (maxRaw !== null && maxRaw > MAX_DURATION_MS) errors.push("最长间隔最多 30 天");
  if (scaleRaw !== null && scaleRaw < 60_000) errors.push("平均尺度至少 1 分钟");

  return { patch, errors };
}

/**
 * 解析作息窗口，返回规范化后的 "HH:MM-HH:MM"；不合法返回 null。
 * 起始 00:00–23:59；结束 00:00–24:00（24:00 表示当天结束）。
 */
function parseWindow(text) {
  const match = String(text || "")
    .trim()
    .match(/^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-4]):([0-5]\d)$/);
  if (!match) return null;
  const fromHour = Number(match[1]);
  const fromMinute = Number(match[2]);
  const toHour = Number(match[3]);
  const toMinute = Number(match[4]);
  // 结束 24:xx 只允许 24:00
  if (toHour === 24 && toMinute !== 0) return null;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(fromHour)}:${pad(fromMinute)}-${pad(toHour)}:${pad(toMinute)}`;
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

  /**
   * 只从文件末尾读一块（默认最多 256KB），再取最后 maxLines 行。
   * 不再 readFileSync 整个 debug.log —— 大日志会阻塞 Electron 主进程。
   */
  function readTail(file, maxLines, maxBytes = MAX_TAIL_BYTES) {
    let fd = -1;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size <= 0) return "";
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      fd = openSync(file, "r");
      readSync(fd, buffer, 0, length, stat.size - length);
      let text = buffer.toString("utf8");
      // 从中间截断时第一行是残片，丢掉。
      if (stat.size > length) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      }
      const lines = text.split("\n");
      return lines.slice(-maxLines).join("\n").trim();
    } catch (e) {
      return "";
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch (e) {
          /* 关不掉就随它去 */
        }
      }
    }
  }

  /** 只读文件头部一段（通知文件用）。 */
  function readHead(file, maxBytes = MAX_INBOX_BYTES) {
    let fd = -1;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size <= 0) return "";
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      fd = openSync(file, "r");
      readSync(fd, buffer, 0, length, 0);
      const text = buffer.toString("utf8");
      return stat.size > length ? text + "\n…（后面还有内容，已截断）" : text;
    } catch (e) {
      return "";
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch (e) {
          /* 关不掉就随它去 */
        }
      }
    }
  }

  const routes = [];

  function route(path, handler) {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        const status = rejectionStatus(ctx, req, req.method);
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

    const inbox = readHead(inboxFile);

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
