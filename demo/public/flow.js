// Fictieve lokale demo die het gedrag van een Salesforce Screen Flow nabootst.
const host = document.querySelector('flowruntime-flow');
const body = host.querySelector('.flow-body');
const params = new URLSearchParams(location.search);
const state = { step: Number(params.get('step') ?? 1) - 1, values: {}, uploads: { idbewijs: [], bijlagen: [], aanvullend: [] } };

const KB = 1024;
const provinces = {
  Nederland: ['Utrecht', 'Gelderland', 'Noord-Holland'],
  België: ['Antwerpen', 'Limburg', 'Vlaams-Brabant'],
};
const accounts = [
  ['Acme BV', 'Amsterdam'], ['Acme Holding', 'Utrecht'], ['Beta NV', 'Rotterdam'], ['Gamma Groep', 'Eindhoven'],
];

const star = (required) => (required ? '<abbr class="slds-required" title="required">*</abbr>' : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function input(id, label, { type = 'text', required = false, attrs = '', help = '' } = {}) {
  return `<div class="slds-form-element" data-field="${id}">
    <label class="slds-form-element__label" for="${id}">${star(required)}${label}</label>
    <input id="${id}" type="${type}" ${required ? 'required' : ''} ${attrs} aria-describedby="${id}-help">
    <div class="slds-form-element__help" id="${id}-help">${help}</div>
  </div>`;
}

function checkbox(id, label, required) {
  return `<div class="slds-form-element" data-field="${id}">
    <div class="slds-checkbox">
      <input type="checkbox" id="${id}" class="faux-hidden" ${required ? 'required' : ''} aria-describedby="${id}-help">
      <label for="${id}"><span class="slds-checkbox_faux"></span><span class="slds-form-element__label">${star(required)}${label}</span></label>
    </div>
    <div class="slds-form-element__help" id="${id}-help"></div>
  </div>`;
}

function choiceGroup(id, label, type, options, required) {
  return `<fieldset class="slds-form-element" data-field="${id}">
    <legend class="slds-form-element__label">${star(required)}${label}</legend>
    ${options.map((o, i) => `<span class="slds-${type === 'radio' ? 'radio' : 'checkbox'}">
      <input type="${type}" id="${id}-${i}" name="${id}" value="${o}" class="faux-hidden">
      <label for="${id}-${i}"><span class="slds-checkbox_faux"></span>${o}</label></span>`).join('')}
    <div class="slds-form-element__help" id="${id}-help"></div>
  </fieldset>`;
}

function upload(id, label, { accept, multiple, required, help }) {
  return `<div class="slds-form-element" data-field="${id}">
    <span class="slds-form-element__label" id="${id}-label">${star(required)}${label}</span>
    <div class="slds-file-selector">
      <input type="file" id="${id}" class="slds-assistive-text" accept="${accept}" ${multiple ? 'multiple' : ''} aria-labelledby="${id}-label ${id}-button">
      <label for="${id}" id="${id}-button"><span>Bestanden uploaden</span> <span>of sleep bestanden hierheen</span></label>
    </div>
    <div class="slds-form-element__help" id="${id}-help">${help}</div>
    <ul class="uploaded">${state.uploads[id].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </div>`;
}

// Een component met een open shadow root, zoals een LWC met native shadow DOM.
customElements.define('c-notes-panel', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<div class="slds-form-element">
      <label for="toelichting" style="display:block;font-size:12px;color:#444">Toelichting</label>
      <textarea id="toelichting" maxlength="200" rows="3" cols="50"></textarea>
    </div>`;
    root.querySelector('textarea').value = state.values.toelichting ?? '';
  }
});

// Een component met een gesloten shadow root: van buitenaf niet te inspecteren.
customElements.define('acme-rating', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>:host{display:inline-block;width:120px;height:24px}</style><span tabindex="0">★★★☆☆</span>';
  }
});

const screens = [
  {
    title: 'Aanvrager',
    render: () => `
      ${choiceGroup('klanttype', 'Klanttype', 'radio', ['Particulier', 'Zakelijk'], true)}
      <div id="zakelijk" hidden>
        ${input('bedrijfsnaam', 'Bedrijfsnaam', { required: true })}
        ${input('kvk', 'KvK-nummer', { required: true, attrs: 'pattern="[0-9]{8}" maxlength="8"', help: '8 cijfers' })}
      </div>
      ${input('voornaam', 'Voornaam', { required: true, attrs: 'maxlength="40"' })}
      ${input('achternaam', 'Achternaam', { required: true })}
      ${input('email', 'E-mail', { type: 'email', required: true })}
      <div class="section"><h3>Contactpersoon</h3>${input('tel1', 'Telefoon', { type: 'tel' })}</div>
      <div class="section"><h3>Vervanger</h3>${input('tel2', 'Telefoon', { type: 'tel' })}</div>
      ${input('website', 'Website', { type: 'url' })}
      ${input('geboortedatum', 'Geboortedatum', { type: 'date' })}
      ${input('afspraak', 'Gewenste afspraak', { type: 'datetime-local' })}
      ${input('medewerkers', 'Aantal medewerkers', { type: 'number', attrs: 'min="1" max="500"' })}
      <div class="slds-form-element">
        <label class="slds-checkbox_toggle"><span class="slds-form-element__label">Nieuwsbrief</span>
          <input type="checkbox" role="switch" id="nieuwsbrief" class="faux-hidden"><span class="slds-checkbox_faux"></span></label>
      </div>
      <div class="slds-form-element"><span class="slds-form-element__label">Tevredenheid</span><acme-rating></acme-rating></div>
      ${checkbox('akkoord', 'Ik ga akkoord met de voorwaarden', true)}`,
    bind() {
      body.querySelectorAll('input[name=klanttype]').forEach((r) => r.addEventListener('change', () => {
        body.querySelector('#zakelijk').hidden = r.value !== 'Zakelijk';
      }));
      body.querySelector('#email').addEventListener('blur', (e) => {
        const v = e.target.value;
        setError('email', v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? 'Voer een geldig e-mailadres in.' : '');
      });
    },
    validate(v) {
      const e = {};
      if (!v.klanttype) e.klanttype = 'Kies een klanttype.';
      for (const id of ['voornaam', 'achternaam', 'email']) if (!v[id]) e[id] = 'Vul dit veld in.';
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) e.email = 'Voer een geldig e-mailadres in.';
      if (v.klanttype === 'Zakelijk') {
        if (!v.bedrijfsnaam) e.bedrijfsnaam = 'Vul dit veld in.';
        if (!/^\d{8}$/.test(v.kvk ?? '')) e.kvk = 'KvK-nummer moet uit 8 cijfers bestaan.';
      }
      if (v.medewerkers && (Number(v.medewerkers) < 1 || Number(v.medewerkers) > 500)) e.medewerkers = 'Voer een getal tussen 1 en 500 in.';
      if (!v.akkoord) e.akkoord = 'U moet akkoord gaan met de voorwaarden.';
      return e;
    },
  },
  {
    title: 'Aanvraag',
    render: () => `
      <div class="slds-form-element" data-field="land">
        <label class="slds-form-element__label" for="land">${star(true)}Land</label>
        <select id="land" required aria-describedby="land-help"><option value="">--Geen--</option>${Object.keys(provinces).map((l) => `<option>${l}</option>`).join('')}</select>
        <div class="slds-form-element__help" id="land-help"></div>
      </div>
      <div class="slds-form-element" data-field="provincie">
        <label class="slds-form-element__label" for="provincie">${star(true)}Provincie</label>
        <select id="provincie" required disabled aria-describedby="provincie-help"><option value="">--Geen--</option></select>
        <div class="slds-form-element__help" id="provincie-help"></div>
      </div>
      ${choiceGroup('interesses', 'Interesses', 'checkbox', ['Advies', 'Financiering', 'Training'], true)}
      <div class="slds-form-element">
        <label class="slds-form-element__label" for="talen">Talen</label>
        <select id="talen" multiple size="4"><option>Nederlands</option><option>Engels</option><option>Frans</option><option>Duits</option></select>
      </div>
      <div class="slds-form-element" data-field="product">
        <span class="slds-form-element__label" id="product-label">${star(true)}Product</span>
        <button type="button" role="combobox" id="product" class="slds-combobox__input" aria-labelledby="product-label"
          aria-haspopup="listbox" aria-expanded="false" aria-controls="product-listbox" aria-describedby="product-help"><span>Selecteer een optie</span></button>
        <div role="listbox" id="product-listbox" hidden></div>
        <div class="slds-form-element__help" id="product-help"></div>
      </div>
      <div class="slds-form-element" data-field="account">
        <label class="slds-form-element__label" for="account">${star(true)}Account</label>
        <input id="account" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-controls="account-listbox" autocomplete="off" placeholder="Zoek accounts..." aria-describedby="account-help">
        <div role="listbox" id="account-listbox" hidden></div>
        <span class="slds-pill" hidden><span class="slds-pill__label"></span><button type="button" aria-label="Selectie verwijderen">×</button></span>
        <div class="slds-form-element__help" id="account-help"></div>
      </div>
      <c-notes-panel></c-notes-panel>`,
    bind() {
      const land = body.querySelector('#land');
      const provincie = body.querySelector('#provincie');
      land.addEventListener('change', () => {
        provincie.disabled = true;
        provincie.innerHTML = '<option value="">--Geen--</option>';
        provincie.parentElement.setAttribute('aria-busy', 'true');
        setTimeout(() => {
          for (const p of provinces[land.value] ?? []) provincie.add(new Option(p));
          provincie.disabled = !land.value;
          provincie.parentElement.removeAttribute('aria-busy');
        }, 1200);
      });

      const product = body.querySelector('#product');
      const productList = body.querySelector('#product-listbox');
      product.addEventListener('click', () => {
        const open = product.getAttribute('aria-expanded') !== 'true';
        product.setAttribute('aria-expanded', String(open));
        productList.hidden = !open;
        productList.innerHTML = open ? ['Basis', 'Plus', 'Premium'].map((p) => `<div role="option" aria-selected="false">${p}</div>`).join('') : '';
      });
      productList.addEventListener('click', (e) => {
        const option = e.target.closest('[role=option]');
        if (!option) return;
        product.querySelector('span').textContent = option.textContent;
        product.setAttribute('aria-expanded', 'false');
        productList.hidden = true;
        productList.innerHTML = '';
      });

      const account = body.querySelector('#account');
      const accountList = body.querySelector('#account-listbox');
      const pill = body.querySelector('.slds-pill');
      let timer;
      account.addEventListener('input', () => {
        clearTimeout(timer);
        accountList.hidden = false;
        accountList.innerHTML = '<div role="option">Zoeken...</div>';
        timer = setTimeout(() => {
          const term = account.value.toLowerCase();
          const hits = accounts.filter(([name]) => term && name.toLowerCase().includes(term));
          accountList.innerHTML = hits.map(([name, city]) =>
            `<div role="option" data-name="${name}"><span class="primary">${name}</span><span class="secondary">Account • ${city}</span></div>`).join('') +
            '<div role="option" data-new="1"><span class="primary">+ Nieuw account</span></div>';
        }, 400);
      });
      accountList.addEventListener('click', (e) => {
        const option = e.target.closest('[role=option][data-name]');
        if (!option) return;
        pill.querySelector('.slds-pill__label').textContent = option.dataset.name;
        pill.hidden = false;
        account.hidden = true;
        accountList.hidden = true;
      });
      pill.querySelector('button').addEventListener('click', () => {
        pill.hidden = true;
        account.hidden = false;
        account.value = '';
      });
    },
    validate(v) {
      const e = {};
      if (!v.land) e.land = 'Kies een land.';
      if (!v.provincie) e.provincie = 'Kies een provincie.';
      if (!v.interesses.length) e.interesses = 'Kies minimaal één interesse.';
      if (!v.product) e.product = 'Kies een product.';
      if (!v.account) e.account = 'Selecteer een account.';
      return e;
    },
  },
  {
    title: 'Documenten',
    render: () => `
      ${upload('idbewijs', 'Identiteitsbewijs', { accept: '.pdf,.png,.jpg', required: true, help: 'Toegestaan: PDF, PNG of JPG. Max. 100 KB.' })}
      ${upload('bijlagen', 'Bijlagen', { accept: '.pdf,.txt', multiple: true, help: 'Maximaal 3 bestanden, max. 100 KB per bestand.' })}
      <div class="slds-form-element" data-field="aanvullend">
        <span class="slds-form-element__label">Aanvullend document</span>
        <acme-doc-picker><button type="button" id="kies">Bestand kiezen</button></acme-doc-picker>
        <ul class="uploaded">${state.uploads.aanvullend.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>`,
    bind() {
      for (const [id, max] of [['idbewijs', 1], ['bijlagen', 3]]) {
        const el = body.querySelector(`#${id}`);
        el.addEventListener('change', () => startUpload(id, [...el.files], el.accept, max));
      }
      body.querySelector('#kies').addEventListener('click', () => {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.pdf';
        picker.addEventListener('change', () => startUpload('aanvullend', [...picker.files], picker.accept, 1));
        picker.click();
      });
    },
    validate: () => (state.uploads.idbewijs.length ? {} : { idbewijs: 'Upload een identiteitsbewijs.' }),
  },
  {
    title: 'Controle',
    render: () => {
      const v = state.values;
      return `<p>Controleer uw aanvraag voordat u deze indient.</p>
        <dl>
          <dt>Naam</dt><dd>${esc(v.voornaam ?? '')} ${esc(v.achternaam ?? '')}</dd>
          <dt>Klanttype</dt><dd>${esc(v.klanttype ?? '')}</dd>
          <dt>Product</dt><dd>${esc(v.product ?? '')}</dd>
          <dt>Account</dt><dd>${esc(v.account ?? '')}</dd>
          <dt>Documenten</dt><dd>${esc([...state.uploads.idbewijs, ...state.uploads.bijlagen, ...state.uploads.aanvullend].join(', '))}</dd>
        </dl>`;
    },
    validate: () => ({}),
  },
];

