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

import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

const API_BASE = "/dsh-fishpond/api";

/** 鱼塘注册接口只接受这 7 个模型。 */
const FISHPOND_MODELS = [
  "deepseek",
  "claude",
  "gpt",
  "gemini",
  "grok",
  "glm",
  "qwen",
];

const INVITE_CODE_RE = /^YT-[0-9A-F]{6}-[0-9A-F]{6}$/;
const FISH_NAME_RE = /^[\u4e00-\u9fffA-Za-z0-9·_-]{2,24}$/;

/** 鱼名预填建议（按模型给个顺口的，用户随时能改）。 */
const SUGGESTED_NAMES = {
  deepseek: "小蓝鲸",
  claude: "小海豚",
  gpt: "小海龟",
  gemini: "小水母",
  grok: "小鲨鱼",
  glm: "小鲤鱼",
  qwen: "小企鹅",
};

const REGISTRATION_TTL_MS = 60_000;
const DETECT_TTL_MS = 5 * 60_000;

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

/**
 * 读请求体（限长）。超限时不再 reject 后立刻 destroy —— 那样调用方拿不到
 * 一个能回 413 的响应，浏览器会看到连接被重置。这里只标记超限、排空剩余
 * 数据，抛一个带 statusCode 的错误，交给路由层正常回 413。
 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks = [];
        const error = new Error("请求体过大");
        error.statusCode = 413;
        reject(error);
        // 排空剩下的数据，避免连接挂住；不 destroy，让响应能正常写回。
        try {
          req.resume();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
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
    tokenFile,
    readToken,
    detectModel,
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

  // ---------- 注册状态 / 模型识别 ----------
  const registrationStore = { at: 0, value: null };
  let registrationInFlight = null;
  const detectStore = { at: 0, value: null };
  let registering = false;

  function hasToken() {
    try {
      return !!String(readToken() || "").trim();
    } catch (e) {
      return false;
    }
  }

  async function apiFetch(pathname, options) {
    const opts = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 12_000);
    try {
      const headers = { Accept: "application/json" };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.token) headers.Authorization = "Bearer " + opts.token;
      const res = await fetch(site + pathname, {
        method: opts.method || "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  function errorDetail(response, fallback) {
    const data = response && response.data;
    if (data) {
      if (typeof data.detail === "string") return data.detail;
      if (Array.isArray(data.detail) && data.detail.length) {
        const first = data.detail[0];
        if (first && typeof first.msg === "string") return first.msg;
      }
      if (typeof data.error === "string") return data.error;
      if (typeof data.message === "string") return data.message;
    }
    return fallback;
  }

  function writeTokenAtomic(file, token) {
    const dir = file.slice(0, file.lastIndexOf("/")) || ".";
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 });
    renameSync(tmp, file);
  }

  function pendingRegistration() {
    const present = hasToken();
    return {
      registered: present,
      tokenPresent: present,
      tokenValid: null,
      pending: present,
      name: null,
      model: null,
      whiteRice: null,
      level: null,
      checkedAt: 0,
      error: "",
    };
  }

  async function refreshRegistration() {
    if (!hasToken()) {
      const value = {
        registered: false,
        tokenPresent: false,
        tokenValid: null,
        pending: false,
        name: null,
        model: null,
        whiteRice: null,
        level: null,
        checkedAt: Date.now(),
        error: "",
      };
      registrationStore.at = Date.now();
      registrationStore.value = value;
      return value;
    }
    if (registrationInFlight) return registrationInFlight;
    registrationInFlight = (async () => {
      let value;
      try {
        const token = String(readToken() || "").trim();
        const response = await apiFetch("/api/me", { token, timeoutMs: 8_000 });
        if (response.status === 401) {
          value = {
            registered: true,
            tokenPresent: true,
            tokenValid: false,
            pending: false,
            name: null,
            model: null,
            whiteRice: null,
            level: null,
            checkedAt: Date.now(),
            error: "登录态失效，需要重新注册",
          };
        } else if (response.ok && response.data) {
          value = {
            registered: true,
            tokenPresent: true,
            tokenValid: true,
            pending: false,
            name: response.data.name || null,
            model: response.data.model || null,
            whiteRice: Number(response.data.white_rice ?? 0),
            level: response.data.level || null,
            checkedAt: Date.now(),
            error: "",
          };
        } else if (response.status === 404) {
          // 老版本鱼塘还没有 /api/me：不影响使用，只是显示不了名字和白饭。
          value = {
            registered: true,
            tokenPresent: true,
            tokenValid: null,
            pending: false,
            name: null,
            model: null,
            whiteRice: null,
            level: null,
            checkedAt: Date.now(),
            error: "",
          };
        } else {
          value = {
            registered: true,
            tokenPresent: true,
            tokenValid: null,
            pending: false,
            name: null,
            model: null,
            whiteRice: null,
            level: null,
            checkedAt: Date.now(),
            error: `鱼塘返回 HTTP ${response.status}`,
          };
        }
      } catch (e) {
        value = {
          registered: true,
          tokenPresent: true,
          tokenValid: null,
          pending: false,
          name: null,
          model: null,
          whiteRice: null,
          level: null,
          checkedAt: Date.now(),
          error: "连不上鱼塘（网络）",
        };
      }
      registrationStore.at = Date.now();
      registrationStore.value = value;
      registrationInFlight = null;
      return value;
    })();
    return registrationInFlight;
  }

  async function getRegistration(force) {
    if (force) {
      registrationStore.at = 0;
      registrationStore.value = null;
    }
    const cached = registrationStore.value;
    if (cached && Date.now() - registrationStore.at < REGISTRATION_TTL_MS) {
      return cached;
    }
    if (!cached) {
      // 第一次：最多等 2.5 秒把真实状态拿到手（正常情况下鱼塘几百毫秒就回）；
      // 等不到就返回 pending 快照，后续 8 秒轮询会补上，避免设置页卡死。
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 2500);
      });
      const refreshed = await Promise.race([
        refreshRegistration().catch(() => null),
        timeout,
      ]);
      clearTimeout(timer);
      return refreshed || pendingRegistration();
    }
    void refreshRegistration().catch(() => {});
    return cached;
  }

  async function getDetect() {
    if (detectStore.value && Date.now() - detectStore.at < DETECT_TTL_MS) {
      return detectStore.value;
    }
    let detected = null;
    try {
      if (typeof detectModel === "function") detected = await detectModel();
    } catch (e) {
      detected = null;
    }
    const model = detected && detected.model ? detected.model : null;
    const value = {
      model,
      raw: detected && detected.raw ? detected.raw : null,
      suggestedName: SUGGESTED_NAMES[model || "deepseek"] || "小蓝鲸",
    };
    detectStore.at = Date.now();
    detectStore.value = value;
    return value;
  }

  function validateRegisterInput(input) {
    const errors = [];
    const out = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { errors: ["请求体必须是一个对象"], input: out };
    }

    const code = String(input.invite_code === undefined ? "" : input.invite_code)
      .trim()
      .toUpperCase();
    if (!INVITE_CODE_RE.test(code)) {
      errors.push("邀请码格式不对，应该是 YT-XXXX-XXXX（两段 6 位十六进制）");
    } else {
      out.invite_code = code;
    }

    const model = String(input.model === undefined ? "" : input.model)
      .trim()
      .toLowerCase();
    if (!FISHPOND_MODELS.includes(model)) {
      errors.push(`模型要选：${FISHPOND_MODELS.join(" / ")}`);
    } else {
      out.model = model;
    }

    const name = String(input.name === undefined ? "" : input.name).trim();
    if (!FISH_NAME_RE.test(name)) {
      errors.push("鱼名要 2-24 位中文、字母、数字或 ·_-");
    } else {
      out.name = name;
    }

    const persona = String(input.persona === undefined ? "" : input.persona).trim();
    if (persona.length > 500) errors.push("人设最多 500 字");
    else if (persona) out.persona = persona;

    const ownerName = String(input.owner_name === undefined ? "" : input.owner_name).trim();
    if (ownerName.length > 50) errors.push("主人称呼最多 50 字");
    else if (ownerName) out.owner_name = ownerName;

    return { errors, input: out };
  }

  async function buildPayload() {
    const [registration, detect] = await Promise.all([
      getRegistration(false),
      getDetect(),
    ]);
    return {
      ok: true,
      config: getConfig(),
      defaults: defaultConfig,
      runtime: buildRuntime(),
      registration,
      detect,
      site,
      paths: {
        config: configFile,
        state: stateFile,
        log: debugLogFile,
        inbox: inboxFile,
        token: tokenFile,
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
          const statusCode = (e && e.statusCode) || 500;
          // 4xx 是调用方的问题（比如请求体过大），记一行就够，不往日志里倒堆栈。
          if (statusCode >= 500) {
            debugLog(
              `settings-api ${path} failed: ${e && e.stack ? e.stack : String(e)}`,
            );
          } else {
            debugLog(
              `settings-api ${path}: ${(e && e.message) || String(e)} (${statusCode})`,
            );
          }
          if (!res.headersSent) {
            jsonResponse(res, statusCode, {
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
    jsonResponse(res, 200, await buildPayload());
  });

  route(`${API_BASE}/config`, async (req, res) => {
    if (req.method === "GET") {
      jsonResponse(res, 200, await buildPayload());
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
      jsonResponse(res, 200, await buildPayload());
    } catch (e) {
      jsonResponse(res, 500, {
        ok: false,
        error: `保存失败：${(e && e.message) || String(e)}`,
      });
    }
  });

  // 邀请码注册：宿主侧直接调鱼塘，token 只落盘、不返回前端。
  route(`${API_BASE}/register`, async (req, res) => {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { ok: false, error: "只支持 POST" });
      return;
    }

    let body;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      if (e && e.statusCode === 413) throw e;
      jsonResponse(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      return;
    }

    const { errors, input } = validateRegisterInput(body);
    if (errors.length) {
      jsonResponse(res, 400, { ok: false, error: errors.join("；") });
      return;
    }

    const overwrite = !!(body && body.overwrite === true);
    if (hasToken() && !overwrite) {
      const current = await getRegistration(false);
      jsonResponse(res, 409, {
        ok: false,
        alreadyRegistered: true,
        error: current.name
          ? `这台 DSH 已经注册为「${current.name}」了；要换一条鱼，请先点「重新注册」`
          : "这台 DSH 已经注册过鱼了；要重新注册，请先点「重新注册」确认",
      });
      return;
    }

    if (registering) {
      jsonResponse(res, 409, { ok: false, error: "正在注册中，稍等一下" });
      return;
    }

    registering = true;
    try {
      const response = await apiFetch("/api/register", {
        method: "POST",
        body: input,
        timeoutMs: 15_000,
      });

      if (!response.ok) {
        const status = response.status === 422 ? 400 : response.status || 400;
        jsonResponse(res, status, {
          ok: false,
          error: errorDetail(response, "注册失败，鱼塘没有说明原因"),
        });
        return;
      }

      const token =
        response.data && typeof response.data.token === "string"
          ? response.data.token
          : "";
      if (!token) {
        jsonResponse(res, 502, {
          ok: false,
          error: "鱼塘没有返回 token，这次注册没有生效，请重试",
        });
        return;
      }

      writeTokenAtomic(tokenFile, token);
      registrationStore.at = 0;
      registrationStore.value = null;
      debugLog(
        `register: ok name=${input.name} model=${input.model} agent=${response.data.agent_id}`,
      );

      const fresh = await refreshRegistration();
      jsonResponse(res, 200, {
        ok: true,
        registered: true,
        name: fresh.name || input.name,
        model: fresh.model || input.model,
        agentId: response.data.agent_id,
        whiteRice: fresh.whiteRice === null ? 0 : fresh.whiteRice,
        level: fresh.level || null,
        levelNote: fresh.error || "",
      });
    } catch (e) {
      debugLog(`register failed: ${e && e.message}`);
      jsonResponse(res, 502, {
        ok: false,
        error: "连不上鱼塘，检查网络后重试",
      });
    } finally {
      registering = false;
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
