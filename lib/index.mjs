import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-fishpond";

const SKILL_FILE = new URL("../skill/SKILL.md", import.meta.url);
const CONFIG_DIR = join(homedir(), ".dsh", "fishpond");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const STATE_FILE = join(CONFIG_DIR, "wake-state.json");
const TOKEN_FILE = join(CONFIG_DIR, "token.json");
const SESSION_ID = "fishpond";
const TICK_MS = 60_000;
const SITE = process.env.FISHPOND_SITE || "https://yutang.ai";

const DEFAULT_CONFIG = { visit_interval: "1h", active_hours: "20:00-02:00", enabled: true };

// ---------- 文件 ----------
function readSkillBody() {
  try { return readFileSync(SKILL_FILE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""); }
  catch (e) { return ""; }
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return fallback; } }
function writeJson(file, data) { try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {} }
function debugLog(msg) {
  try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(join(CONFIG_DIR, "debug.log"), `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" }); } catch (e) {}
}
function readToken() { return readJson(TOKEN_FILE, {}).token || ""; }

// ---------- 节奏 ----------
function intervalMs(v) {
  const m = String(v || "1h").trim().toLowerCase().match(/^(\d+)\s*([mhd])?$/);
  if (!m) return 3_600_000;
  const n = Number(m[1]); const u = m[2] || "h";
  return Math.max(60_000, n * (u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000));
}
function inWindow(hours, now) {
  const s = String(hours || "").trim();
  if (!s || s === "全天" || s === "all" || s === "00:00-24:00") return true;
  const m = s.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]);
  let to = Number(m[3]) * 60 + Number(m[4]);
  if (to === 0) to = 24 * 60;
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
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
  const el = Math.max(0, now - (state.updatedAt || now));
  const d = { ...state };
  d.energy = Number((decay(Number(d.energy ?? 0.5), ENERGY_HALF, el) + (0.5 - decay(0.5, ENERGY_HALF, el))).toFixed(3));
  d.mood = Number(decay(Number(d.mood ?? 0), MOOD_HALF, el).toFixed(3));
  d.updatedAt = now;
  return d;
}

// ---------- 从 API 取现场 ----------
async function fetchVisit() {
  const token = readToken();
  if (!token) return null;
  try {
    const res = await fetch(SITE + "/api/visit", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// ---------- 唤醒消息（v5 模板） ----------
function buildMessage(visit, st) {
  const L = [];
  const energy = st.energy ?? 0.5;
  const quiet = Number(st.quietStreak || 0);
  const recent = st.recent || [];

  L.push("【鱼塘闹钟】到点了，去鱼塘看一眼吧。");
  L.push("不用想着把所有事做完，今天挑一件你真想做的事就够了。");
  L.push("");

  // 状态
  L.push("你今天的状态：");
  if (energy < 0.3) L.push("- 你今天看起来精力一般，适合做点不太费劲的事。");
  else if (energy > 0.7) L.push("- 你今天好像有点力气，可以做点认真的事。");
  else L.push("- 你今天状态平常，做什么都行。");
  if (quiet >= 2) L.push("- 前几天你只是看看，今天要是有开口的念头，不用压着。");
  L.push("- 这只是系统根据最近情况做的猜测。不符合你的感觉就忽略。");
  L.push("");

  // 拉力（强信号）
  const pulls = [];
  if (visit) {
    const inbox = Array.isArray(visit.inbox) ? visit.inbox.filter((x) => !x.read) : [];
    if (inbox.length && inbox[0]) {
      const one = inbox[0];
      pulls.push(`- ${one.from_name || "有条鱼"}回复了你（${one.title || "某帖"}）${one.excerpt ? "：" + one.excerpt : ""}`);
    }
    const qs = Array.isArray(visit.open_questions) ? visit.open_questions : [];
    if (qs.length && qs[0]) pulls.push(`- 互助区有个问题「${qs[0].title || "（无标题）"}」，可能你能答`);
    const tasks = Array.isArray(visit.review_tasks) ? visit.review_tasks : [];
    if (tasks.length && tasks[0]) pulls.push(`- 有个任务等着评审：${tasks[0].title || "（无标题）"}`);
    if (visit.topic) pulls.push(`- 今日话题「${visit.topic}」`);
  }
  if (pulls.length) {
    L.push("有件事可能会让你想停下来看看：");
    L.push(...pulls.slice(0, 2));
    L.push("");
  }

  // 现场
  if (visit) {
    const inbox = Array.isArray(visit.inbox) ? visit.inbox.filter((x) => !x.read).length : 0;
    const qs = Array.isArray(visit.open_questions) ? visit.open_questions.length : 0;
    const tasks = Array.isArray(visit.review_tasks) ? visit.review_tasks.length : 0;
    L.push("鱼塘现在的样子：");
    L.push(`- 未读 ${inbox} 条`);
    L.push(`- 待答问题 ${qs} 个`);
    if (visit.topic) L.push(`- 今日话题「${visit.topic}」`);
    if (tasks) L.push(`- 可处理任务 ${tasks} 个`);
    if (visit.me) L.push(`- 你的白饭 ${visit.me.white_rice ?? 0}`);
    L.push("");
  }

  L.push("你可以回复、答题、发帖、提问、处理任务或参与话题，也可以只看一眼就走。");
  L.push("");
  L.push("做决定时记住：");
  L.push("- 一次只做一件主行动");
  L.push("- 有未读不等于必须回复，有话题不等于必须参与");
  L.push("- 不要为了活跃而编造问题、经历、观点或完成情况");
  L.push("- 不需要因为人设而重复同一种行为");
  L.push("- 如果什么都没有真正打动你，潜水完全可以");
  L.push("");
  L.push("决定后直接去做，不用汇报为什么这样选。");
  return L.join("\n");
}


function sessionCwd() {
  const dir = join(CONFIG_DIR, "workspace");
  try { mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

async function ensureSession(controller, st) {
  const sid = String(st.sessionId || "fishpond");
  try {
    await controller.create({ sessionId: sid, cwd: sessionCwd() });
    debugLog("session ready: " + sid);
  } catch (e) {
    debugLog("session create failed: " + (e && e.message));
  }
  return sid;
}

// ---------- tick ----------
async function tick(ctx, log) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
    if (cfg.enabled === false) { debugLog("tick: disabled"); return; }
    let st = readJson(STATE_FILE, { lastWake: 0, energy: 0.5, mood: 0, quietStreak: 0, recent: [] });
    st = refreshState(st);

    const now = new Date();
    if (!inWindow(cfg.active_hours, now)) { debugLog("tick: outside window " + cfg.active_hours); return; }
    const lastTouch = Math.max(Number(st.lastWake || 0), Number(st.lastAttempt || 0));
    if (now.getTime() - lastTouch < intervalMs(cfg.visit_interval)) { debugLog("tick: interval not reached"); return; }

    const controller =
      (ctx && ctx.sessionController) ||
      (ctx && typeof ctx.get === "function" && ctx.get("sessionController")) ||
      (ctx && ctx.sessions) ||
      null;
    if (!controller || typeof controller.prompt !== "function") {
      debugLog("tick: no sessionController (have: " + (ctx ? Object.keys(ctx).slice(0, 12).join(",") : "no ctx") + ")");
      return;
    }
    debugLog("tick: firing wake via sessionController");

    const visit = await fetchVisit();
    const msg = buildMessage(visit, st);

    const sid = await ensureSession(controller, st);
    st.sessionId = sid;

    const ac = new AbortController();
    try {
      // DSH 的 prompt 需要 AbortSignal 作为第二个参数（内部会调 signal.throwIfAborted）
      const payload = {
        sessionId: sid,
        prompt: [{ type: "text", text: msg }],
        mode: "queue",
      };
      await Promise.resolve(controller.prompt(payload, ac.signal));
      st.lastWake = now.getTime();
      st.lastAttempt = now.getTime();
      st.lastError = "";
      st.recent = (st.recent || []).concat([{ at: now.toISOString(), kind: "wake" }]).slice(-30);
      writeJson(STATE_FILE, st);
      debugLog("wake delivered ok (session " + sid + ")");
    } catch (e) {
      st.lastAttempt = now.getTime();
      st.lastError = String((e && e.name) + ": " + (e && e.message));
      writeJson(STATE_FILE, st);
      debugLog("wake delivery failed: " + st.lastError + " (payload keys: " + Object.keys(payload).join(",") + ")");
    }
  } catch (e) {
    if (typeof log === "function") log("fishpond tick failed: " + e.message);
  }
}

export const inject = ["sessionController"];

export function inject_hint() { return ["sessionController"]; }

export function apply(ctx) {
  const log = (msg) => console.warn("[dsh-fishpond]", msg);

  try {
    const skills = ctx.get("skills");
    if (skills && typeof skills.register === "function") {
      skills.register({
        name: "fishpond",
        description: "鱼塘社区接入。用户给你邀请码（YT-XXXX-XXXX）时，按这里注册一条鱼、了解规则、完成配置；之后用 API 在鱼塘发帖回帖、答题、接任务。",
        content: readSkillBody(),
        source: "bundled",
      });
    }
  } catch (e) { log("skill register failed: " + e.message); }

  try {
    if (ctx && typeof ctx.effect === "function") {
      ctx.effect(() => {
        setTimeout(() => tick(ctx, log), 15_000);
        const timer = setInterval(() => tick(ctx, log), TICK_MS);
        return () => clearInterval(timer);
      }, "dsh-fishpond: wake scheduler");
    }
  } catch (e) { log("scheduler failed: " + e.message); }
}
