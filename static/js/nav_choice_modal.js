// Token Depot / OMA primary nav choice modal.
// Intercepts normal Deploy and Issue nav clicks and lets the user choose L1 KCC20 or L2 KRC20 without widening the menu.
(function () {
  const MODAL_ID = "tdNavChoiceModal";
  const STYLE_ID = "tdNavChoiceModalStyle";

  const CHOICES = {
    deploy: {
      title: "Choose Deploy App",
      body: "Select the token standard you want to deploy.",
      options: [
        { label: "L1 — KCC20", detail: "Deploy an OMA L1 covenant-backed token.", href: "/kcc20-deploy.html" },
        { label: "L2 — KRC20", detail: "Deploy a standard KRC-20 token.", href: "/deploy.html" },
        {
          label: "L1 — KCC20 Compliance Regulated",
          detail: "Testnet-10 evaluation workspace. Mainnet requires a licensed MSB/fintech, dedicated infrastructure, and a Token Depot software lease.",
          href: "/kcc20-regulated-deploy.html"
        }
      ]
    },
    issue: {
      title: "Choose Issue / Burn App",
      body: "Select the token standard you want to issue or burn.",
      options: [
        { label: "L1 — KCC20", detail: "Issue or burn OMA L1 covenant-backed tokens.", href: "/kcc20-issue.html" },
        { label: "L2 — KRC20", detail: "Issue or burn standard KRC-20 tokens.", href: "/issue.html" }
      ]
    }
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .td-nav-choice-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background: rgba(var(--td-skin-black-rgb, 2, 8, 20), 0.72);
        backdrop-filter: blur(8px);
      }
      .td-nav-choice-dialog {
        width: min(94vw, 440px);
        border: 1px solid rgba(var(--td-skin-border-rgb, 125, 252, 255), 0.92);
        border-radius: 18px;
        padding: 1.1rem;
        color: var(--td-skin-text, #f4fbff) !important;
        background:
          radial-gradient(circle at top left, rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.20), rgba(var(--td-skin-panel-rgb, 15, 23, 42), 0.96)),
          linear-gradient(135deg, rgba(var(--td-skin-panel-rgb, 15, 23, 42), 0.96), rgba(var(--td-skin-black-rgb, 0, 0, 0), 0.90));
        box-shadow:
          0 0 0 1px rgba(var(--td-skin-panel-rgb, 15, 23, 42), 0.62),
          0 0 34px rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.36),
          0 20px 70px rgba(var(--td-skin-black-rgb, 0, 0, 0), 0.42);
      }
      .td-nav-choice-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 0.85rem;
      }
      .td-nav-choice-title {
        margin: 0 0 0.25rem;
        color: var(--td-skin-text-strong, #f4fbff) !important;
        font-weight: 800;
        font-size: 1.05rem;
        text-shadow: 0 0 10px rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.22);
      }
      .td-nav-choice-body {
        margin: 0;
        color: var(--td-skin-text-soft, #cfe4ff) !important;
        font-size: 0.9rem;
      }
      .td-nav-choice-close {
        border: 1px solid rgba(var(--td-skin-primary-hover-rgb, 103, 232, 249), 0.86);
        border-radius: 999px;
        padding: 0.45rem 0.95rem;
        min-width: 4.35rem;
        min-height: 2rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--td-skin-primary, #22d3ee) !important;
        color: var(--td-skin-button-text, #f9fbff) !important;
        font-weight: 800;
        font-size: 0.78rem;
        letter-spacing: 0.02em;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 0 14px rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.28);
      }
      .td-nav-choice-close:hover,
      .td-nav-choice-close:focus {
        background: var(--td-skin-primary-hover, #67e8f9) !important;
        color: var(--td-skin-button-text, #f9fbff) !important;
        border-color: rgba(var(--td-skin-primary-hover-rgb, 103, 232, 249), 0.98);
        box-shadow: 0 0 18px rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.42);
        outline: none;
      }
      .td-nav-choice-options {
        display: grid;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      .td-nav-choice-option {
        display: block;
        padding: 0.9rem 1rem;
        border: 1px solid rgba(var(--td-skin-border-rgb, 125, 252, 255), 0.68);
        border-radius: 14px;
        color: var(--td-skin-text, #f4fbff) !important;
        background: rgba(var(--td-skin-panel-rgb, 15, 23, 42), 0.72);
        text-decoration: none;
      }
      .td-nav-choice-option:hover,
      .td-nav-choice-option:focus {
        border-color: rgba(var(--td-skin-primary-hover-rgb, 103, 232, 249), 0.98);
        background: rgba(var(--td-skin-panel-rgb, 15, 23, 42), 0.88);
        box-shadow: 0 0 18px rgba(var(--td-skin-primary-glow-rgb, 56, 189, 248), 0.30);
        outline: none;
      }
      .td-nav-choice-option strong {
        display: block;
        margin-bottom: 0.2rem;
        color: var(--td-skin-text-strong, #f4fbff) !important;
      }
      .td-nav-choice-option span {
        display: block;
        color: var(--td-skin-text-soft, #cfe4ff) !important;
        font-size: 0.85rem;
        line-height: 1.35;
      }
    `;
    document.head.appendChild(style);
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
  }

  function openModal(kind) {
    const cfg = CHOICES[kind];
    if (!cfg) return;
    ensureStyle();
    closeModal();

    const backdrop = document.createElement("div");
    backdrop.id = MODAL_ID;
    backdrop.className = "td-nav-choice-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", cfg.title);

    const dialog = document.createElement("div");
    dialog.className = "td-nav-choice-dialog";
    dialog.innerHTML = `
      <div class="td-nav-choice-head">
        <div>
          <h2 class="td-nav-choice-title"></h2>
          <p class="td-nav-choice-body"></p>
        </div>
        <button class="td-nav-choice-close" type="button" aria-label="Close">CLOSE</button>
      </div>
      <div class="td-nav-choice-options"></div>
    `;

    dialog.querySelector(".td-nav-choice-title").textContent = cfg.title;
    dialog.querySelector(".td-nav-choice-body").textContent = cfg.body;
    const opts = dialog.querySelector(".td-nav-choice-options");
    cfg.options.forEach((opt) => {
      const a = document.createElement("a");
      a.className = "td-nav-choice-option";
      a.href = opt.href;
      a.innerHTML = `<strong></strong><span></span>`;
      a.querySelector("strong").textContent = opt.label;
      a.querySelector("span").textContent = opt.detail;
      opts.appendChild(a);
    });

    dialog.querySelector(".td-nav-choice-close").addEventListener("click", closeModal);
    backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) closeModal(); });
    document.addEventListener("keydown", function onKey(ev) {
      if (ev.key === "Escape") {
        closeModal();
        document.removeEventListener("keydown", onKey);
      }
    });

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const first = backdrop.querySelector(".td-nav-choice-option");
    if (first) first.focus();
  }

  function shouldIntercept(ev) {
    return ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
  }

  function wire() {
    document.querySelectorAll('a[href="/deploy.html"]').forEach((a) => {
      a.addEventListener("click", (ev) => {
        if (!shouldIntercept(ev)) return;
        ev.preventDefault();
        openModal("deploy");
      });
    });
    document.querySelectorAll('a[href="/issue.html"]').forEach((a) => {
      a.addEventListener("click", (ev) => {
        if (!shouldIntercept(ev)) return;
        ev.preventDefault();
        openModal("issue");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
