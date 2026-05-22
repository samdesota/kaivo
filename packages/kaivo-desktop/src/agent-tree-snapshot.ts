// Snapshot-based browser automation: inject a lightweight JS agent into the page
// that builds a semantic accessibility tree, then serialize it for the LLM.
// Ported from fast-agent-read's agent-tree.js + serialize.ts.

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentTreeNode = {
  tag?: string;
  role?: string;
  name?: string;
  id?: string;
  selector?: string;
  rect?: { x: number; y: number; w: number; h: number };
  attrs?: Record<string, unknown>;
  state?: Record<string, unknown>;
  children?: AgentTreeNode[];
};

export type PageSnapshot = {
  url: string;
  title: string;
  version: number;
  durationMs: number;
  tree: string;
  refs: Record<string, { role?: string; name?: string }>;
  interactiveCount: number;
};

// ── In-page agent script ─────────────────────────────────────────────────────
// Self-contained IIFE injected via Runtime.evaluate. Installs window.__agentBrowser
// with snapshot(), click(id), type(id, text, opts), scrollBy(x, y), element(id).

export const AGENT_TREE_SOURCE = `(function installAgentBrowser(global) {
  if (global.__agentBrowser) return;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
  const STRUCTURAL_TAG_ROLES = new Map([
    ['ARTICLE', 'article'], ['ASIDE', 'complementary'], ['FOOTER', 'contentinfo'],
    ['FORM', 'form'], ['HEADER', 'banner'], ['MAIN', 'main'], ['NAV', 'navigation'],
    ['SECTION', 'region'], ['UL', 'list'], ['OL', 'list'], ['LI', 'listitem'],
    ['TABLE', 'table'], ['TR', 'row'], ['TD', 'cell'], ['TH', 'columnheader'],
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider',
    'spinbutton', 'switch', 'tab', 'textbox',
  ]);
  const KEEP_ATTRS = [
    'id', 'name', 'type', 'role', 'placeholder', 'aria-label', 'aria-expanded',
    'aria-checked', 'aria-selected', 'aria-disabled', 'disabled', 'required',
    'autocomplete', 'href', 'alt', 'title',
  ];

  let nextId = 1;
  let version = 1;
  const elementToId = new WeakMap();
  const idToElement = new Map();

  const observer = new MutationObserver(() => { version += 1; });
  function observeDocument() {
    const root = document.documentElement || document.body;
    if (!root) return;
    observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  if (document.documentElement || document.body) observeDocument();
  else document.addEventListener('DOMContentLoaded', observeDocument, { once: true });

  function getId(element) {
    let id = elementToId.get(element);
    if (!id) { id = 'e' + nextId++; elementToId.set(element, id); idToElement.set(id, element); }
    return id;
  }
  function compactText(value, max) {
    if (max === undefined) max = 120;
    if (!value) return '';
    const text = String(value).replace(/\\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '...' : text;
  }
  function attr(element, name) { return element.getAttribute(name) || ''; }
  function referencedText(element, attrName) {
    const ids = attr(element, attrName).split(/\\s+/).filter(Boolean);
    if (!ids.length) return '';
    return compactText(ids.map(function(id) { var el = document.getElementById(id); return el ? el.innerText || '' : ''; }).join(' '));
  }
  function implicitRole(element) {
    const explicit = attr(element, 'role').split(/\\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = element.tagName;
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const type = attr(element, 'type').toLowerCase() || 'text';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (!['hidden', 'file'].includes(type)) return 'textbox';
    }
    return STRUCTURAL_TAG_ROLES.get(tag) || '';
  }
  function elementName(element, role) {
    var v = referencedText(element, 'aria-labelledby'); if (v) return v;
    v = compactText(attr(element, 'aria-label')); if (v) return v;
    if (element.labels && element.labels.length) {
      v = compactText(Array.from(element.labels).map(function(n) { return n.innerText; }).join(' '));
      if (v) return v;
    }
    var names = ['alt', 'title', 'placeholder'];
    for (var i = 0; i < names.length; i++) { v = compactText(attr(element, names[i])); if (v) return v; }
    if (['textbox', 'searchbox', 'combobox'].includes(role)) return compactText(element.value || attr(element, 'value'));
    return compactText(element.innerText || element.textContent, 160);
  }
  function isElementVisible(element, rect) {
    if (!(rect.width || rect.height)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return !element.closest('[hidden],[aria-hidden="true"]');
  }
  function intersectsViewport(rect, margin) {
    return rect.bottom >= -margin && rect.right >= -margin && rect.top <= innerHeight + margin && rect.left <= innerWidth + margin;
  }
  function isNativeInteractive(element) {
    const tag = element.tagName;
    if (['BUTTON', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return true;
    if (tag === 'A' && element.hasAttribute('href')) return true;
    if (tag === 'INPUT' && attr(element, 'type').toLowerCase() !== 'hidden') return true;
    return false;
  }
  function isInteractive(element, role, style) {
    if (isNativeInteractive(element)) return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (element.hasAttribute('onclick')) return true;
    if (element.tabIndex >= 0 && attr(element, 'aria-hidden') !== 'true') return true;
    return style && style.cursor === 'pointer';
  }
  function stateFor(element) {
    const state = {};
    for (var k of ['disabled', 'required']) { if (element.hasAttribute(k)) state[k] = true; }
    for (var k2 of ['expanded', 'checked', 'selected', 'disabled']) {
      var v = attr(element, 'aria-' + k2); if (v) state[k2] = v;
    }
    if ('value' in element && element.tagName !== 'BUTTON' && attr(element, 'type') !== 'password') {
      var val = compactText(element.value, 80); if (val) state.value = val;
    }
    if (/^H[1-6]$/.test(element.tagName)) state.level = Number(element.tagName[1]);
    return state;
  }
  function attrsFor(element) {
    const out = {};
    for (var i = 0; i < KEEP_ATTRS.length; i++) {
      var name = KEEP_ATTRS[i];
      var value = compactText(attr(element, name), 100);
      if (value && !(name === 'href' && value.startsWith('javascript:'))) out[name] = value;
    }
    return out;
  }
  function selectorFor(element) {
    if (element.id && !/\\s/.test(element.id)) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  }
  function buildNode(element, options, depth) {
    if (SKIP_TAGS.has(element.tagName)) return null;
    if (depth > options.maxDepth) return null;
    const rect = element.getBoundingClientRect();
    if (!isElementVisible(element, rect)) return null;
    if (options.viewportOnly && !intersectsViewport(rect, options.viewportMargin)) return null;
    const style = getComputedStyle(element);
    const role = implicitRole(element);
    const interactive = isInteractive(element, role, style);
    const name = elementName(element, role);
    const children = [];
    if (element.shadowRoot && options.pierceShadow !== false) {
      for (var c of element.shadowRoot.children) { var n = buildNode(c, options, depth + 1); if (n) children.push(n); }
    }
    for (var c2 of element.children) { var n2 = buildNode(c2, options, depth + 1); if (n2) children.push(n2); }
    const keepStructural = role && ['banner', 'main', 'navigation', 'form', 'search', 'dialog', 'heading', 'list', 'listitem', 'table', 'row', 'cell'].includes(role);
    const keepText = options.includeText && name && children.length === 0 && element.childElementCount === 0;
    if (!interactive && !keepStructural && !keepText && children.length === 0) return null;
    const node = { tag: element.tagName.toLowerCase(), role: role || undefined, name: name || undefined, children: children.length ? children : undefined };
    if (interactive) {
      node.id = getId(element);
      node.selector = selectorFor(element);
      node.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      node.attrs = attrsFor(element);
      node.state = stateFor(element);
    } else if (keepStructural) {
      var attrs = attrsFor(element);
      if (Object.keys(attrs).length) node.attrs = attrs;
      if (role === 'heading') node.state = stateFor(element);
    }
    return node;
  }
  function countInteractive(node) {
    if (!node) return 0;
    var count = node.id ? 1 : 0;
    if (node.children) for (var c of node.children) count += countInteractive(c);
    return count;
  }
  function snapshot(userOptions) {
    if (!userOptions) userOptions = {};
    const started = performance.now();
    const options = {
      includeText: true, maxDepth: 40, pierceShadow: true,
      viewportMargin: 1200, viewportOnly: true, ...userOptions,
    };
    const rootElement = document.body || document.documentElement;
    const root = rootElement ? buildNode(rootElement, options, 0) : null;
    return { url: location.href, title: document.title, version: version,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      root: root, interactiveCount: countInteractive(root) };
  }
  function getElement(id) {
    const element = idToElement.get(id);
    if (!element || !element.isConnected) throw new Error('Unknown or detached agent element id: ' + id);
    return element;
  }
  async function click(id) {
    const element = getElement(id);
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return { ok: true, version: version };
  }
  async function type(id, text, options) {
    if (!options) options = {};
    const element = getElement(id);
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if ('value' in element) {
      const before = options.clear === false ? String(element.value || '') : '';
      var proto = Object.getPrototypeOf(element);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(element, before + text); else element.value = before + text;
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.blur(); element.focus();
      return { ok: true, version: version, valueLength: String(element.value || '').length };
    }
    document.execCommand('insertText', false, text);
    return { ok: true, version: version };
  }
  global.__agentBrowser = {
    snapshot: snapshot,
    click: click,
    type: type,
    element: getElement,
    focus: function(id) { getElement(id).focus(); return { ok: true, version: version }; },
    scrollBy: function(x, y) { global.scrollBy(x, y); return { ok: true, version: version }; },
  };
})(window);`;

