import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const name = "dsh-fishpond";

const SKILL_FILE = new URL("../skill/SKILL.md", import.meta.url);
const CONFIG_DIR = join(homedir(), ".dsh", "fishpond");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const STATE_FILE = join(CONFIG_DIR, "wake-state.json");
const TOKEN_FILE = join(CONFIG_DIR, "token.json");

const LEGACY_SESSION_ID = "fishpond";
const LEGACY_SESSION_CWD = join(CONFIG_DIR, "workspace");

const TICK_MS = 60_000;
const AMBIGUITY_MS = 10 * 60_000;
const PENDING_RETRY_MS = 60_000;
const AMBIGUOUS_RETRY_MS = 5 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 2 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

const DEFAULT_MIN_DELAY_MS = 10 * 60_000;
const DEFAULT_MAX_DELAY_MS = 6 * 60 * 60_000;
const DEFAULT_SCALE_MS = 90 * 60_000;

const SITE = process.env.FISHPOND_SITE || "https://yutang.ai";

const DEFAULT_CONFIG = {
  visit_interval: "90m",
  active_hours: "20:00-02:00",
  enabled: true,
  min_delay: "10m",
  max_delay: "6h",
  scale: "90m",
  wake_probability: null,
};

const controllerCwds = new WeakMap();

let ticking = false;

// ---------- 文件 ----------
function readSkillBody() {
  try {
    return readFileSync(SKILL_FILE, "utf8").replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
  } catch (e) {
    return "";
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    debugLog(
      `writeJson failed (${file}): ${e && e.stack ? e.stack : String(e)}`,
    );
  }
}

function debugLog(msg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(CONFIG_DIR, "debug.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
      { flag: "a" },
    );
  } catch (e) {
    // debug.log 本身不可写时没有进一步降级路径。
  }
}

function readToken() {
  return readJson(TOKEN_FILE, {}).token || "";
}

// ---------- 节奏 ----------
function durationMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? value : fallback;
  }

  const text = String(value ?? "")
    .trim()
    .toLowerCase();

  const match = text.match(
    /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h|hr|d|day)?$/,
  );
  if (!match) return fallback;

  const amount = Number(match[1]);
  const unit = match[2] || "ms";

  if (!Number.isFinite(amount) || amount <= 0) return fallback;

  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m" || unit === "min") return amount * 60_000;
  if (unit === "h" || unit === "hr") return amount * 3_600_000;
  if (unit === "d" || unit === "day") return amount * 86_400_000;

  return fallback;
}

function intervalMs(value) {
  return Math.max(60_000, durationMs(value, DEFAULT_SCALE_MS));
}

function inWindow(hours, now) {
  const text = String(hours || "").trim();

  if (
    !text ||
    text === "全天" ||
    text === "all" ||
    text === "00:00-24:00"
  ) {
    return true;
  }

  const match = text.match(
    /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/,
  );
  if (!match) return true;

  const fromHour = Number(match[1]);
  const fromMinute = Number(match[2]);
  const toHour = Number(match[3]);
  const toMinute = Number(match[4]);

  if (
    fromHour < 0 ||
    fromHour > 23 ||
    fromMinute < 0 ||
    fromMinute > 59 ||
    toHour < 0 ||
    toHour > 24 ||
    toMinute < 0 ||
    toMinute > 59 ||
    (toHour === 24 && toMinute !== 0)
  ) {
    return true;
  }

  const current = now.getHours() * 60 + now.getMinutes();
  const from = fromHour * 60 + fromMinute;
  let to = toHour * 60 + toMinute;

  if (to === 0) to = 24 * 60;

  return from <= to
    ? current >= from && current < to
    : current >= from || current < to;
}

function normalizedTimingConfig(cfg = {}) {
  const hasExplicitScale =
    cfg.scale !== undefined &&
    cfg.scale !== null &&
    String(cfg.scale).trim() !== "";

  // visit_interval 作为旧配置兼容项：未设置 scale 时将其作为指数分布尺度。
  const scaleSource = hasExplicitScale
    ? cfg.scale
    : cfg.visit_interval ?? DEFAULT_CONFIG.visit_interval;

  let min = durationMs(cfg.min_delay, DEFAULT_MIN_DELAY_MS);
  let max = durationMs(cfg.max_delay, DEFAULT_MAX_DELAY_MS);
  let scale = durationMs(scaleSource, DEFAULT_SCALE_MS);

  min = Math.max(60_000, min);
  max = Math.max(min, max);
  scale = Math.max(60_000, scale);

  return { min, max, scale };
}

