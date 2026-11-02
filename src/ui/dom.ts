type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Labelled slider; `fmt` renders the value, `onInput` receives the slider value. */
export function slider(label: string, opts: { min: number; max: number; step?: number; value: number; fmt: (v: number) => string; onInput: (v: number) => void; onCommit?: (v: number) => void; title?: string }): HTMLElement {
  const val = h('span', { class: 'val' }, opts.fmt(opts.value));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step ?? 'any', value: String(opts.value) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = opts.fmt(v);
    opts.onInput(v);
  });
  input.addEventListener('change', () => opts.onCommit?.(parseFloat(input.value)));
  return h('div', { class: 'slider', title: opts.title ?? '' }, h('div', { class: 'row' }, h('span', null, label), val), input);
}

export function kv(rows: [string, string | Node][]): HTMLElement {
  const el = h('div', { class: 'kv' });
  for (const [k, v] of rows) {
    el.appendChild(h('span', { class: 'k' }, k));
    el.appendChild(typeof v === 'string' ? h('span', { class: 'v' }, v) : v);
  }
  return el;
}

export function section(title: string): HTMLElement {
  return h('div', { class: 'section' }, title);
}
