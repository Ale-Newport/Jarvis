/*
 * In-page runtime installed once per document (Page.addScriptToEvaluateOnNewDocument).
 *
 * The observation model, node identity cache, freshness markers (pageKey / guard / marker) and the
 * visibility rules are derived from jev-ultrafast's snapshot.js (MIT, Copyright (c) 2026 Browser Use) and
 * laya-ultrafast. Extensions here: open shadow roots, same-origin iframes, hrefs, payment-field exclusion,
 * content extraction (links / images / text) and mutation-aware settling.
 *
 * Nothing here executes model output: the model only ever names an observed node id.
 */
(() => {
  const VERSION = 9;
  if (window.__jarvis && window.__jarvis.version === VERSION) return true;
  const J = (window.__jarvis = {version: VERSION, ids: new WeakMap(), nodes: new Map(), proxy: new WeakMap(), next: 1});

  // ---------------------------------------------------------------------------------------------- identity
  const identity = e => {
    if (!J.ids.has(e)) J.ids.set(e, J.next++);
    const id = J.ids.get(e);
    J.nodes.set(id, e);
    return id;
  };
  const gc = () => { for (const [id, e] of J.nodes) if (!e.isConnected) J.nodes.delete(id); };

  // ------------------------------------------------------------------------------- DOM traversal helpers
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'CANVAS']);
  // Every element matching `sel` below `root`, descending into open shadow roots.
  const deep = (root, sel, out = []) => {
    for (const e of root.querySelectorAll(sel)) out.push(e);
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) deep(h.shadowRoot, sel, out);
    return out;
  };
  // Same-origin frames only; a cross-origin contentDocument is null or throws.
  const frameDoc = f => { try { return f.contentDocument && f.contentDocument.documentElement ? f.contentDocument : null; } catch { return null; } };
  const frameOffset = e => {
    let ox = 0, oy = 0, w = e.ownerDocument.defaultView;
    while (w && w.frameElement) {
      const f = w.frameElement, r = f.getBoundingClientRect();
      ox += r.x + f.clientLeft; oy += r.y + f.clientTop;
      w = w.parent;
    }
    return {ox, oy};
  };
  const closest = (e, sel) => {
    for (let n = e; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) if (n.matches && n.matches(sel)) return n;
    return null;
  };
  const composedContains = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false; };
  const hitAt = (doc, x, y) => {
    let h = doc.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  };

  // --------------------------------------------------------------------------------------- element facts
  const safe = e => {
    if (['password', 'file', 'hidden'].includes(e.type)) return false;
    const ac = (e.getAttribute && e.getAttribute('autocomplete')) || '';
    // Never expose payment details, one-time codes or credentials to the model.
    return !/\b(cc-|one-time-code|new-password|current-password)/.test(ac);
  };
  const visible = e => !closest(e, '[aria-hidden="true"],[inert]') && e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  // Design systems hide the real checkbox/radio (opacity 0) and draw a label instead. Clicking the label is
  // what a person does, so such an input is observed through its visible label.
  const proxyFor = e => {
    if (!['checkbox', 'radio'].includes(e.type) || visible(e)) return null;
    if (closest(e, '[aria-hidden="true"],[inert]') || !e.checkVisibility({checkVisibilityCSS: true})) return null;
    const label = (e.labels && e.labels[0]) || closest(e, 'label');
    if (!label || !visible(label)) return null;
    J.proxy.set(e, label);
    return label;
  };
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const doc = e.ownerDocument;
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => name(doc.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  // Sites sometimes name an input by its value; its description, name, id and placeholder say what it is for.
  const hint = e => {
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) return '';
    const doc = e.ownerDocument;
    const described = (e.getAttribute('aria-describedby') || '').split(/\s+/)
      .map(id => (doc.getElementById(id) || {}).textContent || '').join(' ');
    const parts = [described, e.name, e.id, e.placeholder].map(s => (s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return [...new Set(parts)].join(' · ').slice(0, 100);
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map(r => '[role="' + r + '"]').join(',');
  const role = e => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel', ''].includes(e.type)) return 'textbox';
    }
    return null;
  };

  // The set of documents to scan: the top document plus visible same-origin iframes.
  const documents = () => {
    const out = [{doc: document, ox: 0, oy: 0}];
    const visit = (doc, ox, oy, depth) => {
      if (depth > 3) return;
      for (const f of deep(doc, 'iframe,frame')) {
        const d = frameDoc(f);
        if (!d || !visible(f)) continue;
        const r = f.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const fx = ox + r.x + f.clientLeft, fy = oy + r.y + f.clientTop;
        out.push({doc: d, ox: fx, oy: fy});
        visit(d, fx, fy, depth + 1);
      }
    };
    visit(document, 0, 0, 0);
    return out;
  };
  const inputs = () => documents().flatMap(({doc}) => deep(doc, 'input,textarea,select')).filter(safe);

  // ------------------------------------------------------------------------------- freshness primitives
  J.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    inputs().map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  J.guard = e => {
    if (!e || !e.isConnected || !(visible(e) || proxyFor(e))) return null;
    const scope = closest(e, 'form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), (scope && scope.innerText && scope.innerText.slice(0, 6000)) || ''];
  };
  // Compared in Python against the observation's page_key / guards before every mutation.
  J.current = node => [J.pageKey(), J.guard(J.nodes.get(node))];

  // ------------------------------------------------------------------------------------------- observe
  J.observe = () => {
    if (!document.body) return null;
    gc();
    const actions = [];
    const seen = new Set();
    const docs = documents();
    for (const {doc, ox, oy} of docs) {
      for (const e of deep(doc, selector)) {
        const proxy = proxyFor(e);
        if (!safe(e) || !(visible(e) || proxy) || e.matches(':disabled') || closest(e, '[aria-disabled="true"]')) continue;
        const r = (proxy || e).getBoundingClientRect(), x = ox + r.x + r.width / 2, y = oy + r.y + r.height / 2, rname = role(e);
        if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
        seen.add(e);
        const base = {node: identity(e), role: rname, label: name(e) || rname,
          rect: {x: ox + r.x, y: oy + r.y, w: r.width, h: r.height}};
        const purpose = hint(e);
        if (purpose && purpose !== base.label) base.hint = purpose;
        if (e.tagName === 'A' && e.href) base.href = e.href.slice(0, 400);
        // Site chrome (header/navigation/footer buttons: menus, language, theme, sign-in) rarely sets a task's values.
        if (e.tagName !== 'INPUT' && e.tagName !== 'TEXTAREA' && e.tagName !== 'SELECT' && closest(e, 'header,nav,[role="banner"],[role="navigation"],footer,[role="contentinfo"]')) base.chrome = true;
        const popup = e.getAttribute('aria-haspopup');
        if (popup && popup !== 'false') base.haspopup = popup;
        for (const key of ['checked', 'selected', 'expanded']) {
          const v = e.getAttribute('aria-' + key);
          if (v !== null) base[key] = v;
        }
        if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
        if (e.tagName === 'SELECT') {
          for (const o of e.options) if (!o.selected && !o.disabled && !closest(o, 'optgroup[disabled]'))
            actions.push({...base, kind: 'select', value: o.value,
              current_value: [...e.selectedOptions].map(s => s.label).join(', '), label: base.label + ' → ' + o.label});
        } else {
          const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
            (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
              (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
          const value = 'value' in e ? String(e.value) :
            e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
          actions.push({...base, kind: editable ? 'fill' : 'click', value});
          if (editable) actions.push({...base, kind: 'click', value, label: 'Open ' + base.label});
        }
      }
    }
    // Open pickers sometimes list plain clickable items with no role. Only inside dialogs, menus and
    // listboxes: whole-page pointer scanning would flood the action list.
    const pickers = '[role="dialog"],dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"],[popover]';
    for (const {doc, ox, oy} of docs) {
      for (const root of deep(doc, pickers)) {
        if (!visible(root)) continue;
        for (const e of root.querySelectorAll('*')) {
          if (seen.has(e) || e.closest(selector) || e.querySelector(selector) || !visible(e)) continue;
          if (getComputedStyle(e).cursor !== 'pointer' || getComputedStyle(e.parentElement).cursor === 'pointer') continue;
          const text = e.innerText && e.innerText.trim().replace(/\s+/g, ' ');
          const r = e.getBoundingClientRect(), x = ox + r.x + r.width / 2, y = oy + r.y + r.height / 2;
          if (!text || text.length > 80 || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          seen.add(e);
          actions.push({node: identity(e), role: 'option', label: text,
            rect: {x: ox + r.x, y: oy + r.y, w: r.width, h: r.height}, kind: 'click', value: ''});
        }
      }
    }
    // Visible text, in reading order, through shadow roots and same-origin frames.
    const words = [], range = document.createRange();
    let length = 0;
    const walkText = (root, ox, oy) => {
      for (let c = root.firstChild; c && length < 6000; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const value = c.textContent.trim(), parent = c.parentElement;
          if (!value || !parent || !visible(parent)) continue;
          range.selectNodeContents(c);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && oy + r.bottom > 0 && oy + r.top < innerHeight && ox + r.right > 0 && ox + r.left < innerWidth) {
            words.push(value); length += value.length;
          }
        } else if (c.nodeType === 1 && !SKIP.has(c.tagName.toUpperCase())) {
          if (c.shadowRoot) walkText(c.shadowRoot, ox, oy);
          if (c.tagName === 'IFRAME' || c.tagName === 'FRAME') {
            const d = frameDoc(c);
            const hit = d && docs.find(x => x.doc === d);
            if (hit && d.body) walkText(d.body, hit.ox, hit.oy);
          } else walkText(c, ox, oy);
        }
      }
    };
    walkText(document.body, 0, 0);
    const text = words.join('\n').slice(0, 6000), height = document.documentElement.scrollHeight;
    const page_key = J.pageKey(), guards = {};
    for (const a of actions) if (!(a.node in guards)) guards[a.node] = J.guard(J.nodes.get(a.node));
    // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
    const semantics = actions.map(({rect, ...action}) => action);
    const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      document.title, text, semantics, page_key[6]];
    const omitted_actions = Math.max(0, actions.length - 250);
    actions.splice(250);
    actions.forEach((a, i) => (a.id = 'e' + (i + 1)));
    if (scrollY + innerHeight < height - 2) actions.push({id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560});
    if (scrollY > 0) actions.push({id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560});
    actions.push({id: 'wait', kind: 'wait', label: 'Wait for the page to update'});
    let status = null;
    try { status = performance.getEntriesByType('navigation')[0]?.responseStatus || null; } catch { /* ignore */ }
    const iframe_hosts = [...document.querySelectorAll('iframe[src]')].map(f => { try { return new URL(f.src, location.href).host; } catch { return ''; } }).filter(Boolean).slice(0, 12);
    return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
      scroll: {y: scrollY, height}, actions, marker, page_key, guards, omitted_actions,
      status, iframe_hosts, ready: document.readyState, frames: docs.length - 1};
  };
  J.marker = () => {
    const state = J.observe();
    return state ? state.marker : null;
  };

  // ------------------------------------------------------------------------------------------- locate
  // Resolve an observed node to viewport coordinates and prove nothing covers it. Never accepts selectors.
  J.locate = (node, kind, value) => {
    const e = J.nodes.get(node);
    if (!e || !e.isConnected) return {ok: false, reason: 'gone'};
    if (e.matches(':disabled') || closest(e, '[aria-disabled="true"],[inert]')) return {ok: false, reason: 'disabled'};
    const t = J.proxy.get(e) || e;
    if (!t.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return {ok: false, reason: 'hidden'};
    if (kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return {ok: false, reason: 'readonly'};
    const {ox, oy} = frameOffset(t);
    const r = t.getBoundingClientRect();
    const lx = r.x + r.width / 2, ly = r.y + r.height / 2, x = lx + ox, y = ly + oy;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return {ok: false, reason: 'offscreen'};
    const hit = hitAt(t.ownerDocument, lx, ly);
    if (!hit || !composedContains(t, hit)) return {ok: false, reason: 'covered'};
    if (ox || oy) {
      // Inside a frame: the frame itself must be on top at that point.
      const top = hitAt(document, x, y);
      const frame = t.ownerDocument.defaultView.frameElement;
      let outer = frame;
      while (outer && outer.ownerDocument !== document) outer = outer.ownerDocument.defaultView.frameElement;
      if (!top || !outer || !composedContains(outer, top)) return {ok: false, reason: 'covered'};
    }
    if (kind === 'select') {
      if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === value && !o.disabled && !closest(o, 'optgroup[disabled]')))
        return {ok: false, reason: 'option-missing'};
      e.value = value;
      e.dispatchEvent(new Event('input', {bubbles: true}));
      e.dispatchEvent(new Event('change', {bubbles: true}));
    }
    return {ok: true, x, y};
  };

  // ------------------------------------------------------------------------------------------- settle
  // Resolve once the page has painted twice and stopped mutating, or the budget runs out. For comboboxes,
  // also wait until their popup options are visible. Event driven: no fixed sleeps beyond the budget.
  J.settle = (node, kind, budgetMs) => new Promise(resolve => {
    const field = node != null ? J.nodes.get(node) : null;
    const autocomplete = kind === 'fill' && field && field.getAttribute('role') === 'combobox';
    let frames = 0, last = performance.now(), stopped = false;
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    const finish = () => { if (stopped) return; stopped = true; observer.disconnect(); resolve(true); };
    setTimeout(finish, budgetMs ?? (autocomplete ? 400 : 300));
    const tick = () => {
      if (stopped) return;
      const ids = field ? (field.getAttribute('aria-controls') || field.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean) : [];
      const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
      const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
      const optionsShown = options.some(o => {
        const r = o.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight && o.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
      });
      // Running CSS transitions/animations (a dialog fading out) count as unsettled; endless ones (spinners) do not.
      let animating = false;
      try {
        animating = document.getAnimations({subtree: true}).some(a => a.playState === 'running' &&
          a.effect && a.effect.getComputedTiming().iterations !== Infinity);
      } catch { /* getAnimations unsupported */ }
      if (++frames >= 2 && !animating && performance.now() - last >= 30 && (!autocomplete || optionsShown)) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // ------------------------------------------------------------------------------------ content reading
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const absolute = u => { try { return new URL(u, location.href).href; } catch { return null; } };
  const snippetFor = (a, own) => {
    let n = a;
    for (let i = 0; i < 5 && n.parentElement; i++) {
      n = n.parentElement;
      const t = norm(n.innerText);
      if (t.length >= own.length + 60) return t.length > 420 ? t.slice(0, 420) : t;
    }
    return '';
  };
  J.read = (opts = {}) => {
    const maxChars = opts.maxChars || 12000, offset = opts.offset || 0;
    const main = document.querySelector('main,[role="main"],article') || document.body;
    let text = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 400 && main !== document.body) text = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const total = text.length;
    text = text.slice(offset, offset + maxChars);
    const meta = {};
    for (const m of document.querySelectorAll('meta[name],meta[property]')) {
      const k = m.getAttribute('name') || m.getAttribute('property');
      if (/^(description|og:title|og:description|og:image|og:site_name|og:type|twitter:image|article:published_time)$/.test(k)) meta[k] = (m.content || '').slice(0, 400);
    }
    const out = {
      url: location.href, title: document.title, lang: document.documentElement.lang || null, text, total_chars: total,
      offset, meta, canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 40).map(h => norm(h.innerText).slice(0, 160)).filter(Boolean),
      scroll: {y: scrollY, height: document.documentElement.scrollHeight, h: innerHeight},
    };
    if (opts.links !== false) {
      const links = [], hrefs = new Set();
      for (const a of deep(document, 'a[href]')) {
        if (links.length >= (opts.maxLinks || 160)) break;
        const href = absolute(a.getAttribute('href'));
        if (!href || !/^https?:/i.test(href) || !visible(a)) continue;
        const own = norm(name(a) || a.innerText);
        if (!own) continue;
        const h = a.querySelector('h1,h2,h3,h4,[role="heading"]');
        const heading = h ? norm(h.innerText).slice(0, 200) : '';
        const key = href + '|' + own;
        if (hrefs.has(key)) continue;
        hrefs.add(key);
        const r = a.getBoundingClientRect();
        links.push({text: own.slice(0, 200), heading, href: href.slice(0, 500), snippet: opts.snippets === false ? '' : snippetFor(a, own),
          y: Math.round(r.y + scrollY), in_view: r.bottom > 0 && r.top < innerHeight, node: identity(a)});
      }
      out.links = links;
    }
    if (opts.images) {
      const images = [];
      for (const img of deep(document, 'img')) {
        if (images.length >= (opts.maxImages || 60)) break;
        const r = img.getBoundingClientRect();
        if (r.width < 64 || r.height < 64 || !visible(img)) continue;
        const src = img.currentSrc || img.src;
        if (!src) continue;
        const a = closest(img, 'a[href]');
        const href = a ? absolute(a.getAttribute('href')) : null;
        let imgurl = null, source = null;
        if (href && /\/imgres\?/.test(href)) {
          try { const u = new URL(href); imgurl = u.searchParams.get('imgurl'); source = u.searchParams.get('imgrefurl'); } catch { /* ignore */ }
        }
        const sponsored = !!closest(img, '[data-offer-id],[data-pla-slot-pos],[data-text-ad],[data-ad-id],.pla-unit,[aria-label*="Sponsored" i]');
        const holder = closest(img, '[data-lpage],[data-ou],[data-ru]');
        if (holder) { imgurl = imgurl || holder.getAttribute('data-ou'); source = source || holder.getAttribute('data-lpage') || holder.getAttribute('data-ru'); }
        images.push({
          src: src.startsWith('data:') && src.length > 120000 ? null : src, alt: norm(img.alt).slice(0, 200), title: norm(img.title).slice(0, 200),
          w: Math.round(r.width), h: Math.round(r.height), natural_w: img.naturalWidth, natural_h: img.naturalHeight,
          href: href && !/\/imgres\?/.test(href) ? href : source, image_url: imgurl, caption: a ? norm(a.innerText).slice(0, 160) : '',
          y: Math.round(r.y + scrollY), node: identity(img), sponsored,
        });
      }
      out.images = images;
    }
    if (opts.jsonld) {
      const blocks = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        if (blocks.length >= 6) break;
        const t = s.textContent || '';
        if (t.length < 20000) blocks.push(t);
      }
      out.jsonld = blocks;
    }
    return out;
  };

  // After a thumbnail was clicked: the large image and the page it comes from, as a viewer panel presents them.
  J.imageDetails = () => {
    const host = h => { try { return new URL(h).hostname; } catch { return ''; } };
    let best = null, area = 0;
    for (const img of deep(document, 'img')) {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/.test(src) || /encrypted-tbn|gstatic\.com\/images|googleusercontent\.com\/(a|favicon)/.test(src)) continue;
      const r = img.getBoundingClientRect();
      if (!visible(img) || img.naturalWidth < 250 || r.width * r.height < 20000) continue;
      if (r.width * r.height > area) { best = img; area = r.width * r.height; }
    }
    if (!best) return null;
    let source = null, title = '', e = best;
    for (let i = 0; i < 8 && e && !source; i++, e = e.parentElement) {
      for (const a of e.querySelectorAll('a[href]')) {
        if (!/^https?:/.test(a.href) || !visible(a) || /(^|\.)google\.[a-z.]+$/.test(host(a.href))) continue;
        source = a.href; title = norm(a.getAttribute('aria-label') || a.innerText).slice(0, 160); break;
      }
    }
    const heading = e && e.querySelector ? e.querySelector('h1,h2,h3,[role="heading"]') : null;
    return {image_url: best.currentSrc || best.src, source_url: source, title: title || (heading ? norm(heading.innerText).slice(0, 160) : norm(best.alt)),
            width: best.naturalWidth, height: best.naturalHeight};
  };

  return true;
})();
