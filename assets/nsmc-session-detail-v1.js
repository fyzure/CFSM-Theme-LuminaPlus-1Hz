(() => {
  if (window.__CFSM_NSMC_DETAIL_STATUS__) return;
  window.__CFSM_NSMC_DETAIL_STATUS__ = true;

  const ROW_ATTR = "data-nsmc-session-status";
  const REFRESH_MS = 60_000;
  const STALE_MS = 45 * 60_000;

  let cachedServerId = "";
  let cachedStatus = null;
  let inFlight = null;
  let observer = null;

  const serverIdFromPath = () => {
    const match = window.location.pathname.match(/^\/server\/([^/?#]+)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  const apiBase = () => {
    const raw = document.querySelector('meta[name="apiBase"]')?.content?.trim() || "";
    const first = raw.split(",").map((item) => item.trim()).find(Boolean);
    if (!first) return window.location.origin;
    try {
      return new URL(first, window.location.href).origin;
    } catch {
      return window.location.origin;
    }
  };

  const normalizeTimestamp = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number < 10_000_000_000 ? number * 1000 : number;
  };

  const ageText = (checkedAt) => {
    if (!checkedAt) return "";
    const ageMs = Math.max(0, Date.now() - checkedAt);
    if (ageMs < 90_000) return "刚刚检查";
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} 分钟前检查`;
    return `${Math.floor(ageMs / 3_600_000)} 小时前检查`;
  };

  const formatStatus = (status) => {
    const checkedAt = normalizeTimestamp(status.checkedAt);
    const stale = !checkedAt || Date.now() - checkedAt > STALE_MS;
    let label = "检查异常";

    if (stale) label = "状态过期";
    else if (status.state === "valid") label = "有效";
    else if (status.state === "auth_required") label = "需重新登录";
    else if (status.state === "error") label = "检查异常";

    return [label, status.account, ageText(checkedAt)].filter(Boolean).join(" · ");
  };

  const findSystemGroup = () => {
    for (const group of document.querySelectorAll(".instance-info-group")) {
      const title = group.querySelector(".instance-info-group-title")?.textContent?.trim();
      if (title === "系统") return group;
    }
    return null;
  };

  const render = () => {
    const existing = document.querySelector(`[${ROW_ATTR}]`);
    const serverId = serverIdFromPath();
    if (!serverId || !cachedStatus || cachedStatus.serverId !== serverId) {
      existing?.remove();
      return;
    }

    const group = findSystemGroup();
    if (!group) return;

    const row = existing || document.createElement("div");
    row.className = "instance-info-item";
    row.setAttribute(ROW_ATTR, "true");

    let label = row.querySelector(".instance-info-label");
    let value = row.querySelector(".instance-info-value");
    if (!label || !value) {
      row.replaceChildren();
      label = document.createElement("span");
      label.className = "instance-info-label";
      label.textContent = "NSMC Session";
      value = document.createElement("div");
      value.className = "instance-info-value";
      row.append(label, value);
    }
    const nextText = formatStatus(cachedStatus);
    if (value.textContent !== nextText) value.textContent = nextText;

    if (!existing || existing.parentElement !== group) {
      const statusRow = [...group.querySelectorAll(".instance-info-item")].find(
        (item) => item.querySelector(".instance-info-label")?.textContent?.trim() === "状态",
      );
      if (statusRow?.nextSibling) group.insertBefore(row, statusRow.nextSibling);
      else group.appendChild(row);
    }
  };

  const refresh = async () => {
    const serverId = serverIdFromPath();
    if (!serverId) {
      cachedServerId = "";
      cachedStatus = null;
      render();
      return;
    }
    if (inFlight) return inFlight;

    cachedServerId = serverId;
    const url = `${apiBase()}/api/server?id=${encodeURIComponent(serverId)}`;
    inFlight = fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cachedServerId !== serverId) return;
        const state = String(data?.nsmc_session_state || "").trim().toLowerCase();
        cachedStatus = state
          ? {
              serverId,
              state,
              account: String(data?.nsmc_session_account || "").trim(),
              checkedAt: data?.nsmc_session_checked_at,
            }
          : null;
        render();
      })
      .catch(() => {
        if (cachedServerId === serverId && cachedStatus) render();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const scheduleRefresh = () => queueMicrotask(() => void refresh());

  const start = () => {
    observer = new MutationObserver(() => render());
    observer.observe(document.body, { childList: true, subtree: true });

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        scheduleRefresh();
        return result;
      };
    }
    window.addEventListener("popstate", scheduleRefresh, { passive: true });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) scheduleRefresh();
      },
      { passive: true },
    );

    setInterval(() => {
      if (!document.hidden && serverIdFromPath()) void refresh();
    }, REFRESH_MS);
    scheduleRefresh();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
