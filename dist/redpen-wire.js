(() => {
  // src/mark.js
  var CLAY = "no-save no-snapshot no-watch";
  var BARE = ["no-save", "no-snapshot", "no-watch"];
  function mark(node) {
    node.setAttribute("sap-ignore", "");
    node.setAttribute("clay", CLAY);
    for (const token of BARE) node.setAttribute(token, "");
    return node;
  }
  function chrome(node) {
    node.dataset.laUi = "1";
    return mark(node);
  }

  // src/wire.js
  var STYLES = `
  .rprWire { position: fixed; left: 14px; bottom: 14px; z-index: 99995; display: flex; align-items: center; gap: 8px;
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11.5px; letter-spacing: .06em;
    max-width: min(420px, calc(100vw - 28px));
    background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2); border-radius: 7px; padding: 5px 8px; }
  .rprWire[hidden] { display: none; }
  .rprWire .rprWireDot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ink-faint, #8A857E); }
  .rprWire.working .rprWireDot { background: var(--flag, #e5484d); animation: rprWirePulse 1.1s ease-in-out infinite; }
  .rprWire.done .rprWireDot { background: #2f9e44; }
  .rprWire.error .rprWireDot { background: var(--flag, #e5484d); }
  .rprWire .rprWireText { color: var(--ink, #17110C); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprWire button { font: inherit; letter-spacing: inherit; color: var(--ink-faint, #8A857E); background: none;
    border: 0; border-radius: 5px; padding: 2px 6px; cursor: pointer; }
  .rprWire button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }
  @keyframes rprWirePulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
`;
  var attached = null;
  var WORKING = /* @__PURE__ */ new Set(["sent", "acked", "landing"]);
  var CANCELLABLE = /* @__PURE__ */ new Set(["sent", "acked"]);
  var LABEL = {
    sent: "sending to the agent",
    acked: "the agent is working",
    landing: "waiting for the change",
    done: "done",
    cancelled: "cancelled"
  };
  function injectStyles() {
    if (document.getElementById("rprWireStyle")) return;
    const style = mark(document.createElement("style"));
    style.id = "rprWireStyle";
    style.textContent = STYLES;
    document.head.prepend(style);
  }
  function nearestKey(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const dataId = node.getAttribute("data-id");
      const id = node.getAttribute("id");
      if (dataId) return { key: dataId, selector: `[data-id="${CSS.escape(dataId)}"]`, tag: node.tagName.toLowerCase() };
      if (id) return { key: id, selector: `#${CSS.escape(id)}`, tag: node.tagName.toLowerCase() };
    }
    return null;
  }
  function payloadFor(item, projection) {
    const selector = item.anchor && item.anchor.selector;
    const el = selector ? document.querySelector(selector) : null;
    return {
      kind: "comment",
      page: projection.page,
      said: item.said,
      item,
      ...item.target_id ? { target: (projection.targets || {})[item.target_id] || null } : projection.coords ? { coords: projection.coords } : {},
      ...el ? { region: nearestKey(el) } : {}
    };
  }
  function attach(review, opts = {}) {
    const wire = window.clay && window.clay.wire;
    if (!wire || typeof wire.send !== "function" || typeof wire.on !== "function") {
      console.warn("[redpen] no clay.wire on this page: comments stay in the clipboard");
      return null;
    }
    if (attached) {
      console.warn("[redpen] the wire is already attached to this page");
      return attached;
    }
    injectStyles();
    const pill = chrome(document.createElement("div"));
    pill.className = "rprWire";
    pill.hidden = true;
    const dot = document.createElement("span");
    dot.className = "rprWireDot";
    const text = document.createElement("span");
    text.className = "rprWireText";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "cancel";
    pill.append(dot, text, cancelBtn);
    document.body.appendChild(pill);
    let showing = null;
    let clearTimer = null;
    function render(rec) {
      if (!rec) return;
      showing = rec;
      clearTimeout(clearTimer);
      const working = WORKING.has(rec.state);
      pill.hidden = false;
      pill.classList.toggle("working", working);
      pill.classList.toggle("done", rec.state === "done");
      pill.classList.toggle("error", rec.state === "error");
      text.textContent = rec.state === "error" ? rec.error || "the agent failed" : CANCELLABLE.has(rec.state) && rec.text || LABEL[rec.state] || rec.state;
      cancelBtn.hidden = !CANCELLABLE.has(rec.state);
      if (rec.state === "done" || rec.state === "cancelled") {
        clearTimer = setTimeout(() => {
          pill.hidden = true;
          showing = null;
        }, 2500);
      }
    }
    const off = wire.on((rec) => {
      if (!showing || rec.id === showing.id || !WORKING.has(showing.state)) render(rec);
    });
    cancelBtn.addEventListener("click", () => {
      if (showing && CANCELLABLE.has(showing.state)) wire.cancel(showing.id);
    });
    const send = (item, projection) => {
      const handle = wire.send(payloadFor(item, projection), { text: item.said });
      render({ id: handle.id, state: "sent", text: "", error: null });
      return handle;
    };
    const offComment = review.onComment(typeof opts.onComment === "function" ? opts.onComment : send);
    attached = {
      send,
      detach() {
        off();
        offComment();
        clearTimeout(clearTimer);
        pill.remove();
        document.getElementById("rprWireStyle")?.remove();
        attached = null;
      }
    };
    return attached;
  }

  // src/index-wire.js
  if (!window.RedpenWire) window.RedpenWire = { attach };
})();
