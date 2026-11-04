/**
 * dsh-fishpond · 客户端半边
 *
 * 两件事：
 *   1. 右下角 🐟 入口（原功能，保留）
 *   2. DSH「设置 → 鱼塘」：配置表单 + 闹钟运行状态 + 运行日志
 *
 * 数据流：section ⇄ /dsh-fishpond/api/*（同源 fetch）⇄ ~/.dsh/fishpond/config.json
 * 配置只在点「保存」时提交；未提交的改动不会被后台轮询覆盖。
 */
window.__ModuleLoader__.load({
  id: "dsh-fishpond",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const {
      createElement: h,
      useCallback,
      useEffect,
      useRef,
      useState,
    } = React;

    const SITE = "https://yutang.ai";
    const API = "/dsh-fishpond/api";

    // ── 样式：只用 --dsw-alias-* 主题变量，浅色/深色都跟宿主走 ──────────────
    const CSS = `
.fp{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:4px}
.fp-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.fp-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 2px;font-size:13px;line-height:20px}
.fp-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}
.fp-rows{display:flex;flex-direction:column}
.fp-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.fp-row:last-child{border-bottom:none}
.fp-row>div:first-child{flex:1;min-width:200px}
.fp-label{font-size:13px;line-height:19px}
.fp-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}
.fp-val{font-size:13px;line-height:19px;text-align:right;white-space:pre-wrap}
.fp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.fp-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:170px;outline:none}
.fp-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.fp-switch{width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;transition:background .15s}
.fp-switch .fp-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.fp-switch.fp-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.fp-switch.fp-on .fp-knob{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground,#fff)}
.fp-switch:disabled{opacity:.5;cursor:default}
.fp-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary)}
.fp-badge.fp-ok{background:rgba(46,190,120,.16);color:var(--dsw-alias-state-success-primary)}
.fp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.fp-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}
.fp-btn:disabled{opacity:.5;cursor:default}
.fp-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.fp-dirty{font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.fp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}
.fp-msg{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:8px}
.fp-log{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:260px;overflow:auto;margin:8px 0 0}
.fp-details{margin-top:14px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.fp-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.fp-bar{height:6px;border-radius:999px;background:rgba(127,127,127,.16);width:120px;overflow:hidden;margin-left:auto}
.fp-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.fp-foot{margin-top:14px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}
`;

    // ── 小工具 ────────────────────────────────────────────────────────
    async function api(path, options) {
      const init = Object.assign(
        { headers: { "Content-Type": "application/json" } },
        options || {},
      );
      const res = await fetch(API + path, init);
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      if (!res.ok || !data || data.ok === false) {
        const reason =
          (data && (data.error || data.message)) || "HTTP " + res.status;
        throw new Error(reason);
      }
      return data;
    }

    function toForm(config) {
      const cfg = config || {};
      return {
        enabled: cfg.enabled !== false,
        active_hours: String(cfg.active_hours || "00:00-24:00"),
        min_delay: String(cfg.min_delay || ""),
        max_delay: String(cfg.max_delay || ""),
        scale: String(cfg.scale || ""),
        wake_probability:
          cfg.wake_probability === null || cfg.wake_probability === undefined
            ? ""
            : String(cfg.wake_probability),
      };
    }

    function fmtClock(ms) {
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    }

    function fmtDateTime(ms) {
      const d = new Date(ms);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return mm + "-" + dd + " " + fmtClock(ms);
    }

    function fmtAgo(ms) {
      if (!ms) return "从未";
      const diff = Math.max(0, Date.now() - ms);
      if (diff < 60_000) return Math.max(1, Math.round(diff / 1000)) + " 秒前";
      if (diff < 3_600_000) return Math.round(diff / 60_000) + " 分钟前";
      if (diff < 86_400_000)
        return (diff / 3_600_000).toFixed(1) + " 小时前";
      return Math.round(diff / 86_400_000) + " 天前";
    }

    function fmtLeft(ms) {
      if (ms === null || ms === undefined) return "未排期";
      if (ms <= 0) return "马上";
      if (ms < 60_000) return "不到 1 分钟";
      if (ms < 3_600_000) return Math.round(ms / 60_000) + " 分钟";
      return (ms / 3_600_000).toFixed(1) + " 小时";
    }

    // ── 控件 ──────────────────────────────────────────────────────────
    function Switch(props) {
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": props.checked ? "true" : "false",
          "aria-label": props.label || "开关",
          className: "fp-switch" + (props.checked ? " fp-on" : ""),
          disabled: !!props.disabled,
          onClick: () => props.onChange(!props.checked),
        },
        h("span", { className: "fp-knob" }),
      );
    }

    function Row(props) {
      return h(
        "div",
        { className: "fp-row" },
        h(
          "div",
          null,
          h("div", { className: "fp-label" }, props.label),
          props.hint ? h("div", { className: "fp-hint" }, props.hint) : null,
        ),
        props.children,
      );
    }

    function TextField(props) {
      return h("input", {
        className: "fp-input",
        type: "text",
        spellCheck: false,
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        onChange: (e) => props.onChange(e.target.value),
        "aria-label": props.label,
      });
    }

    // ── 设置页 ────────────────────────────────────────────────────────
    function FishpondSection() {
      const [snapshot, setSnapshot] = useState(null);
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [logs, setLogs] = useState(null);

      const baseForm = snapshot ? toForm(snapshot.config) : null;
      const dirty = !!(
        baseForm &&
        form &&
        JSON.stringify(baseForm) !== JSON.stringify(form)
      );
      const dirtyRef = useRef(false);
      dirtyRef.current = dirty;

      const adopt = useCallback((data, force) => {
        setSnapshot(data);
        if (force || !dirtyRef.current) setForm(toForm(data.config));
      }, []);

      const load = useCallback(async () => {
        try {
          const data = await api("/state");
          adopt(data, true);
          setError("");
        } catch (e) {
          setError("读不到插件状态：" + e.message);
        }
      }, [adopt]);

      // 打开就拉一次，之后每 8 秒只刷新运行状态（不动你正在改的表单）。
      useEffect(() => {
        let alive = true;
        const pull = async () => {
          try {
            const data = await api("/state");
            if (!alive) return;
            if (dirtyRef.current) {
              setSnapshot((prev) =>
                prev
                  ? Object.assign({}, prev, {
                      runtime: data.runtime,
                      paths: data.paths,
                    })
                  : data,
              );
            } else {
              adopt(data, false);
            }
          } catch (e) {
            if (alive) setError("刷新状态失败：" + e.message);
          }
        };
        pull();
        const timer = setInterval(pull, 8000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [adopt]);

      const set = (key, value) =>
        setForm((prev) => Object.assign({}, prev, { [key]: value }));

      const save = async () => {
        if (!form || busy) return;
        setBusy("save");
        setError("");
        setNotice("");
        try {
          const data = await api("/config", {
            method: "POST",
            body: JSON.stringify({ config: form }),
          });
          adopt(data, true);
          setNotice("已保存，闹钟按新节奏重新排期了。");
        } catch (e) {
          setError("保存失败：" + e.message);
        } finally {
          setBusy("");
        }
      };

      const wake = async () => {
        if (busy) return;
        setBusy("wake");
        setError("");
        setNotice("");
        try {
          const data = await api("/wake", { method: "POST", body: "{}" });
          setNotice(data.message || "已经喊它了。");
        } catch (e) {
          setError("唤醒失败：" + e.message);
        } finally {
          setBusy("");
        }
      };

      const loadLogs = async () => {
        if (busy) return;
        setBusy("logs");
        try {
          const data = await api("/logs?lines=150");
          setLogs(data);
        } catch (e) {
          setError("读日志失败：" + e.message);
        } finally {
          setBusy("");
        }
      };

      const runtime = snapshot && snapshot.runtime;
      const paths = (snapshot && snapshot.paths) || {};

      const statusRows = [];
      if (runtime) {
        statusRows.push(
          h(
            Row,
            { key: "run", label: "运行", hint: "插件当前是开是关" },
            h(
              "span",
              {
                className: "fp-badge" + (runtime.enabled ? " fp-ok" : ""),
              },
              runtime.enabled ? "启用中" : "已停用",
            ),
          ),
        );
        statusRows.push(
          h(
            Row,
            {
              key: "window",
              label: "现在",
              hint: "作息窗口之外不会唤醒",
            },
            h(
              "span",
              { className: "fp-val" },
              runtime.enabled
                ? runtime.inWindow
                  ? "在作息窗口内"
                  : "不在窗口（" + runtime.activeHours + " 才会醒）"
                : "—",
            ),
          ),
        );
        statusRows.push(
          h(
            Row,
            { key: "next", label: "下次唤醒", hint: "按节奏随机，不是整点" },
            h(
              "span",
              { className: "fp-val" },
              runtime.nextWakeAt
                ? fmtLeft(runtime.msUntilNextWake) +
                  "后（" +
                  fmtClock(runtime.nextWakeAt) +
                  "）"
                : runtime.pending
                  ? "投递失败，重试中"
                  : "等下一次心跳排期",
            ),
          ),
        );
        statusRows.push(
          h(
            Row,
            { key: "last", label: "上次唤醒", hint: "真的把消息投进「悄悄去鱼塘」会话" },
            h("span", { className: "fp-val" }, fmtAgo(runtime.lastWake)),
          ),
        );
        statusRows.push(
          h(
            Row,
            { key: "tick", label: "闹钟心跳", hint: "每分钟一次；超过几分钟没动就是卡住了" },
            h(
              "span",
              { className: "fp-val" },
              runtime.msSinceTick === null
                ? "还没有心跳"
                : fmtAgo(runtime.lastTick),
            ),
          ),
        );
        statusRows.push(
          h(
            Row,
            { key: "mood", label: "精力 / 心情", hint: "两个会随时间慢慢回归" },
            h(
              "span",
              { className: "fp-val" },
              "精力 " + runtime.energy.toFixed(2) + " · 心情 " +
                (runtime.mood >= 0 ? "+" : "") +
                runtime.mood.toFixed(2),
            ),
          ),
        );
        if (runtime.pending) {
          statusRows.push(
            h(
              Row,
              { key: "pending", label: "待重试" },
              h(
                "span",
                { className: "fp-val" },
                (runtime.pendingReason || "等待重试") +
                  (runtime.retryAt
                    ? "（" + fmtLeft(runtime.retryAt - runtime.now) + "后）"
                    : ""),
              ),
            ),
          );
        }
        if (runtime.lastError) {
          statusRows.push(
            h(
              Row,
              { key: "err", label: "上次错误" },
              h(
                "span",
                { className: "fp-val fp-mono" },
                runtime.lastError,
              ),
            ),
          );
        }
        if (runtime.recent && runtime.recent.length) {
          statusRows.push(
            h(
              Row,
              {
                key: "recent",
                label: "最近几次唤醒",
                hint: "最新的在上面",
              },
              h(
                "span",
                { className: "fp-val fp-mono" },
                runtime.recent
                  .slice()
                  .reverse()
                  .map((item) =>
                    typeof item === "string"
                      ? item
                      : (item && (item.at || item.time)) || "",
                  )
                  .filter(Boolean)
                  .join("\n"),
              ),
            ),
          );
        }
      }

      const configRows = form
        ? [
            h(
              Row,
              {
                key: "enabled",
                label: "启用",
                hint: "关掉后完全不会自己去鱼塘",
              },
              h(Switch, {
                checked: !!form.enabled,
                label: "启用鱼塘闹钟",
                disabled: busy === "save",
                onChange: (next) => set("enabled", next),
              }),
            ),
            h(
              Row,
              {
                key: "hours",
                label: "作息窗口",
                hint: "写成 20:00-02:00；跨夜也行。00:00-24:00 = 全天",
              },
              h(TextField, {
                label: "作息窗口",
                value: form.active_hours,
                placeholder: "00:00-24:00",
                disabled: busy === "save",
                onChange: (v) => set("active_hours", v),
              }),
            ),
            h(
              Row,
              {
                key: "min",
                label: "最短间隔",
                hint: "两次唤醒之间至少隔这么久（30m / 2h）",
              },
              h(TextField, {
                label: "最短间隔",
                value: form.min_delay,
                placeholder: "10m",
                disabled: busy === "save",
                onChange: (v) => set("min_delay", v),
              }),
            ),
            h(
              Row,
              {
                key: "max",
                label: "最长间隔",
                hint: "再久也不会超过这个间隔（2h / 6h）",
              },
              h(TextField, {
                label: "最长间隔",
                value: form.max_delay,
                placeholder: "6h",
                disabled: busy === "save",
                onChange: (v) => set("max_delay", v),
              }),
            ),
            h(
              Row,
              {
                key: "scale",
                label: "平均尺度",
                hint: "指数分布的尺度，90m ≈ 大多数一小时内醒，偶尔拖很久",
              },
              h(TextField, {
                label: "平均尺度",
                value: form.scale,
                placeholder: "90m",
                disabled: busy === "save",
                onChange: (v) => set("scale", v),
              }),
            ),
            h(
              Row,
              {
                key: "prob",
                label: "唤醒概率",
                hint: "留空 = 按精力自动（35%～70%）；0.5 = 五成",
              },
              h(TextField, {
                label: "唤醒概率",
                value: form.wake_probability,
                placeholder: "留空 = 自动",
                disabled: busy === "save",
                onChange: (v) => set("wake_probability", v),
              }),
            ),
          ]
        : [];

      return h(
        "div",
        { className: "fp" },
        h("style", { key: "css" }, CSS),
        h("h3", { className: "fp-title" }, "鱼塘"),
        h(
          "p",
          { className: "fp-intro" },
          "DSH 里的小鱼会按作息自己去鱼塘逛：看收件箱、答问题、接任务。",
          "这里能看到它现在在做什么、下次什么时候醒，也能改节奏。",
        ),

        h("div", { className: "fp-group" }, "运行状态"),
        !snapshot && !error
          ? h("div", { className: "fp-hint" }, "读取中…")
          : h("div", { className: "fp-rows" }, statusRows),

        h("div", { className: "fp-group" }, "节奏"),
        h("div", { className: "fp-rows" }, configRows),

        h(
          "div",
          { className: "fp-actions" },
          h(
            "button",
            {
              type: "button",
              className: "fp-btn",
              disabled: !!busy || !dirty,
              onClick: save,
            },
            busy === "save" ? "保存中…" : "保存",
          ),
          h(
            "button",
            {
              type: "button",
              className: "fp-btn fp-btn2",
              disabled: !!busy,
              onClick: wake,
            },
            busy === "wake" ? "喊它中…" : "立即唤醒一次",
          ),
          h(
            "button",
            {
              type: "button",
              className: "fp-btn fp-btn2",
              disabled: !!busy,
              onClick: load,
            },
            "刷新",
          ),
          dirty
            ? h(
                "span",
                { className: "fp-dirty" },
                "● 有改动还没保存",
              )
            : null,
        ),

        error ? h("div", { className: "fp-err" }, error) : null,
        notice ? h("div", { className: "fp-msg" }, notice) : null,

        h(
          "details",
          {
            className: "fp-details",
            onToggle: (e) => {
              if (e.currentTarget.open && !logs) loadLogs();
            },
          },
          h("summary", null, "运行日志"),
          logs
            ? h(
                "div",
                null,
                h("p", { className: "fp-hint" }, logs.paths && logs.paths.log),
                h("pre", { className: "fp-log" }, logs.log || "（还没有日志）"),
                h(
                  "p",
                  { className: "fp-hint", style: { marginTop: "10px" } },
                  "最近一条通知 " +
                    ((logs.paths && logs.paths.inbox) || ""),
                ),
                h(
                  "pre",
                  { className: "fp-log" },
                  logs.inbox || "（还没有通知）",
                ),
              )
            : h(
                "p",
                { className: "fp-hint" },
                busy === "logs" ? "读取中…" : "展开后读取最近 150 行",
              ),
        ),

        h(
          "div",
          { className: "fp-foot" },
          "配置写在 ",
          h("code", null, paths.config || "~/.dsh/fishpond/config.json"),
          "，状态写在 ",
          h("code", null, paths.state || "~/.dsh/fishpond/wake-state.json"),
          "。右下角 🐟 仍然直达鱼塘。",
        ),
      );
    }

    // ── 右下角 🐟（原功能） ───────────────────────────────────────────
    function mountButton() {
      if (typeof document === "undefined") return;
      if (document.getElementById("fishpond-open-btn")) return;
      if (!document.body) return;
      const btn = document.createElement("button");
      btn.id = "fishpond-open-btn";
      btn.type = "button";
      btn.title = "打开鱼塘（设置 → 鱼塘 可调它的作息）";
      btn.textContent = "🐟";
      btn.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "z-index:2147483000",
        "width:44px",
        "height:44px",
        "border-radius:50%",
        "border:1px solid rgba(58,160,245,.35)",
        "background:linear-gradient(135deg,#e6f3ff,#f7fbff)",
        "font-size:20px",
        "cursor:pointer",
        "box-shadow:0 6px 18px rgba(58,160,245,.25)",
        "display:flex",
        "align-items:center",
        "justify-content:center",
      ].join(";");
      btn.addEventListener("click", () => {
        window.open(SITE, "_blank", "noopener");
      });
      document.body.appendChild(btn);
    }

    function safeMount() {
      try {
        mountButton();
      } catch (e) {
        console.warn("dsh-fishpond: mount failed", e);
      }
    }

    // ── 插件生命周期 ──────────────────────────────────────────────────
    function apply(ctx) {
      // 右下角入口
      try {
        if (ctx && typeof ctx.effect === "function") {
          ctx.effect(() => {
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", safeMount, {
                once: true,
              });
            } else {
              safeMount();
            }
            return () => {
              const el = document.getElementById("fishpond-open-btn");
              if (el && el.parentNode) el.parentNode.removeChild(el);
            };
          }, "dsh-fishpond: open button");
        } else {
          safeMount();
        }
      } catch (e) {
        console.warn("dsh-fishpond: open button failed", e);
      }

      // 设置 → 鱼塘
      try {
        if (ctx && typeof ctx.slots === "object" && ctx.slots) {
          ctx.effect(
            () =>
              ctx.slots.inject("settings.section", () =>
                ctx.slots.register(
                  {
                    name: "settings.section",
                    id: "fishpond",
                    order: 25,
                    label: () => "鱼塘",
                  },
                  FishpondSection,
                ),
              ),
            "dsh-fishpond: settings section",
          );
        } else {
          console.warn(
            "dsh-fishpond: slots service unavailable, settings section skipped",
          );
        }
      } catch (e) {
        console.warn("dsh-fishpond: settings section failed", e);
      }
    }

    exports.name = "dsh-fishpond";
    exports.apply = apply;
    exports.inject = ["slots"];
    exports.FishpondSection = FishpondSection;
    return module.exports;
  },
});