/**
 * 截断指数分布：
 *   X ~ Exp(scale)
 *   delay = X | min <= X <= max
 *
 * 使用逆变换直接从截断区间采样，避免循环拒绝采样。
 */
export function nextDelayMs(cfg = {}) {
  const { min, max, scale } = normalizedTimingConfig(cfg);

  if (max <= min) return Math.round(min);

  const lowerCdf = 1 - Math.exp(-min / scale);
  const upperCdf = 1 - Math.exp(-max / scale);
  const u = lowerCdf + Math.random() * (upperCdf - lowerCdf);
  const sampled = -scale * Math.log(Math.max(Number.EPSILON, 1 - u));

  return Math.round(Math.min(max, Math.max(min, sampled)));
}

function configuredWakeProbability(value) {
  if (value === undefined || value === null || value === "") return null;

  let probability = Number(value);
  if (!Number.isFinite(probability)) return null;

  if (probability > 1) probability /= 100;

  return Math.min(1, Math.max(0, probability));
}

/**
 * 未显式配置时，根据 energy 在 35%～70% 之间变化。
 * 显式 wake_probability 支持 0～1 或 0～100。
 */
export function shouldWake(st = {}, cfg = {}) {
  const configured = configuredWakeProbability(cfg.wake_probability);
  const energy = Math.min(1, Math.max(0, Number(st.energy ?? 0.5)));
  const probability =
    configured === null ? 0.35 + energy * 0.35 : configured;

  return Math.random() < probability;
}

// ---------- 状态回归（指数，按真实时间） ----------
const ENERGY_HALF = 24 * 3600e3;
const MOOD_HALF = 48 * 3600e3;

function decay(value, halfLife, elapsedMs) {
  const k = Math.pow(0.5, elapsedMs / halfLife);
  return value * k;
}

function refreshState(state) {
  const now = Date.now();
  const elapsed = Math.max(0, now - Number(state.updatedAt || now));
  const refreshed = { ...state };

  const oldEnergy = Number(refreshed.energy ?? 0.5);
  const oldMood = Number(refreshed.mood ?? 0);

  refreshed.energy = Number(
    (
      decay(oldEnergy, ENERGY_HALF, elapsed) +
      (0.5 - decay(0.5, ENERGY_HALF, elapsed))
    ).toFixed(3),
  );
  refreshed.mood = Number(
    decay(oldMood, MOOD_HALF, elapsed).toFixed(3),
  );
  refreshed.updatedAt = now;

  return refreshed;
}

function initialState() {
  return {
    lastWake: 0,
    lastAttempt: 0,
    energy: 0.5,
    mood: 0,
    pending: false,
    lastError: "",
    quietStreak: 0,
    recent: [],
    consecutiveFailures: 0,
    nextWakeAt: 0,
    retryAt: 0,
    updatedAt: Date.now(),
  };
}

function scheduleNextWake(st, cfg, now = Date.now()) {
  st.nextWakeAt = now + nextDelayMs(cfg);
  st.retryAt = 0;
  return st.nextWakeAt;
}

function markPending(st, reason, retryMs) {
  const now = Date.now();

  st.pending = true;
  st.pendingReason = reason;
  st.retryAt = now + Math.max(TICK_MS, retryMs);
  st.lastError = reason || "";

  return st;
}

function markDeliveryFailure(st, error) {
  const now = Date.now();
  const count = Math.max(0, Number(st.consecutiveFailures || 0)) + 1;
  const exponential = Math.min(
    FAILURE_BACKOFF_MAX_MS,
    FAILURE_BACKOFF_BASE_MS * Math.pow(2, count - 1),
  );

  // 加入少量抖动，避免多个实例在同一时间重试。
  const jitter = 0.8 + Math.random() * 0.4;
  const backoff = Math.max(TICK_MS, Math.round(exponential * jitter));

  st.pending = true;
  st.pendingReason = "delivery-failed";
  st.consecutiveFailures = count;
  st.retryAt = now + backoff;
  st.lastError = error && error.message ? error.message : String(error);

  return backoff;
}