function collect() {
  const v = {};
  body.querySelectorAll('input:not([type=file]), select, textarea').forEach((el) => {
    if (el.type === 'radio') { if (el.checked) v[el.name] = el.value; }
    else if (el.type === 'checkbox' && el.name) { (v[el.name] ??= []).push(...(el.checked ? [el.value] : [])); }
    else if (el.type === 'checkbox') v[el.id] = el.checked;
    else if (el.multiple) v[el.id] = [...el.selectedOptions].map((o) => o.value);
    else v[el.id] = el.value;
  });
  body.querySelectorAll('fieldset[data-field]').forEach((f) => {
    if (f.querySelector('input[type=checkbox]')) v[f.dataset.field] ??= [];
  });
  const product = body.querySelector('#product span');
  if (product) v.product = product.textContent === 'Selecteer een optie' ? '' : product.textContent;
  const pill = body.querySelector('.slds-pill');
  if (pill) v.account = pill.hidden ? '' : pill.querySelector('.slds-pill__label').textContent;
  const notes = body.querySelector('c-notes-panel');
  if (notes) v.toelichting = notes.shadowRoot.querySelector('textarea').value;
  return v;
}

function setError(id, message) {
  const field = body.querySelector(`[data-field="${id}"]`);
  if (!field) return;
  field.classList.toggle('slds-has-error', !!message);
  const help = field.querySelector('.slds-form-element__help');
  if (help) {
    help.dataset.hint ??= help.textContent;
    help.textContent = message || help.dataset.hint;
  }
  field.querySelectorAll('input, select, button[role=combobox]').forEach((el) => {
    if (message) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  });
}

