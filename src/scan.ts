import type { Locator } from 'playwright';

export type FieldKind =
  | 'text' | 'textarea' | 'richtext' | 'email' | 'tel' | 'url' | 'number'
  | 'date' | 'time' | 'datetime'
  | 'checkbox' | 'toggle' | 'radio' | 'checkboxGroup'
  | 'picklist' | 'multiselect' | 'lookup' | 'password' | 'unknown';

export interface FieldLocate {
  by: 'role' | 'label';
  role?: string;
  name: string;
  group?: { role: string; name: string };
  index: number;
  expected: number;
}

export interface ScannedField {
  key: string;
  label: string;
  occurrence: number;
  kind: FieldKind;
  variant?: 'select' | 'combobox' | 'dualListbox' | 'native' | 'text';
  nativeType?: string;
  editable: boolean;
  required: boolean;
  value: string | string[] | boolean | null;
  options?: string[];
  optionsNote?: string;
  constraints: { maxLength?: number; minLength?: number; min?: string; max?: string; step?: string; pattern?: string; placeholder?: string };
  hint?: string;
  errors: string[];
  labelSource: string;
  component?: string;
  locate: FieldLocate;
}

export interface ScannedUpload {
  key: string;
  label: string;
  occurrence: number;
  via: 'input' | 'button';
  inputIndex?: number;
  buttonName?: string;
  accept?: string;
  multiple: boolean | null;
  disabled: boolean;
  maxBytes?: number;
  maxFiles?: number;
  constraintText?: string;
  existingFiles: string[];
  errors: string[];
  regionText: string;
}

export interface ComponentInfo {
  namespace: string;
  tags: string[];
  count: number;
  inaccessible: string[];
}

export interface ScreenScan {
  headings: string[];
  text: string;
  fields: ScannedField[];
  uploads: ScannedUpload[];
  components: ComponentInfo[];
  inaccessible: string[];
  errors: string[];
  buttons: string[];
  fileInputCount: number;
  busy: boolean;
  structure: string;
  state: string;
}

export interface PageScanOptions {
  standardNamespaces: string[];
  uploadButtonPattern: string;
  describeUpload?: boolean;
}

export const standardNamespaces = [
  'lightning', 'flowruntime', 'force', 'forcegenerated', 'ui', 'one', 'records', 'runtime', 'laf', 'aura',
  'interop', 'support', 'forcechatter', 'community', 'siteforce', 'omnistudio_standard',
];

const uploadButtonPattern =
  'upload|uploaden|bestand(en)? (kiezen|toevoegen|selecteren)|choose files?|add files?|attach|bijlage toevoegen';

/**
 * Runs inside the browser. Must stay self-contained: Playwright serialises it with Function.prototype.toString.
 */
