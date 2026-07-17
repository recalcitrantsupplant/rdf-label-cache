// Self-contained "before → Use label cache → after" widget.
// No deps. Themed entirely via CSS custom properties the host page defines
// (--bg --fg --muted --faint --line --panel --accent --accent-soft --good --mono).
// Usage:  LabelCacheDemo.mount(document.getElementById("demo"));
(function () {
  // Predicate / class CURIE -> full IRI. Labels are resolved from the live API.
  const IRI = {
    "rdf:type":            "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    "schema:Person":       "https://schema.org/Person",
    "schema:Organization": "https://schema.org/Organization",
    "schema:name":         "https://schema.org/name",
    "schema:jobTitle":     "https://schema.org/jobTitle",
    "schema:worksFor":     "https://schema.org/worksFor",
    "schema:url":          "https://schema.org/url",
  };
  // The graph, as data. `name` is a label the record supplies itself (in your data).
  const GRAPH = [
    { id: "ex:jane", name: "Jane Doe", type: "schema:Person", props: [
      ["schema:jobTitle", { lit: "Data Architect" }],
      ["schema:worksFor", { ref: "ex:acme" }],
    ]},
    { id: "ex:acme", name: "ACME Corp", type: "schema:Organization", props: [
      ["schema:url", { lit: "acme.example.org" }],
    ]},
  ];
  const RAW = `@prefix schema: <https://schema.org/> .
@prefix ex:     <https://example.org/> .

ex:jane a schema:Person ;
    schema:name     "Jane Doe" ;
    schema:jobTitle "Data Architect" ;
    schema:worksFor ex:acme .

ex:acme a schema:Organization ;
    schema:name "ACME Corp" ;
    schema:url  "https://acme.example.org" .`;

  const css = `
  .lc { display: grid; grid-template-columns: 11fr 9fr; gap: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--bg); }
  @media (max-width: 720px){ .lc { grid-template-columns: 1fr; } }
  .lc-main { min-width: 0; }
  .lc-side { border-left: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-width: 0; }
  @media (max-width: 720px){ .lc-side { border-left: 0; border-top: 1px solid var(--line); } }
  .lc-bar { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .lc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; font-size: 12px; }
  .lc-seg button { border: 0; background: var(--bg); color: var(--fg); padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  .lc-seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .lc-hint { font-size: 12px; color: var(--muted); margin-left: auto; }
  .lc-body { padding: 14px 16px; overflow: auto; }
  pre.lc-raw { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; white-space: pre; overflow-x: auto; color: var(--fg); }
  pre.lc-raw .p { color: var(--muted); } pre.lc-raw .s { color: var(--accent); } pre.lc-raw .l { color: var(--good); } pre.lc-raw .i { color: var(--faint); }
  .lc-rec { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 12px; background: var(--bg); }
  .lc-rec:last-child { margin-bottom: 0; }
  .lc-rh { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; flex-wrap: wrap; }
  .lc-name { font-weight: 600; font-size: 15px; }
  .lc-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .lc-rows { display: grid; grid-template-columns: minmax(90px, max-content) 1fr; gap: 5px 16px; font-size: 13.5px; }
  .lc-k { color: var(--muted); }
  .term { font-family: var(--mono); font-size: 12.5px; color: var(--muted); transition: color .25s; }
  .term.done { font-family: var(--sans, system-ui); font-size: 13.5px; color: var(--fg); border-bottom: 1px dotted var(--faint); cursor: help; }
  .term.flash { color: var(--accent); }
  .lc-local { border-bottom: 1px dashed var(--accent); cursor: help; }
  .lc-lit { color: var(--good); }
  .lc-cta { padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .lc-btn { width: 100%; font: inherit; font-weight: 600; font-size: 14px; padding: 10px 14px; border-radius: 9px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .lc-btn:disabled { opacity: .55; cursor: default; }
  .lc-btn.reset { background: var(--bg); color: var(--accent); }
  .lc-side-h { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 700; padding: 12px 16px 6px; }
  .lc-net { padding: 0 12px 14px; display: flex; flex-direction: column; gap: 5px; overflow: auto; flex: 1; }
  .lc-empty { color: var(--faint); font-size: 12.5px; padding: 4px 4px 10px; }
  .lc-call { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); font-family: var(--mono); font-size: 11.5px; opacity: 0; transform: translateY(4px); animation: lc-in .28s forwards; text-decoration: none; color: inherit; cursor: pointer; }
  @keyframes lc-in { to { opacity: 1; transform: none; } }
  .lc-call:hover { border-color: var(--accent); }
  .lc-call:hover .u, .lc-call:hover .lc-open { color: var(--accent); }
  .lc-call .m { color: var(--accent); font-weight: 700; flex-shrink: 0; }
  .lc-call .u { color: var(--faint); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lc-open { color: var(--faint); flex-shrink: 0; font-size: 11px; }
  .lc-pill { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; cursor: help; }
  .lc-pill.cdn { background: #dcfce7; color: #166534; }
  .lc-pill.origin { background: #fef3c7; color: #92400e; }
  .lc-pill.browser { background: var(--code, #f3f4f6); color: var(--faint); }
  @media (prefers-color-scheme: dark){
    .lc-pill.cdn { background: #10331d; color: #4ade80; }
    .lc-pill.origin { background: #3a2e12; color: #fbbf24; }
  }
  .lc-legend { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; }
  .lc-legend span.lbl { color: var(--muted); }
  .lc-ms { color: var(--faint); flex-shrink: 0; }
  .lc-sum { margin-top: auto; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .lc-sum b { color: var(--good); }
  .lc-foot { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.55; }
  .lc-foot code { font-family: var(--mono); font-size: .92em; background: var(--code, #f3f4f6); padding: 0 4px; border-radius: 3px; }
  .lc-foot b { color: var(--fg); font-weight: 600; }
  `;

  function esc(s){ return s.replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
  // Tokenize Turtle, then wrap - never regex-over-HTML (that matched the quotes in class="…").
  function highlightTtl(t){
    const re = /(@prefix)|("(?:[^"\\]|\\.)*")|(<[^>]*>)|\b(a)\b|([A-Za-z][\w.-]*:[\w.-]*)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(t))){
      out += esc(t.slice(last, m.index));
      if (m[1]) out += `<span class="p">@prefix</span>`;
      else if (m[2]) out += `<span class="l">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="i">${esc(m[3])}</span>`;
      else if (m[4]) out += `<span class="p">a</span>`;
      else if (m[5]) out += `<span class="s">${esc(m[5])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(t.slice(last));
  }

  function build(root){
    root.innerHTML = "";
    const style = document.createElement("style"); style.textContent = css; root.append(style);
    const wrap = document.createElement("div"); wrap.className = "lc"; root.append(wrap);

    const main = document.createElement("div"); main.className = "lc-main";
    const bar = document.createElement("div"); bar.className = "lc-bar";
    bar.innerHTML = `<span class="lc-seg"><button data-v="rdf" class="on">Raw RDF</button><button data-v="rendered">Rendered</button></span><span class="lc-hint">the IRIs your query returns</span>`;
    const body = document.createElement("div"); body.className = "lc-body";
    main.append(bar, body);

    const side = document.createElement("div"); side.className = "lc-side";
    side.innerHTML = `<div class="lc-cta"><button class="lc-btn" id="lc-go">⚡ Get labels</button></div>
      <div class="lc-side-h">Network · GET /label</div>
      <div class="lc-net" id="lc-net"><div class="lc-empty">No calls yet. Hit the button - one edge-cached GET per unique IRI.</div></div>
      <div class="lc-sum" id="lc-sum" style="display:none"></div>`;
    wrap.append(main, side);

    // ----- render the graph (terms start as opaque CURIEs) -----
    const termEls = new Map(); // curie -> [els]
    function term(curie){
      const s = document.createElement("span"); s.className = "term"; s.textContent = curie; s.dataset.curie = curie;
      if (!termEls.has(curie)) termEls.set(curie, []);
      termEls.get(curie).push(s);
      return s;
    }
    function renderGraph(){
      body.innerHTML = "";
      termEls.clear();
      for (const r of GRAPH){
        const rec = document.createElement("div"); rec.className = "lc-rec";
        const h = document.createElement("div"); h.className = "lc-rh";
        const nm = document.createElement("span"); nm.className = "lc-name lc-local"; nm.textContent = r.name;
        nm.title = r.id + "\n\n(name from your data - not fetched)";
        const badge = document.createElement("span"); badge.className = "lc-badge"; badge.append(term(r.type));
        h.append(nm, badge); rec.append(h);
        const rows = document.createElement("div"); rows.className = "lc-rows";
        for (const [pred, obj] of r.props){
          const k = document.createElement("div"); k.className = "lc-k"; k.append(term(pred)); rows.append(k);
          const v = document.createElement("div");
          if (obj.lit){ const l = document.createElement("span"); l.className = "lc-lit"; l.textContent = "“"+obj.lit+"”"; v.append(l); }
          else { const ref = GRAPH.find(g => g.id === obj.ref); const s = document.createElement("span"); s.className = "lc-local"; s.textContent = ref ? ref.name : obj.ref; s.title = obj.ref + "\n\n(name from your data)"; v.append(s); }
          rows.append(v);
        }
        rec.append(rows); body.append(rec);
      }
    }
    function renderRaw(){ body.innerHTML = `<pre class="lc-raw">${highlightTtl(RAW)}</pre>`; }

    // ----- view toggle -----
    let view = "rdf";
    function setView(v){ view = v; bar.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v)); v === "rdf" ? renderRaw() : renderGraph(); }
    bar.querySelectorAll("button").forEach(b => b.addEventListener("click", () => setView(b.dataset.v)));

    // ----- resolve animation -----
    const net = side.querySelector("#lc-net");
    const sum = side.querySelector("#lc-sum");
    const go = side.querySelector("#lc-go");
    let resolved = false;
    function reset(){
      resolved = false;
      net.innerHTML = `<div class="lc-empty">No calls yet. Hit the button - one edge-cached GET per unique IRI.</div>`;
      sum.style.display = "none";
      go.className = "lc-btn"; go.disabled = false; go.innerHTML = "⚡ Get labels";
      setView("rendered");
    }
    function resolve(){
      if (resolved) { reset(); return; }
      resolved = true;
      setView("rendered");
      go.disabled = true; go.innerHTML = "resolving…";
      net.innerHTML = "";
      const uniq = [...new Set([...termEls.keys()])]; // dedup: schema:name appears twice -> one call
      Promise.all(uniq.map((curie) => resolveLabel(curie))).finally(() => {
        go.disabled = false; go.className = "lc-btn reset"; go.innerHTML = "↻ Reset";
        sum.style.display = "block";
        sum.innerHTML = `<b>Live, parallel requests - click any to open its raw JSON-LD.</b>
          <div class="lc-legend">
            <span><span class="lc-pill cdn">CDN HIT</span> <span class="lbl">edge cache, Worker skipped</span></span>
            <span><span class="lc-pill origin">MISS</span> <span class="lbl">Worker ran, read R2</span></span>
            <span><span class="lc-pill browser">BROWSER</span> <span class="lbl">your disk cache, 0 bytes on the wire</span></span>
          </div>`;
      });
    }

    async function resolveLabel(curie){
      const iri = IRI[curie];
      const untaggedHref = `/label?iri=${encodeURIComponent(iri)}`;
      let response = await fetchAndShow(untaggedHref, iri);
      if (!response.ok && response.status === 404) {
        response = await fetchAndShow(`${untaggedHref}&lang=en`, iri);
      }
      if (!response.ok) return;

      const doc = await response.json();
      const label = doc.prefLabel?.en || doc.prefLabel?.["@none"] || Object.values(doc.prefLabel || {})[0] || curie;
      for (const el of termEls.get(curie) || []) {
        el.textContent = label; el.className = "term done flash"; el.title = iri;
        setTimeout(() => el.classList.remove("flash"), 400);
      }
    }

    async function fetchAndShow(href, iri){
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(href);
        const elapsed = Math.round(performance.now() - requestStartedAt);
        appendNetworkRow(href, iri, await classifySource(href, response), elapsed);
        return response;
      } catch {
        const src = { tier: "origin", label: "network error", title: "The request failed before any response arrived." };
        appendNetworkRow(href, iri, src, Math.round(performance.now() - requestStartedAt));
        return new Response(null, { status: 599 });
      }
    }

    // The resource-timing entry finalizes at responseEnd (after the body), which
    // can lag a beat behind fetch() resolving on headers. Poll a couple of ticks.
    async function resourceTiming(href){
      const name = new URL(href, location.href).href;
      for (let i = 0; i < 3; i++){
        const entries = performance.getEntriesByName(name);
        const last = entries[entries.length - 1];
        if (last) return last;
        await new Promise((r) => setTimeout(r, 0));
      }
      return performance.getEntriesByName(name).slice(-1)[0];
    }

    // Where did this response REALLY come from? Cf-Cache-Status alone lies: a
    // browser disk-cache read replays the header captured at first fetch (often a
    // stale MISS), so a 2ms hit can read "MISS". transferSize === 0 is the ground
    // truth for browser-vs-network (0 bytes on the wire). Only when the network
    // was truly used do we trust Cf-Cache-Status to split edge-HIT from origin.
    async function classifySource(href, response){
      const cf = response.headers.get("Cf-Cache-Status") || "";
      const age = response.headers.get("Age");
      const entry = await resourceTiming(href);
      const fromBrowser = entry && (entry.transferSize === 0 || entry.deliveryType === "cache");
      if (fromBrowser) {
        return { tier: "browser", label: "BROWSER",
          title: "Served from your browser's own cache - 0 bytes crossed the network.\nMay be silently refreshing in the background (stale-while-revalidate).\nThe CDN status is replayed from the first fetch, so it means nothing here." };
      }
      if (cf === "HIT") {
        return { tier: "cdn", label: "CDN HIT",
          title: `Cloudflare edge cache HIT${age ? ` - cached ${age}s ago` : ""}.\nServed from the data center nearest you; the Worker never ran.` };
      }
      if (!response.ok) {
        return { tier: "origin", label: cf || `HTTP ${response.status}`,
          title: `Origin responded ${response.status}.` };
      }
      return { tier: "origin", label: cf || "MISS",
        title: "Edge cache MISS - the Worker ran and read R2, then populated this region's edge.\nThe next request in your region will be a CDN HIT." };
    }

    function appendNetworkRow(href, iri, source, elapsed){
      const row = document.createElement("a"); row.className = "lc-call";
      row.href = href; row.target = "_blank"; row.rel = "noopener";
      row.title = `GET /label?iri=${iri}\n\nOpens the raw JSON-LD from the label cache`;
      const method = document.createElement("span"); method.className = "m"; method.textContent = "GET";
      const url = document.createElement("span"); url.className = "u"; url.textContent = `?iri=${iri}`;
      const pill = document.createElement("span");
      pill.className = `lc-pill ${source.tier}`; pill.textContent = source.label; pill.title = source.title;
      const ms = document.createElement("span"); ms.className = "lc-ms"; ms.textContent = `${elapsed}ms`;
      const open = document.createElement("span"); open.className = "lc-open"; open.setAttribute("aria-hidden", "true"); open.textContent = "↗";
      row.append(method, url, pill, ms, open); net.append(row); net.scrollTop = net.scrollHeight;
    }
    go.addEventListener("click", resolve);

    setView("rdf"); // start on raw
    // pre-build rendered terms map even while showing raw
    renderGraph(); renderRaw();
    return { resolve, reset, setView };
  }

  window.LabelCacheDemo = { mount: build };
})();