function withSpinner(ms, then) {
  const spinner = document.createElement('div');
  spinner.className = 'slds-spinner_container';
  spinner.innerHTML = '<div class="slds-spinner" role="status"><span class="slds-assistive-text">Laden</span></div>';
  host.append(spinner);
  setTimeout(() => { spinner.remove(); then(); }, ms);
}

function render() {
  if (state.step >= screens.length) {
    body.innerHTML = `<h2>Aanvraag ingediend</h2><p>Bedankt! Uw aanvraag is ontvangen onder nummer AANVR-0001.</p>`;
    return;
  }
  const screen = screens[state.step];
  const last = state.step === screens.length - 1;
  body.innerHTML = `<h2>${screen.title}</h2>
    <div class="page-error" role="alert" hidden></div>
    <div class="screen-fields">${screen.render()}</div>
    <div class="flow-footer">
      ${state.step > 0 ? '<button type="button" data-nav="back">Vorige</button>' : ''}
      <button type="button" data-nav="next">${last ? 'Voltooien' : 'Volgende'}</button>
    </div>`;
  screen.bind?.();
  // Invoervariabelen uit de URL vullen velden vooraf, zoals een flow met standaardwaarden.
  for (const [key, value] of params) {
    const el = body.querySelector(`#${CSS.escape(key)}`);
    if (el && 'value' in el && el.type !== 'file') el.value = value;
  }
  body.querySelector('[data-nav=next]').addEventListener('click', next);
  body.querySelector('[data-nav=back]')?.addEventListener('click', () => withSpinner(300, () => { state.step--; render(); }));
}