export function pageScan(root: Element, opts: PageScanOptions): any {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const stripStars = (s: string) => clean(s).replace(/^\*\s*/, '').replace(/\s*\*$/, '');

  const parentOf = (n: Node): Node | null => (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode);
  // When describing a single upload input, its label lives above the element itself.
  const boundary = opts.describeUpload ? document.documentElement : root;
  const closestComposed = (el: Element, selector: string, stop: Element = boundary): Element | null => {
    let n: Node | null = el;
    while (n && n !== stop.parentNode) {
      if (n instanceof Element && n.matches(selector)) return n;
      if (n === stop) break;
      n = parentOf(n);
    }
    return null;
  };
  const containsComposed = (outer: Element, inner: Element) => {
    for (let n: Node | null = inner; n; n = parentOf(n)) if (n === outer) return true;
    return false;
  };
  const byId = (el: Element, id: string): Element | null => {
    const rootNode = el.getRootNode() as Document | ShadowRoot;
    return rootNode.getElementById?.(id) ?? document.getElementById(id);
  };

  const visible = (el: Element) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return el.checkVisibility({ visibilityProperty: true });
  };

  const textOf = (node: Node): string => {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child instanceof Element) {
        if (child.matches('select, option, textarea, input, script, style, button')) return;
        if (child.matches('abbr.slds-required, abbr[title="required"], .slds-required') && clean(child.textContent) === '*') return;
        const inline = getComputedStyle(child).display.startsWith('inline');
        out += inline ? textOf(child) : ` ${textOf(child)} `;
      }
    });
    return out;
  };
  const hasStar = (el: Element) =>
    !!el.querySelector('abbr.slds-required, abbr[title="required"], .slds-required') || /(^|\s)\*|\*(\s|$)/.test(el.textContent ?? '');

  const labelFor = (el: Element): { text: string; source: string; required: boolean } => {
    const fromEls = (parts: Element[], source: string) => ({
      text: stripStars(parts.map(textOf).join(' ')),
      source,
      required: parts.some(hasStar),
    });
    const ids = clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    const labelledBy = ids.map((id) => byId(el, id)).filter((x): x is Element => !!x);
    if (labelledBy.length) return fromEls(labelledBy, 'aria-labelledby');
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return { text: stripStars(aria), source: 'aria-label', required: false };
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return fromEls(Array.from(labels), 'label');
    if (el.tagName === 'FIELDSET') {
      const legend = el.querySelector(':scope > legend');
      if (legend) return fromEls([legend], 'legend');
    }
    const title = clean(el.getAttribute('title'));
    if (title) return { text: title, source: 'title', required: false };
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return { text: placeholder, source: 'placeholder', required: false };
    const visual = closestComposed(el, '.slds-form-element')?.querySelector('.slds-form-element__label, label, legend');
    if (visual) return { text: stripStars(textOf(visual)), source: 'visueel label, niet gekoppeld', required: hasStar(visual) };
    return { text: '', source: 'geen', required: false };
  };

  const regionOf = (el: Element): Element =>
    closestComposed(el, '.slds-form-element') ?? closestComposed(el, 'fieldset') ?? (parentOf(el) as Element) ?? el;

  const uploadLabel = (input: Element) => {
    const region = regionOf(input);
    const visual = region.querySelector('.slds-form-element__label, legend, [data-upload-label]');
    if (visual && clean(textOf(visual))) return { text: stripStars(textOf(visual)), required: hasStar(visual) };
    const own = labelFor(input);
    return { text: own.text, required: own.required };
  };

  if (opts.describeUpload) return { label: uploadLabel(root).text };

  const elements: Element[] = [];
  const walk = (parent: Element | ShadowRoot) => {
    for (const child of Array.from(parent.children)) {
      elements.push(child);
      if (child.shadowRoot) walk(child.shadowRoot);
      walk(child);
    }
  };
  if (root.shadowRoot) walk(root.shadowRoot);
  walk(root);

  const describedTexts = (el: Element) => {
    const errors: string[] = [];
    const hints: string[] = [];
    const ids = clean(`${el.getAttribute('aria-describedby') ?? ''} ${el.getAttribute('aria-errormessage') ?? ''}`).split(' ');
    for (const id of ids.filter(Boolean)) {
      const d = byId(el, id);
      if (!d || !visible(d)) continue;
      const t = clean(textOf(d));
      if (!t) continue;
      const isError =
        d.matches('[role=alert], [class*="error" i]') ||
        !!closestComposed(d, '.slds-has-error') ||
        el.getAttribute('aria-invalid') === 'true';
      (isError ? errors : hints).push(t);
    }
    const formElement = closestComposed(el, '.slds-form-element');
    if (formElement?.classList.contains('slds-has-error')) {
      formElement.querySelectorAll('.slds-form-element__help').forEach((h) => {
        if (visible(h) && clean(textOf(h))) errors.push(clean(textOf(h)));
      });
    }
    return { errors: [...new Set(errors)], hint: hints.length ? [...new Set(hints)].join(' ') : undefined };
  };

  const hostTag = (el: Element) => {
    for (let n = parentOf(el); n; n = parentOf(n)) {
      if (n instanceof Element && n.tagName.includes('-')) return n.tagName.toLowerCase();
      if (n === root) break;
    }
    return undefined;
  };

  const isEditable = (el: Element) =>
    !el.matches(':disabled') &&
    !(el as HTMLInputElement).readOnly &&
    el.getAttribute('aria-disabled') !== 'true' &&
    el.getAttribute('aria-readonly') !== 'true' &&
    !closestComposed(el, '[aria-disabled="true"]');

  const implicitRole = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    if (el instanceof HTMLTextAreaElement) return 'textbox';
    if (el instanceof HTMLSelectElement) return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (['text', 'email', 'tel', 'url', ''].includes(t)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
      if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return null;
  };

  const groupOf = (el: Element) => closestComposed(el, 'fieldset, [role=radiogroup], [role=group]');
  const groupRole = (g: Element) => g.getAttribute('role') ?? 'group';

  type Raw = {
    el: Element;
    label: string;
    name: string;
    group?: { role: string; name: string };
    kind: string;
    variant?: string;
    nativeType?: string;
    editable: boolean;
    required: boolean;
    value: string | string[] | boolean | null;
    options?: string[];
    optionsNote?: string;
    constraints: Record<string, unknown>;
    hint?: string;
    errors: string[];
    labelSource: string;
    component?: string;
    locateBy: 'role' | 'label';
    role?: string;
  };
  const fields: Raw[] = [];
  const handledGroups = new Set<Element>();
  const fileInputs: HTMLInputElement[] = [];
  const pills: Element[] = [];
  const compositeSelector = 'lightning-datetimepicker, lightning-input-address, lightning-input-name, lightning-input-location';

  const optionTexts = (container: Element | null) =>
    container ? Array.from(container.querySelectorAll('[role=option]')).map((o) => clean(o.getAttribute('title') || textOf(o))).filter(Boolean) : undefined;

  const base = (el: Element, kind: string, extra: Partial<Raw> = {}): Raw => {
    const l = labelFor(el);
    const composite = closestComposed(el, compositeSelector);
    const compositeGroup = composite ? groupOf(el) : null;
    const group = compositeGroup ? { role: groupRole(compositeGroup), name: labelFor(compositeGroup).text } : undefined;
    const described = describedTexts(el);
    const input = el as HTMLInputElement;
    const constraints: Record<string, unknown> = {};
    if (input.maxLength > 0) constraints.maxLength = input.maxLength;
    if (input.minLength > 0) constraints.minLength = input.minLength;
    for (const attr of ['min', 'max', 'step', 'pattern', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) constraints[attr] = v;
    }
    const role = implicitRole(el);
    return {
      el,
      name: l.text,
      label: group ? `${group.name} › ${l.text}` : l.text,
      group,
      kind,
      editable: isEditable(el),
      required: input.required || el.getAttribute('aria-required') === 'true' || l.required,
      value: 'value' in input ? input.value : clean(el.textContent),
      constraints,
      hint: described.hint,
      errors: described.errors,
      labelSource: l.source,
      component: hostTag(el),
      locateBy: role ? 'role' : 'label',
      role: role ?? undefined,
      ...extra,
    };
  };

  for (const el of elements) {
    if (el instanceof HTMLInputElement && el.type === 'file') {
      fileInputs.push(el);
      continue;
    }
    if (el.matches('.slds-pill, lightning-pill')) {
      if (visible(el)) pills.push(el);
      continue;
    }
    if (!visible(el)) continue;
    const role = el.getAttribute('role');

    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(t)) continue;
      if (t === 'radio' || t === 'checkbox') {
        const group = groupOf(el);
        const siblings = group
          ? elements.filter((x) => x instanceof HTMLInputElement && x.type === t && groupOf(x) === group && visible(x))
          : [];
        if (group && (t === 'radio' || siblings.length > 1)) {
          if (handledGroups.has(group)) continue;
          handledGroups.add(group);
          const gl = labelFor(group);
          const options = siblings.map((x) => labelFor(x).text);
          const checked = siblings.filter((x) => (x as HTMLInputElement).checked).map((x) => labelFor(x).text);
          const described = describedTexts(group);
          fields.push({
            el: group,
            name: gl.text,
            label: gl.text,
            kind: t === 'radio' ? 'radio' : 'checkboxGroup',
            editable: siblings.some(isEditable),
            required: gl.required || siblings.some((x) => (x as HTMLInputElement).required) || group.getAttribute('aria-required') === 'true',
            value: t === 'radio' ? (checked[0] ?? null) : checked,
            options,
            constraints: {},
            errors: [...new Set([...described.errors, ...siblings.flatMap((x) => describedTexts(x).errors)])],
            hint: described.hint,
            labelSource: gl.source,
            component: hostTag(group),
            locateBy: 'role',
            role: groupRole(group),
          });
          continue;
        }
        if (t === 'radio') {
          fields.push(base(el, 'unknown', { value: el.checked, optionsNote: 'losse radioknop zonder benoemde groep' }));
          continue;
        }
        const toggle = role === 'switch' || !!closestComposed(el, '.slds-checkbox_toggle');
        fields.push(base(el, toggle ? 'toggle' : 'checkbox', { value: el.checked }));
        continue;
      }
      const comboHost = role === 'combobox' ? el : closestComposed(el, '[role=combobox]');
      if (comboHost) {
        if (closestComposed(el, 'lightning-timepicker')) {
          fields.push(base(el, 'time', { variant: 'text' }));
        } else if (el.readOnly) {
          const options = optionTexts(byId(comboHost, comboHost.getAttribute('aria-controls') ?? ''));
          fields.push(base(el, 'picklist', {
            variant: 'combobox',
            editable: !el.disabled,
            options: options?.length ? options : undefined,
            optionsNote: options?.length ? undefined : 'opties worden pas na openen geladen',
          }));
        } else {
          fields.push(base(el, 'lookup', { variant: 'combobox' }));
        }
        continue;
      }
      const kinds: Record<string, string> = {
        text: 'text', search: 'text', email: 'email', tel: 'tel', url: 'url', number: 'number',
        date: 'date', time: 'time', 'datetime-local': 'datetime', password: 'password',
      };
      const datepicker = !!closestComposed(el, 'lightning-datepicker');
      const kind = datepicker ? 'date' : (kinds[t] ?? 'unknown');
      fields.push(base(el, kind, { nativeType: t, variant: datepicker ? 'text' : 'native' }));
      continue;
    }
    if (el instanceof HTMLTextAreaElement) {
      fields.push(base(el, 'textarea'));
      continue;
    }
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options).map((o) => clean(o.label || o.text));
      const selected = Array.from(el.selectedOptions).map((o) => clean(o.label || o.text));
      fields.push(base(el, el.multiple ? 'multiselect' : 'picklist', {
        variant: 'select',
        value: el.multiple ? selected : (selected[0] ?? null),
        options,
      }));
      continue;
    }
    if (role === 'combobox' && !(el instanceof HTMLInputElement)) {
      if (el.querySelector('input')) continue;
      const options = optionTexts(byId(el, el.getAttribute('aria-controls') ?? ''));
      fields.push(base(el, 'picklist', {
        variant: 'combobox',
        value: clean(textOf(el)) || null,
        options: options && options.length ? options : undefined,
        optionsNote: options && options.length ? undefined : 'opties worden pas na openen geladen',
      }));
      continue;
    }
    if ((role === 'checkbox' || role === 'switch') && !(el instanceof HTMLInputElement)) {
      fields.push(base(el, role === 'switch' ? 'toggle' : 'checkbox', { value: el.getAttribute('aria-checked') === 'true' }));
      continue;
    }
    if (role === 'listbox' && el.getAttribute('aria-multiselectable') === 'true') {
      const group = groupOf(el);
      if (!group || handledGroups.has(group)) continue;
      const lists = elements.filter((x) => x.getAttribute('role') === 'listbox' && groupOf(x) === group);
      if (lists.length !== 2) continue;
      handledGroups.add(group);
      const gl = labelFor(group);
      fields.push({
        el: group,
        name: gl.text,
        label: gl.text,
        kind: 'multiselect',
        variant: 'dualListbox',
        editable: isEditable(el),
        required: gl.required,
        value: optionTexts(lists[1]) ?? [],
        options: optionTexts(lists[0]),
        constraints: {},
        errors: describedTexts(group).errors,
        labelSource: gl.source,
        component: hostTag(group),
        locateBy: 'role',
        role: groupRole(group),
      });
      continue;
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) {
      fields.push(base(el, 'richtext', { value: clean(el.textContent) }));
    }
  }

  // A selected Salesforce lookup replaces its input by a pill; keep it visible in the inventory.
  for (const pill of pills) {
    const region = regionOf(pill);
    if (fields.some((f) => containsComposed(region, f.el))) continue;
    const labelEl = region.querySelector('.slds-form-element__label, label, legend');
    if (!labelEl) continue;
    fields.push({
      el: pill,
      name: stripStars(textOf(labelEl)),
      label: stripStars(textOf(labelEl)),
      kind: 'lookup',
      variant: 'combobox',
      editable: false,
      required: hasStar(labelEl),
      value: clean(textOf(pill)),
      constraints: {},
      errors: [],
      labelSource: 'visueel label (geselecteerde waarde)',
      component: hostTag(pill),
      locateBy: 'label',
    });
  }

  const sameLocator = (a: Raw, b: Raw) =>
    a.locateBy === b.locateBy && a.name === b.name && (a.locateBy === 'label' || a.role === b.role) &&
    a.group?.name === b.group?.name;
  const labelCounts = new Map<string, number>();
  const outFields = fields.map((f, i) => {
    const occurrence = (labelCounts.get(f.label) ?? 0) + 1;
    labelCounts.set(f.label, occurrence);
    const peers = fields.filter((g) => sameLocator(f, g));
    const { el, name, group, locateBy, role, ...rest } = f;
    return {
      ...rest,
      key: `${f.label}#${occurrence}`,
      occurrence,
      locate: { by: locateBy, role, name, group, index: peers.indexOf(f), expected: peers.length },
      _index: i,
    };
  });

  const uploadPattern = new RegExp(opts.uploadButtonPattern, 'i');
  const parseBytes = (text: string) => {
    const m = /(?:max(?:imaal|imum)?\.?|tot|up to)\s*(\d+(?:[.,]\d+)?)\s*(kb|mb|gb)\b/i.exec(text);
    if (!m) return undefined;
    const n = Number(m[1].replace(',', '.'));
    return Math.round(n * { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase() as 'kb' | 'mb' | 'gb']);
  };
  const parseCount = (text: string) => {
    const m = /(?:max(?:imaal|imum)?\.?|up to|tot)\s*(\d+)\s*(?:bestand(?:en)?|files?|documenten)\b/i.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const fileNamesIn = (region: Element) => {
    const names: string[] = [];
    region.querySelectorAll('*').forEach((e) => {
      if (e.children.length || !visible(e)) return;
      const t = clean(e.textContent);
      if (/^[^\s\\/:*?"<>|]+(?: [^\s\\/:*?"<>|]+)*\.[a-z0-9]{2,5}$/i.test(t)) names.push(t);
    });
    return [...new Set(names)];
  };
  const regionErrors = (region: Element) =>
    Array.from(region.querySelectorAll('[role=alert], .slds-form-element__help, [class*="error" i]'))
      .filter((e) => visible(e) && (e.matches('[role=alert], [class*="error" i]') || !!closestComposed(e, '.slds-has-error')))
      .map((e) => clean(textOf(e)))
      .filter(Boolean);

  const uploads: any[] = [];
  fileInputs.forEach((input, inputIndex) => {
    const region = regionOf(input);
    if (!visible(input) && !visible(region)) return;
    const label = uploadLabel(input);
    const regionText = clean(textOf(region));
    uploads.push({
      label: label.text,
      via: 'input',
      inputIndex,
      accept: input.accept || undefined,
      multiple: input.multiple,
      disabled: !isEditable(input),
      maxBytes: parseBytes(regionText),
      maxFiles: parseCount(regionText),
      constraintText: parseBytes(regionText) || parseCount(regionText) ? regionText : undefined,
      existingFiles: fileNamesIn(region),
      errors: [...new Set(regionErrors(region))],
      regionText,
      _region: region,
    });
  });

  const buttons: string[] = [];
  for (const el of elements) {
    if (!el.matches('button, [role=button], input[type=button], input[type=submit]') || !visible(el)) continue;
    const name = clean(el.getAttribute('aria-label') || (el as HTMLInputElement).value || textOf(el) || el.getAttribute('title'));
    if (!name) continue;
    buttons.push(name);
    if (!uploadPattern.test(name)) continue;
    const region = regionOf(el);
    if (uploads.some((u) => u._region === region || containsComposed(region, u._region))) continue;
    const labelEl = region.querySelector('.slds-form-element__label, legend, [data-upload-label]');
    const regionText = clean(textOf(region));
    uploads.push({
      label: labelEl ? stripStars(textOf(labelEl)) : name,
      via: 'button',
      buttonName: name,
      multiple: null,
      disabled: !isEditable(el),
      maxBytes: parseBytes(regionText),
      maxFiles: parseCount(regionText),
      constraintText: parseBytes(regionText) || parseCount(regionText) ? regionText : undefined,
      existingFiles: fileNamesIn(region),
      errors: [...new Set(regionErrors(region))],
      regionText,
      _region: region,
    });
  }
  const uploadCounts = new Map<string, number>();
  const outUploads = uploads.map(({ _region, ...u }) => {
    const occurrence = (uploadCounts.get(u.label) ?? 0) + 1;
    uploadCounts.set(u.label, occurrence);
    return { ...u, occurrence, key: `${u.label}#${occurrence}` };
  });

  // Namespaces of custom components, plus components we cannot look into.
  const namespaces = new Map<string, { tags: Set<string>; count: number; inaccessible: string[] }>();
  const addNs = (ns: string, tag: string) => {
    const entry = namespaces.get(ns) ?? { tags: new Set<string>(), count: 0, inaccessible: [] };
    entry.tags.add(tag);
    entry.count++;
    namespaces.set(ns, entry);
    return entry;
  };
  const inaccessible: string[] = [];
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes('-')) {
      const ns = tag.split('-')[0];
      const r = el.getBoundingClientRect();
      const closed = !el.shadowRoot && el.children.length === 0 && !clean(el.textContent) && r.width * r.height >= 100 && visible(el);
      if (!opts.standardNamespaces.includes(ns) || closed) {
        const entry = addNs(ns, tag);
        if (closed) {
          const label = labelFor(el).text;
          const note = `<${tag}>${label ? ` "${label}"` : ''}: geen toegankelijke inhoud (gesloten shadow DOM of canvas)`;
          entry.inaccessible.push(note);
          inaccessible.push(note);
        }
      }
    }
    const auraClass = el.getAttribute('data-aura-class');
    if (auraClass) {
      const ns = /^[a-z]+(?=[A-Z])/.exec(auraClass)?.[0];
      if (ns && !opts.standardNamespaces.includes(ns)) addNs(ns, `aura:${auraClass}`);
    }
    if (el.tagName === 'IFRAME' && visible(el)) {
      inaccessible.push(`iframe${el.getAttribute('title') ? ` "${el.getAttribute('title')}"` : ''} binnen de flow: inhoud niet onderzocht`);
    }
  }
  for (const f of fields) {
    if (f.kind === 'unknown') inaccessible.push(`veld "${f.label || '(zonder label)'}" (${f.component ?? f.el.tagName.toLowerCase()}): type niet herkend`);
    else if (!f.name && f.labelSource !== 'visueel label (geselecteerde waarde)') {
      inaccessible.push(`${f.kind}-veld zonder toegankelijk label (${f.component ?? f.el.tagName.toLowerCase()})`);
    }
  }

  const headings: string[] = [];
  const errors: string[] = [];
  const textParts: string[] = [];
  let busy = false;
  for (const el of elements) {
    if (!visible(el)) continue;
    if (el.matches('h1, h2, h3, h4, h5, h6, [role=heading]')) headings.push(clean(textOf(el)));
    if (el.matches('.slds-spinner, lightning-spinner, [aria-busy="true"]')) busy = true;
    if (
      el.matches('[role=alert], .slds-notify_alert, .slds-theme_error, .slds-text-color_error, [class*="errorMessage" i], [class*="error-message" i]') ||
      (el.matches('.slds-form-element__help') && closestComposed(el, '.slds-has-error'))
    ) {
      const t = clean(textOf(el));
      if (t) errors.push(t);
    }
    if (el.matches('script, style')) continue;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && clean(child.textContent)) textParts.push(clean(child.textContent));
    }
  }
  for (const f of fields) errors.push(...f.errors);

  const uniqueErrors = [...new Set(errors)];
  const structure = JSON.stringify([headings, outFields.map((f) => [f.label, f.kind]), outUploads.map((u) => u.label), buttons]);
  const state = JSON.stringify([
    structure,
    outFields.map((f) => [f.value, f.editable, f.options?.length ?? -1, f.errors]),
    outUploads.map((u) => [u.existingFiles, u.errors]),
    uniqueErrors,
    busy,
  ]);
  return {
    headings: headings.filter(Boolean),
    text: textParts.join(' ').slice(0, 20_000),
    fields: outFields.map(({ _index, ...f }) => f),
    uploads: outUploads,
    components: Array.from(namespaces, ([namespace, e]) => ({ namespace, tags: [...e.tags], count: e.count, inaccessible: e.inaccessible })),
    inaccessible,
    errors: uniqueErrors,
    buttons,
    fileInputCount: fileInputs.length,
    busy,
    structure,
    state,
  };
}