// ── Tree serialization (runs server-side in Deno) ────────────────────────────

const ATOMIC_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "switch", "tab", "menuitem", "option",
]);

const DECORATIVE_TAGS = new Set([
  "svg", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "g", "defs", "use",
]);

function isDecorative(node: AgentTreeNode): boolean {
  if (node.tag && DECORATIVE_TAGS.has(node.tag.toLowerCase())) return true;
  if (node.attrs?.["aria-hidden"] === "true") return true;
  return false;
}

function meaningfulAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const keep: Record<string, unknown> = {};
  for (const key of ["type", "placeholder", "href"]) {
    if (attrs[key] !== undefined) keep[key] = attrs[key];
  }
  return Object.keys(keep).length ? keep : undefined;
}

function normalizeNode(node: AgentTreeNode | null): AgentTreeNode | null {
  if (!node || isDecorative(node)) return null;
  const isAtomic = Boolean(node.id) && ATOMIC_ROLES.has(node.role ?? "");
  const children = isAtomic
    ? []
    : (node.children ?? []).map(normalizeNode).filter((c): c is AgentTreeNode => Boolean(c));
  if (!node.id && !node.name && !node.role && !node.tag && children.length === 0) return null;
  if (!node.id && (node.role === "generic" || node.tag === "div") && children.length === 1 && !node.name) return children[0]!;
  return {
    ...node,
    tag: undefined,
    selector: undefined,
    rect: undefined,
    attrs: meaningfulAttrs(node.attrs),
    children: children.length ? children : undefined,
  };
}

