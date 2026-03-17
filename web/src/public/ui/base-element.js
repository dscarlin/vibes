import { debugUpdateBoundary } from './debug.js';

export class BaseElement extends HTMLElement {
  constructor() {
    super();
    this._mounted = false;
    this._props = null;
  }

  connectedCallback() {
    if (!this._mounted) {
      this.renderStatic();
      this.cacheRefs();
      this.bindEvents();
      this._mounted = true;
    }
  }

  renderStatic() {}

  cacheRefs() {}

  bindEvents() {}

  update(nextProps, prevProps = null, changedKeys = new Set()) {
    const beforeActive = document.activeElement
      ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id || ''
        }
      : null;
    this._props = nextProps;
    this.performUpdate(nextProps, prevProps, changedKeys);
    debugUpdateBoundary(this.tagName.toLowerCase(), changedKeys, beforeActive);
  }

  performUpdate() {}

  patchText(el, value) {
    if (el && el.textContent !== String(value ?? '')) {
      el.textContent = String(value ?? '');
    }
  }

  patchHtml(el, value) {
    const next = String(value ?? '');
    if (el && el.innerHTML !== next) {
      el.innerHTML = next;
    }
  }

  patchValue(el, value) {
    const next = String(value ?? '');
    if (el && el.value !== next) {
      el.value = next;
    }
  }

  patchChecked(el, checked) {
    if (el) el.checked = Boolean(checked);
  }

  patchClass(el, className, enabled) {
    if (el) el.classList.toggle(className, Boolean(enabled));
  }

  patchHidden(el, hidden) {
    if (el) el.hidden = Boolean(hidden);
  }

  patchDisabled(el, disabled) {
    if (el) el.disabled = Boolean(disabled);
  }
}