function next() {
  const screen = screens[state.step];
  const values = collect();
  const errors = screen.validate(values);
  body.querySelectorAll('[data-field]').forEach((f) => setError(f.dataset.field, errors[f.dataset.field] ?? ''));
  const pageError = body.querySelector('.page-error');
  pageError.hidden = !Object.keys(errors).length;
  pageError.textContent = Object.keys(errors).length ? 'Controleer de gemarkeerde velden.' : '';
  if (Object.keys(errors).length) return;
  Object.assign(state.values, values);
  withSpinner(400, () => {
    if (state.values.voornaam === 'FOUT' && state.step === 0) {
      body.innerHTML = '<p>An unhandled fault has occurred in this flow.</p><p>Neem contact op met uw beheerder.</p>';
      return;
    }
    state.step++;
    render();
  });
}

function startUpload(id, files, accept, maxFiles) {
  if (!files.length) return;
  const allowed = accept.split(',').map((a) => a.trim().toLowerCase());
  const dialog = document.createElement('section');
  dialog.className = 'slds-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'upload-title');
  dialog.innerHTML = `<div class="slds-modal__container">
    <h2 id="upload-title">Bestanden uploaden</h2>
    <ul>${files.map((f) => `<li>${esc(f.name)} (${Math.ceil(f.size / KB)} KB)</li>`).join('')}</ul>
    <p class="status" role="status">0 van ${files.length} ${files.length === 1 ? 'bestand' : 'bestanden'} geüpload</p>
    <button type="button" disabled>Gereed</button>
  </div>`;
  document.body.append(dialog);
  const done = dialog.querySelector('button');
  let succeeded = false;
  setTimeout(() => {
    const problems = [];
    if (files.length > maxFiles) problems.push(`maximaal ${maxFiles} bestanden toegestaan`);
    for (const f of files) {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
      if (!allowed.includes(ext)) problems.push(`${f.name}: bestandstype niet toegestaan`);
      else if (f.size > 100 * KB) problems.push(`${f.name}: bestand is te groot (max. 100 KB)`);
    }
    const status = dialog.querySelector('.status');
    if (problems.length) {
      status.textContent = `Upload mislukt: ${problems.join('; ')}`;
    } else {
      succeeded = true;
      status.textContent = `${files.length} van ${files.length} ${files.length === 1 ? 'bestand' : 'bestanden'} geüpload`;
    }
    done.disabled = false;
  }, 800);
  done.addEventListener('click', () => {
    dialog.remove();
    if (!succeeded) return;
    state.uploads[id].push(...files.map((f) => f.name));
    const list = body.querySelector(`[data-field="${id}"] .uploaded`);
    list.innerHTML = state.uploads[id].map((n) => `<li>${esc(n)}</li>`).join('');
    setError(id, '');
  });
}

render();