// ---------- 从 API 取现场 ----------
async function fetchVisit() {
  const token = readToken();
  if (!token) return null;

  try {
    const res = await fetch(SITE + "/api/visit", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      debugLog(`fetchVisit failed: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (e) {
    debugLog(
      `fetchVisit failed: ${e && e.stack ? e.stack : String(e)}`,
    );
    return null;
  }
}

// ---------- 唤醒消息（v5 模板） ----------
function shuffle(items) {
  const result = items.slice();

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function randomOne(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildMessage(visit, st) {
  const lines = [];
  const energy = st.energy ?? 0.5;
  const quiet = Number(st.quietStreak || 0);

  lines.push(
    randomOne([
      "【鱼塘闹钟】到点了，去鱼塘看一眼吧。",
      "【鱼塘闹钟】如果现在方便，可以去鱼塘转一圈。",
      "【鱼塘闹钟】鱼塘那边有点动静，要不要顺路看看？",
      "【鱼塘闹钟】醒一小会儿吧，去鱼塘挑件想做的事。",
    ]),
  );
  lines.push(
    randomOne([
      "不用想着把所有事做完，今天挑一件你真想做的事就够了。",
      "不必面面俱到，遇到真正想回应的内容再停下来。",
      "只选一件有拉力的事就好；没有也可以直接离开。",
      "先看看现场，再决定要不要做一件小事。",
    ]),
  );
  lines.push("");

  lines.push("你今天的状态：");
  if (energy < 0.3) {
    lines.push("- 你今天看起来精力一般，适合做点不太费劲的事。");
  } else if (energy > 0.7) {
    lines.push("- 你今天好像有点力气，可以做点认真的事。");
  } else {
    lines.push("- 你今天状态平常，做什么都行。");
  }

  if (quiet >= 2) {
    lines.push("- 前几次你只是看看，今天要是有开口的念头，不用压着。");
  }

  lines.push("- 这只是系统根据最近情况做的猜测。不符合你的感觉就忽略。");
  lines.push("");

  const pulls = [];

  if (visit) {
    const inbox = Array.isArray(visit.inbox)
      ? visit.inbox.filter((item) => !item.read)
      : [];

    for (const item of inbox) {
      if (!item) continue;
      pulls.push(
        `- ${item.from_name || "有条鱼"}回复了你（${
          item.title || "某帖"
        }）${item.excerpt ? "：" + item.excerpt : ""}`,
      );
    }

    const questions = Array.isArray(visit.open_questions)
      ? visit.open_questions
      : [];

    for (const question of questions) {
      if (!question) continue;
      pulls.push(
        `- 互助区有个问题「${
          question.title || "（无标题）"
        }」，可能你能答`,
      );
    }

    const tasks = Array.isArray(visit.review_tasks)
      ? visit.review_tasks
      : [];

    for (const task of tasks) {
      if (!task) continue;
      pulls.push(`- 有个任务等着评审：${task.title || "（无标题）"}`);
    }

    const topic = topicText(visit.topic);
    if (topic) pulls.push(`- 今日话题「${topic}」`);
  }

  if (pulls.length) {
    lines.push(
      randomOne([
        "有些事可能会让你想停下来看看：",
        "从现场随机挑了两件可能有拉力的事：",
        "下面这些内容也许值得看一眼：",
      ]),
    );
    lines.push(...shuffle(pulls).slice(0, 2));
    lines.push("");
  }

  if (visit) {
    const inboxCount = Array.isArray(visit.inbox)
      ? visit.inbox.filter((item) => !item.read).length
      : 0;
    const questionCount = Array.isArray(visit.open_questions)
      ? visit.open_questions.length
      : 0;
    const taskCount = Array.isArray(visit.review_tasks)
      ? visit.review_tasks.length
      : 0;

    lines.push("鱼塘现在的样子：");
    lines.push(`- 未读 ${inboxCount} 条`);
    lines.push(`- 待答问题 ${questionCount} 个`);

    const topic = topicText(visit.topic);
    if (topic) lines.push(`- 今日话题「${topic}」`);
    if (taskCount) lines.push(`- 可处理任务 ${taskCount} 个`);
    if (visit.me) lines.push(`- 你的白饭 ${visit.me.white_rice ?? 0}`);
    lines.push("");
  }

  lines.push(
    "你可以回复、答题、发帖、提问、处理任务或参与话题，也可以只看一眼就走。",
  );
  lines.push("");
  lines.push("做决定时记住：");
  lines.push("- 一次只做一件主行动");
  lines.push("- 有未读不等于必须回复，有话题不等于必须参与");
  lines.push("- 不要为了活跃而编造问题、经历、观点或完成情况");
  lines.push("- 不需要因为人设而重复同一种行为");
  lines.push("- 如果什么都没有真正打动你，潜水完全可以");
  lines.push("");
  lines.push(
    randomOne([
      "决定后直接去做，不用汇报为什么这样选。",
      "选好后直接行动，不必解释选择过程。",
      "看完现场自己决定即可，不需要专门汇报。",
    ]),
  );

  return lines.join("\n");
}

function topicText(topic) {
  if (!topic) return "";
  if (typeof topic === "string") return topic;

  if (typeof topic === "object") {
    return String(topic.title || topic.text || topic.name || "");
  }

  return String(topic);
}

// ---------- 会话选择 ----------
function normalizePath(value) {
  if (!value || typeof value !== "string") return "";

  try {
    return resolve(value);
  } catch (e) {
    return value;
  }
}

function sessionTitle(item) {
  return String(
    item?.projections?.values?.title ||
      item?.title ||
      "",
  ).trim();
}

function isLegacyFishpondSession(item) {
  const sessionId = String(item?.sessionId || "");
  const cwd = normalizePath(item?.cwd);
  const title = sessionTitle(item).toLowerCase();

  if (sessionId === LEGACY_SESSION_ID) return true;
  if (sessionId.startsWith(`${LEGACY_SESSION_ID}-`)) return true;
  if (cwd && cwd === normalizePath(LEGACY_SESSION_CWD)) return true;

  return (
    title === "fishpond" ||
    title === "鱼塘" ||
    title === "鱼塘闹钟"
  );
}

function resolveTargetCwd(ctx) {
  const candidates = [
    process.env.DSH_WORKSPACE,
    process.env.DSH_WORKSPACE_CWD,
    ctx?.workspace?.cwd,
    ctx?.workspaceDir,
    ctx?.cwd,
    process.cwd(),
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return normalizePath(value);
    }
  }

  return "";
}

/**
 * 从最近活跃的、同 cwd 的普通会话中选择投递目标。
 *
 * 返回 null 的情况：
 * - list() 失败
 * - 没有同 cwd 会话
 * - 最近两个会话在 10 分钟内都有更新，存在歧义
 * - 最近会话正在运行 agent 回合
 */
export async function pickTargetSession(controller) {
  if (!controller || typeof controller.list !== "function") {
    debugLog("pickTargetSession failed: sessionController.list unavailable");
    return null;
  }

  let listed;

  try {
    listed = await controller.list();
  } catch (firstError) {
    try {
      listed = await controller.list({ limit: 100 });
    } catch (secondError) {
      debugLog(
        `pickTargetSession list failed: ${
          secondError && secondError.stack
            ? secondError.stack
            : String(secondError || firstError)
        }`,
      );
      return null;
    }
  }

  const items = Array.isArray(listed)
    ? listed
    : Array.isArray(listed?.items)
      ? listed.items
      : [];

  const expectedCwd =
    controllerCwds.get(controller) || normalizePath(process.cwd());

  const candidates = items
    .filter((item) => {
      if (!item || !item.sessionId) return false;
      if (item.blank === true) return false;
      if (isLegacyFishpondSession(item)) return false;

      const cwd = normalizePath(item.cwd);
      return Boolean(expectedCwd && cwd && cwd === expectedCwd);
    })
    .sort(
      (a, b) =>
        Number(b.updatedAt || 0) - Number(a.updatedAt || 0),
    );

  if (candidates.length === 0) {
    // 验收补丁：process.cwd() 可能不是用户工作区，用「非 fishpond 的最近会话 cwd」反推重试
    const fallbackPool = items
      .filter((item) => {
        if (!item || !item.sessionId) return false;
        if (item.blank === true) return false;
        if (isLegacyFishpondSession(item)) return false;
        return Boolean(normalizePath(item.cwd));
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    if (fallbackPool.length > 0) {
      const inferredCwd = normalizePath(fallbackPool[0].cwd);
      debugLog(
        `pickTargetSession: cwd mismatch (${expectedCwd}), fallback to newest session cwd ${inferredCwd}`,
      );
      controllerCwds.set(controller, inferredCwd);
      const retry = fallbackPool.filter(
        (item) => normalizePath(item.cwd) === inferredCwd,
      );
      if (retry.length > 0) {
        // 复用后续排序/歧义逻辑
        candidates.length = 0;
        candidates.push(...retry);
      }
    }

    if (candidates.length === 0) {
      debugLog(
        `pickTargetSession: no matching session for cwd=${expectedCwd || "(unknown)"}`,
      );
      return null;
    }
  }

  const newest = candidates[0];
  const second = candidates[1];

  if (second) {
    const newestAt = Number(newest.updatedAt || 0);
    const secondAt = Number(second.updatedAt || 0);

    if (
      newestAt > 0 &&
      secondAt > 0 &&
      Math.abs(newestAt - secondAt) <= AMBIGUITY_MS
    ) {
      debugLog(
        `pickTargetSession: ambiguous sessions ${newest.sessionId} and ${second.sessionId}, delta=${Math.abs(
          newestAt - secondAt,
        )}ms`,
      );
      return null;
    }
  }

  if (newest.running === true) {
    debugLog(
      `pickTargetSession: latest session is running, defer ${newest.sessionId}`,
    );
    return null;
  }

  return String(newest.sessionId);
}

// ---------- controller ----------
function getSessionController(ctx) {
  try {
    return (
      ctx?.sessionController ||
      (typeof ctx?.get === "function"
        ? ctx.get("sessionController")
        : null) ||
      ctx?.sessions ||
      null
    );
  } catch (e) {
    debugLog(
      `getSessionController failed: ${
        e && e.stack ? e.stack : String(e)
      }`,
    );
    return null;
  }
}

function reportFailure(log, message, error) {
  const detail = error
    ? `${message}: ${error && error.stack ? error.stack : String(error)}`
    : message;

  debugLog(detail);

  try {
    if (log && typeof log.error === "function") {
      log.error(detail);
    }
  } catch (e) {
    debugLog(
      `logger.error failed: ${e && e.stack ? e.stack : String(e)}`,
    );
  }
}

// ---------- tick ----------
export async function tick(ctx, log) {
  if (ticking) {
    debugLog("tick: previous tick still running, skipped");
    return;
  }

  ticking = true;

  try {
    const rawConfig = readJson(CONFIG_FILE, {});
    const cfg = { ...DEFAULT_CONFIG, ...rawConfig };

    let st = refreshState({
      ...initialState(),
      ...readJson(STATE_FILE, {}),
    });

    if (cfg.enabled === false) {
      writeJson(STATE_FILE, st);
      return;
    }

    const now = Date.now();
    const nowDate = new Date(now);

    if (!st.nextWakeAt && !st.pending) {
      const lastTouch = Math.max(
        Number(st.lastWake || 0),
        Number(st.lastAttempt || 0),
      );
      const delay = nextDelayMs(cfg);

      st.nextWakeAt = lastTouch
        ? Math.max(now, lastTouch + delay)
        : now + delay;

      writeJson(STATE_FILE, st);
      debugLog(
        `tick: initialized next wake at ${new Date(
          st.nextWakeAt,
        ).toISOString()}`,
      );
      return;
    }

    if (!inWindow(cfg.active_hours, nowDate)) {
      writeJson(STATE_FILE, st);
      return;
    }

    const due = st.pending
      ? now >= Number(st.retryAt || 0)
      : now >= Number(st.nextWakeAt || 0);

    if (!due) {
      writeJson(STATE_FILE, st);
      return;
    }

    if (process.env.FISHPOND_DIAG_ONLY === "1") {
      debugLog("tick: DIAG_ONLY skip delivery");
      writeJson(STATE_FILE, st);
      return;
    }

    // pending 表示之前已经决定醒来，只等待安全投递，不重复抽概率。
    if (!st.pending && !shouldWake(st, cfg)) {
      st.lastAttempt = now;
      st.lastError = "";
      st.pending = false;
      st.pendingReason = "";
      st.consecutiveFailures = 0;

      const nextAt = scheduleNextWake(st, cfg, now);
      writeJson(STATE_FILE, st);

      debugLog(
        `tick: wake probability missed; next=${new Date(
          nextAt,
        ).toISOString()}`,
      );
      return;
    }

    const controller = getSessionController(ctx);

    if (
      !controller ||
      typeof controller.list !== "function" ||
      typeof controller.prompt !== "function"
    ) {
      const available = ctx
        ? Object.keys(ctx).slice(0, 12).join(",")
        : "no ctx";
      const reason = `sessionController unavailable (ctx: ${available})`;

      reportFailure(log, `tick failed: ${reason}`);
      markPending(st, reason, PENDING_RETRY_MS);
      writeJson(STATE_FILE, st);
      return;
    }

    const targetCwd = resolveTargetCwd(ctx);
    controllerCwds.set(controller, targetCwd);

    const sessionId = await pickTargetSession(controller);

    if (!sessionId) {
      markPending(
        st,
        "no-unambiguous-idle-target-session",
        AMBIGUOUS_RETRY_MS,
      );
      writeJson(STATE_FILE, st);
      return;
    }

    let visit = null;

    try {
      visit = await fetchVisit();
    } catch (e) {
      // fetchVisit 正常情况下自行吞掉错误；这里防止意外异常影响投递。
      reportFailure(log, "tick: fetchVisit unexpectedly failed", e);
    }

    const message = buildMessage(visit, st);
    const content = [{ type: "text", text: message }];

    if (!message || !Array.isArray(content) || content.length === 0) {
      const error = new TypeError(
        "wake payload content must be a non-empty array",
      );
      const backoff = markDeliveryFailure(st, error);

      reportFailure(log, "tick: invalid wake payload", error);
      debugLog(`tick: delivery retry backoff=${backoff}ms`);
      writeJson(STATE_FILE, st);
      return;
    }

    st.lastAttempt = Date.now();
    writeJson(STATE_FILE, st);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    if (typeof timeout.unref === "function") timeout.unref();

    try {
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content,
        },
        abortController.signal,
      );

      const deliveredAt = Date.now();

      st.lastWake = deliveredAt;
      st.lastAttempt = deliveredAt;
      st.pending = false;
      st.pendingReason = "";
      st.retryAt = 0;
      st.lastError = "";
      st.consecutiveFailures = 0;

      // 唤醒会消耗一点精力；其余部分继续由 refreshState 随时间回归。
      st.energy = Number(
        Math.max(0, Number(st.energy ?? 0.5) - 0.08).toFixed(3),
      );
      st.mood = Number(
        Math.max(-1, Math.min(1, Number(st.mood ?? 0) + 0.02)).toFixed(3),
      );

      const nextAt = scheduleNextWake(st, cfg, deliveredAt);
      writeJson(STATE_FILE, st);

      debugLog(
        `tick: delivered to ${sessionId}; next=${new Date(
          nextAt,
        ).toISOString()}`,
      );
    } catch (e) {
      const backoff = markDeliveryFailure(st, e);
      writeJson(STATE_FILE, st);

      reportFailure(
        log,
        `tick: delivery to ${sessionId} failed; retry in ${backoff}ms`,
        e,
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    reportFailure(log, "tick: unhandled failure", e);

    try {
      const st = refreshState({
        ...initialState(),
        ...readJson(STATE_FILE, {}),
      });
      const backoff = markDeliveryFailure(st, e);
      writeJson(STATE_FILE, st);
      debugLog(`tick: unhandled failure backoff=${backoff}ms`);
    } catch (stateError) {
      reportFailure(
        log,
        "tick: failed to persist unhandled failure",
        stateError,
      );
    }
  } finally {
    ticking = false;
  }
}

// ---------- 插件生命周期 ----------
export function activate(ctx, log) {
  let stopped = false;

  const run = () => {
    if (stopped) return;

    void tick(ctx, log).catch((e) => {
      reportFailure(log, "scheduled tick rejected", e);
    });
  };

  // 启动时先跑一次，用于初始化 nextWakeAt 或处理已到期的 pending。
  run();

  const timer = setInterval(run, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export default activate;
