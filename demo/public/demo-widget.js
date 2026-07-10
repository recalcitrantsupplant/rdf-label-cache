// Self-contained "before → Use label cache → after" widget.
// No deps. Themed entirely via CSS custom properties the host page defines
// (--bg --fg --muted --faint --line --panel --accent --accent-soft --good --mono).
// Usage:  LabelCacheDemo.mount(document.getElementById("demo"));
(function () {
  // Predicate / class CURIE -> [full IRI, cached label]. These are the CDN lookups.
  const IRI = {
    "rdf:type":            ["http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "type"],
    "schema:Person":       ["https://schema.org/Person", "Person"],
    "schema:Organization": ["https://schema.org/Organization", "Organization"],
    "schema:name":         ["https://schema.org/name", "Name"],
    "schema:jobTitle":     ["https://schema.org/jobTitle", "Job Title"],
    "schema:worksFor":     ["https://schema.org/worksFor", "Works For"],
    "schema:url":          ["https://schema.org/url", "URL"],
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

  // Deterministic-looking latencies (no Math.random — keeps it stable/replayable).
  const MS = [19, 24, 31, 22, 17, 28, 21];

  const css = `
  .lc { display: grid; grid-template-columns: 1fr 340px; gap: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--bg); }
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
  .lc-pill { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }
  .lc-pill.hit { background: #dcfce7; color: #166534; } .lc-pill.miss { background: var(--code, #f3f4f6); color: var(--faint); }
  @media (prefers-color-scheme: dark){ .lc-pill.hit { background: #10331d; color: #4ade80; } }
  .lc-ms { color: var(--faint); flex-shrink: 0; }
  .lc-sum { margin-top: auto; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .lc-sum b { color: var(--good); }
  .lc-foot { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.55; }
  .lc-foot code { font-family: var(--mono); font-size: .92em; background: var(--code, #f3f4f6); padding: 0 4px; border-radius: 3px; }
  .lc-foot b { color: var(--fg); font-weight: 600; }
  `;

  function esc(s){ return s.replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
  // Tokenize Turtle, then wrap — never regex-over-HTML (that matched the quotes in class="…").
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
    side.innerHTML = `<div class="lc-cta"><button class="lc-btn" id="lc-go">⚡ Use label cache</button></div>
      <div class="lc-side-h">Network · GET /label</div>
      <div class="lc-net" id="lc-net"><div class="lc-empty">No calls yet. Hit the button — one edge-cached GET per unique IRI.</div></div>
      <div class="lc-sum" id="lc-sum" style="display:none"></div>`;
    wrap.append(main, side);

    const foot = document.createElement("div"); foot.className = "lc-foot";
    foot.innerHTML = `Shown one-by-one so you can watch each IRI become a label — <b>your app doesn't wait like this.</b> In production you fire all of them together (one <code>Promise.all</code> of independent, edge-cached <code>GET</code>s), so the whole set lands in ~tens of ms. <b>Click any request</b> to open its raw JSON-LD from the cache.`;
    root.append(foot);

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
      for (const r of GRAPH){
        const rec = document.createElement("div"); rec.className = "lc-rec";
        const h = document.createElement("div"); h.className = "lc-rh";
        const nm = document.createElement("span"); nm.className = "lc-name lc-local"; nm.textContent = r.name;
        nm.title = r.id + "\n\n(name from your data — not fetched)";
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
    let resolved = false, timers = [];
    function reset(){
      timers.forEach(clearTimeout); timers = [];
      resolved = false;
      net.innerHTML = `<div class="lc-empty">No calls yet. Hit the button — one edge-cached GET per unique IRI.</div>`;
      sum.style.display = "none";
      go.className = "lc-btn"; go.disabled = false; go.innerHTML = "⚡ Use label cache";
      setView("rendered");
    }
    function resolve(){
      if (resolved) { reset(); return; }
      resolved = true;
      setView("rendered");
      go.disabled = true; go.innerHTML = "resolving…";
      net.innerHTML = "";
      const uniq = [...new Set([...termEls.keys()])]; // dedup: schema:name appears twice -> one call
      let i = 0;
      // Reveal one at a time — clearest way to see each IRI become a label.
      // (The footnote makes clear that in production you'd fire them all at once.)
      uniq.forEach((curie, idx) => {
        const t = setTimeout(() => {
          const [iri, label] = IRI[curie];
          const ms = MS[idx % MS.length];
          // network row — a live link to the raw JSON-LD
          const row = document.createElement("a"); row.className = "lc-call";
          row.href = `/label?iri=${encodeURIComponent(iri)}&lang=en`;
          row.target = "_blank"; row.rel = "noopener";
          row.title = `GET /label?iri=${iri}\n\nOpens the raw JSON-LD from the label cache`;
          row.innerHTML = `<span class="m">GET</span><span class="u">?iri=${curie}</span><span class="lc-pill hit">HIT</span><span class="lc-ms">${ms}ms</span><span class="lc-open" aria-hidden="true">↗</span>`;
          net.append(row); net.scrollTop = net.scrollHeight;
          // swap the term(s) on the left
          for (const el of termEls.get(curie)){
            el.textContent = label; el.className = "term done flash"; el.title = iri;
            setTimeout(() => el.classList.remove("flash"), 400);
          }
          if (++i === uniq.length){
            go.disabled = false; go.className = "lc-btn reset"; go.innerHTML = "↻ Reset";
            sum.style.display = "block";
            sum.innerHTML = `<b>${uniq.length} labels resolved</b> · ${uniq.length} edge GETs, all cache <b>HIT</b> · triplestore untouched · <b>Jane Doe</b> &amp; <b>ACME Corp</b> came from your data (0 fetches).`;
          }
        }, 260 + idx * 240);
        timers.push(t);
      });
    }
    go.addEventListener("click", resolve);

    setView("rdf"); // start on raw
    // pre-build rendered terms map even while showing raw
    renderGraph(); renderRaw();
    return { resolve, reset, setView };
  }

  window.LabelCacheDemo = { mount: build };
})();
