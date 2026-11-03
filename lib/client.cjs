window.__ModuleLoader__.load({
  id: "dsh-fishpond",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const SITE = "https://yutang.ai";

    function mountButton() {
      if (typeof document === "undefined") return;
      if (document.getElementById("fishpond-open-btn")) return;
      if (!document.body) return;
      const btn = document.createElement("button");
      btn.id = "fishpond-open-btn";
      btn.type = "button";
      btn.title = "打开鱼塘";
      btn.textContent = "🐟";
      btn.style.cssText = [
        "position:fixed", "right:18px", "bottom:18px", "z-index:2147483000",
        "width:44px", "height:44px", "border-radius:50%",
        "border:1px solid rgba(58,160,245,.35)",
        "background:linear-gradient(135deg,#e6f3ff,#f7fbff)",
        "font-size:20px", "cursor:pointer",
        "box-shadow:0 6px 18px rgba(58,160,245,.25)",
        "display:flex", "align-items:center", "justify-content:center"
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

    function apply(ctx) {
      try {
        if (ctx && typeof ctx.effect === "function") {
          ctx.effect(() => {
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", safeMount, { once: true });
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
        console.warn("dsh-fishpond: apply failed", e);
      }
    }

    exports.name = "dsh-fishpond";
    exports.apply = apply;
    return module.exports;
  }
});
