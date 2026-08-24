(() => {
  // src/wire.js
  var attached = null;
  var RUNNING = /* @__PURE__ */ new Set(["sent", "acked", "landing"]);
  function nearestKey(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const dataId = node.getAttribute("data-id");
      const id = node.getAttribute("id");
      if (dataId) return { key: dataId, selector: `[data-id="${CSS.escape(dataId)}"]`, tag: node.tagName.toLowerCase() };
      if (id) return { key: id, selector: `#${CSS.escape(id)}`, tag: node.tagName.toLowerCase() };
    }
    return null;
  }
  function decode(line) {
    const raw = String(line ?? "");
    if (raw.trimStart()[0] !== "{") return { kind: "progress", text: raw };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (/"redpen"\s*:/.test(raw)) return { kind: "mangled", text: raw };
      return { kind: "progress", text: raw };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "progress", text: raw };
    if (!Object.prototype.hasOwnProperty.call(parsed, "redpen")) return { kind: "progress", text: raw };
    if (typeof parsed.reply !== "string" || !parsed.reply) return { kind: "broken", text: raw };
    return { kind: "reply", text: parsed.reply, append: parsed.append === true };
  }
  function payloadFor(request) {
    const item = request.item || null;
    const projection = request.projection || {};
    const history = request.history || null;
    const { thread, ...bare } = item || {};
    const selector = item && item.anchor && item.anchor.selector;
    const el = selector ? document.querySelector(selector) : null;
    return {
      kind: "comment",
      page: projection.page,
      said: request.ask,
      ...request.turn > 1 ? { turn: request.turn } : {},
      ...history ? {
        thread: history.pairs,
        ...history.earlier ? { earlier: history.earlier } : {}
      } : {},
      item: item ? bare : null,
      // The coordinate rule travels with the item, because the item's geometry is
      // expressed in that rule and reads as fractions of the wrong box without it.
      ...item && item.target_id ? { target: (projection.targets || {})[item.target_id] || null } : projection.coords ? { coords: projection.coords } : {},
      ...el ? { region: nearestKey(el) } : {}
    };
  }
  function createTransport(wire) {
    let sink = null;
    let off = null;
    const mine = /* @__PURE__ */ new Set();
    function onFrame(rec, frame) {
      if (!sink || !mine.has(rec.id)) return;
      if (RUNNING.has(rec.state)) sink.state(rec.id, rec.state);
      const line = frame && typeof frame.text === "string" ? frame.text : rec.state === "acked" && rec.text ? rec.text : "";
      if (!line) return;
      const said = decode(line);
      if (said.kind === "reply") return void sink.reply(rec.id, said.text, { append: said.append });
      if (said.kind === "mangled") {
        sink.progress(rec.id, said.text);
        return void sink.note(rec.id, "the agent sent a reply that did not survive the trip");
      }
      if (said.kind === "broken") {
        sink.progress(rec.id, said.text);
        return void sink.note(rec.id, "the agent marked a reply that carried no words");
      }
      sink.progress(rec.id, said.text);
    }
    return {
      label: "agent",
      attach(s) {
        sink = s;
        off = wire.on(onFrame);
      },
      detach() {
        off?.();
        off = null;
        sink = null;
        mine.clear();
        if (attached && attached.transport === this) attached = null;
      },
      // redpen mints the id, because clayjs emits the first frame from inside
      // send(): a mapping built from the return value would be built too late to
      // route it.
      send(request) {
        const handle = wire.send(payloadFor(request), { id: request.id, text: request.ask });
        if (!handle || !handle.id) return null;
        mine.add(handle.id);
        handle.done.then(
          (final) => {
            mine.delete(handle.id);
            sink?.state(handle.id, final.state, final.error);
          },
          (err) => {
            mine.delete(handle.id);
            sink?.state(handle.id, "error", err && err.message ? err.message : "the wire failed");
          }
        );
        return { id: handle.id };
      },
      // clayjs refuses a cancel that arrived too late, so the rule lives there
      // rather than being restated here where the two could quietly disagree.
      cancel: (id) => wire.cancel(id)
    };
  }
  function attach(review, opts = {}) {
    const wire = window.clay && window.clay.wire;
    if (!wire || typeof wire.send !== "function" || typeof wire.on !== "function") {
      console.warn("[redpen] no clay.wire on this page: comments stay in the clipboard");
      return null;
    }
    if (attached) {
      if (attached.review !== review) console.warn("[redpen] the wire is already attached to this page");
      return attached;
    }
    const transport = opts.transport || createTransport(wire);
    const disconnect = review.thread.connect(transport);
    attached = {
      review,
      transport,
      send: (request) => transport.send(request),
      detach() {
        disconnect();
        attached = null;
      }
    };
    return attached;
  }

  // src/index-wire.js
  if (!window.RedpenWire) window.RedpenWire = { attach };
})();
