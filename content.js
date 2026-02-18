let fieldMap = new Map();

function isVisible(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function shouldSkipInput(el) {
  if (el.disabled || el.readOnly || !isVisible(el)) {
    return true;
  }

  if (el.tagName.toLowerCase() === "input") {
    const t = (el.type || "text").toLowerCase();
    return ["hidden", "submit", "button", "reset", "file", "image", "range", "color"].includes(t);
  }

  return false;
}

function cleanText(v) {
  return (v || "").replace(/\s+/g, " ").trim();
}

function getLabelText(el) {
  const ariaLabel = cleanText(el.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = cleanText(el.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const txt = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => cleanText(node.textContent))
      .join(" ");

    if (txt) {
      return txt;
    }
  }

  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) {
      const txt = cleanText(explicit.textContent);
      if (txt) {
        return txt;
      }
    }
  }

  const wrapped = el.closest("label");
  if (wrapped) {
    const txt = cleanText(wrapped.textContent);
    if (txt) {
      return txt;
    }
  }

  const parent = el.parentElement;
  if (parent) {
    const candidates = Array.from(parent.childNodes)
      .filter((n) => n !== el && n.nodeType === Node.TEXT_NODE)
      .map((n) => cleanText(n.textContent))
      .filter(Boolean);

    if (candidates.length) {
      return candidates.join(" ");
    }
  }

  return "";
}

function getFieldDescriptor(el, index) {
  const tag = el.tagName.toLowerCase();
  const uid = `aff-${Date.now()}-${index}`;

  const descriptor = {
    uid,
    tag,
    type: (el.type || "").toLowerCase(),
    name: cleanText(el.getAttribute("name")),
    id: cleanText(el.id),
    placeholder: cleanText(el.getAttribute("placeholder")),
    label: getLabelText(el),
    required: Boolean(el.required)
  };

  if (tag === "select") {
    descriptor.options = Array.from(el.options)
      .map((o) => cleanText(o.textContent || o.value))
      .filter(Boolean)
      .slice(0, 50);
  }

  return descriptor;
}

function collectFields() {
  fieldMap = new Map();

  const elements = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((el) => !shouldSkipInput(el));

  const fields = elements.map((el, idx) => {
    const descriptor = getFieldDescriptor(el, idx);
    fieldMap.set(descriptor.uid, el);
    return descriptor;
  });

  return fields;
}

function setNativeValue(el, value) {
  const prototype = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor && typeof descriptor.set === "function") {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillField(uid, value) {
  const el = fieldMap.get(uid);
  if (!el) {
    return { ok: false, error: "Field not found in page context." };
  }

  const tag = el.tagName.toLowerCase();
  const trimmedValue = cleanText(String(value ?? ""));

  if (!trimmedValue) {
    return { ok: false, error: "Empty value was provided." };
  }

  if (tag === "select") {
    const normalized = trimmedValue.toLowerCase();

    const exactOption = Array.from(el.options).find((opt) => {
      const candidate = cleanText(opt.textContent || opt.value).toLowerCase();
      return candidate === normalized || cleanText(opt.value).toLowerCase() === normalized;
    });

    const partialOption = exactOption || Array.from(el.options).find((opt) => {
      const candidate = cleanText(opt.textContent || opt.value).toLowerCase();
      return candidate.includes(normalized) || normalized.includes(candidate);
    });

    if (!partialOption) {
      return { ok: false, error: "No matching option found for select field." };
    }

    el.value = partialOption.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  if (tag === "input") {
    const type = (el.type || "text").toLowerCase();

    if (type === "checkbox") {
      const truthy = /^(true|yes|1|checked)$/i.test(trimmedValue);
      const falsy = /^(false|no|0|unchecked)$/i.test(trimmedValue);

      if (!truthy && !falsy) {
        return { ok: false, error: "Checkbox value must resolve to true/false." };
      }

      el.checked = truthy;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (type === "radio") {
      const radioName = el.name;
      if (!radioName) {
        return { ok: false, error: "Radio button has no name group." };
      }

      const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`));
      const match = radios.find((r) => {
        const label = getLabelText(r).toLowerCase();
        const val = cleanText(r.value).toLowerCase();
        return label === trimmedValue.toLowerCase() || val === trimmedValue.toLowerCase() || label.includes(trimmedValue.toLowerCase());
      });

      if (!match) {
        return { ok: false, error: "No matching radio option found." };
      }

      match.checked = true;
      match.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
  }

  setNativeValue(el, trimmedValue);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "GET_FORM_FIELDS") {
    const fields = collectFields();
    sendResponse({ ok: true, fields });
    return;
  }

  if (message.type === "FILL_FORM_FIELD") {
    const result = fillField(message.uid, message.value);
    sendResponse(result);
  }
});