function renderNodeLine(node: AgentTreeNode, depth: number, refs: Record<string, { role?: string; name?: string }>): string {
  const parts: string[] = [];
  if (node.id) {
    parts.push(`[${node.id.replace(/^e/, "")}]`);
    refs[node.id] = { role: node.role, name: node.name };
  }
  parts.push(node.role ?? node.tag ?? "node");
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.state) {
    const entries = Object.entries(node.state)
      .filter(([, v]) => v !== false && v !== undefined && v !== null)
      .map(([k, v]) => (v === true ? k : `${k}=${String(v)}`));
    if (entries.length) parts.push(`{${entries.join(" ")}}`);
  }
  return `${"\t".repeat(depth)}${parts.join(" ")}`;
}

function renderTree(node: AgentTreeNode | null, depth: number, refs: Record<string, { role?: string; name?: string }>): string[] {
  if (!node) return [];
  const line = renderNodeLine(node, depth, refs);
  return [line, ...(node.children ?? []).flatMap((child) => renderTree(child, depth + 1, refs))].filter(Boolean);
}

function filterNode(node: AgentTreeNode, regex: RegExp): AgentTreeNode | null {
  const children = (node.children ?? [])
    .map((c) => filterNode(c, regex))
    .filter((c): c is AgentTreeNode => Boolean(c));
  const keep = nodeMatches(node, regex) || children.length > 0;
  if (!keep) return null;
  return { ...node, children: children.length ? children : undefined };
}

function nodeMatches(node: AgentTreeNode, regex: RegExp): boolean {
  const values = [node.tag, node.role, node.name, node.id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (node.attrs) for (const [k, v] of Object.entries(node.attrs)) {
    values.push(k);
    if (v !== null && v !== undefined) values.push(String(v));
  }
  if (node.state) for (const [k, v] of Object.entries(node.state)) {
    values.push(k);
    if (v !== null && v !== undefined) values.push(String(v));
  }
  for (const val of values) {
    regex.lastIndex = 0;
    if (regex.test(val)) return true;
  }
  return false;
}

/** Build a serialized PageSnapshot from a raw in-page snapshot result. */
export function serializeSnapshot(
  raw: { url: string; title: string; version: number; durationMs: number; root: AgentTreeNode | null; interactiveCount: number },
  filterOpts?: { filter?: string; filterFlags?: string },
): PageSnapshot {
  let root = normalizeNode(raw.root);
  if (filterOpts?.filter) {
    try {
      const regex = new RegExp(filterOpts.filter, filterOpts.filterFlags);
      if (root) root = filterNode(root, regex);
    } catch { /* invalid regex — skip filter */ }
  }
  const refs: Record<string, { role?: string; name?: string }> = {};
  const tree = renderTree(root, 0, refs).join("\n");
  return {
    url: raw.url,
    title: raw.title,
    version: raw.version,
    durationMs: raw.durationMs,
    tree,
    refs,
    interactiveCount: Object.keys(refs).length,
  };
}

/** Format a PageSnapshot as compact text for the LLM. */
export function snapshotToText(snapshot: PageSnapshot): string {
  const header = JSON.stringify({
    url: snapshot.url,
    title: snapshot.title,
    interactiveCount: snapshot.interactiveCount,
    durationMs: snapshot.durationMs,
  });
  return `${header}\n${snapshot.tree}`;
}