export function scanScreen(scope: Locator): Promise<ScreenScan> {
  return scope.evaluate(pageScan, { standardNamespaces, uploadButtonPattern });
}

export async function uploadLabelOf(input: Locator): Promise<string> {
  const result = await input.evaluate(pageScan, { standardNamespaces, uploadButtonPattern, describeUpload: true });
  return result.label;
}

/** Waits until the screen stops changing (no spinner, identical state twice in a row). */
export async function settleScreen(scope: Locator, timeoutMs: number): Promise<ScreenScan & { settled: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let scan = await scanScreen(scope);
  while (Date.now() < deadline) {
    if (!scan.busy && scan.state === previous) return { ...scan, settled: true };
    previous = scan.state;
    await scope.page().waitForTimeout(150);
    scan = await scanScreen(scope);
  }
  return { ...scan, settled: !scan.busy && scan.state === previous };
}

export function labelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`^\\s*\\*?\\s*${escaped}\\s*\\*?\\s*$`);
}

/**
 * Resolves a scanned field to a role/label based locator. Fails instead of guessing when the
 * accessible tree does not match what the scan saw.
 */
export async function locateField(scope: Locator, field: ScannedField): Promise<Locator | string> {
  const loc = field.locate;
  if (!loc.name) return 'geen toegankelijk label; kan niet betrouwbaar worden geselecteerd';
  let container = scope;
  if (loc.group) container = scope.getByRole(loc.group.role as 'group', { name: labelPattern(loc.group.name) });
  const candidates =
    loc.by === 'role' && loc.role
      ? container.getByRole(loc.role as 'textbox', { name: labelPattern(loc.name) })
      : container.getByLabel(labelPattern(loc.name));
  const count = await candidates.count();
  if (count !== loc.expected) {
    return `label/rol niet eenduidig: ${count} element(en) gevonden voor "${field.label}", ${loc.expected} verwacht`;
  }
  return candidates.nth(loc.index);
}
