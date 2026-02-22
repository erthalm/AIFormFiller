let fieldMap = new Map();
let uidCounter = 0;

let hoverButton = null;
let hoverStatus = null;
let activeHoverField = null;
let hideTimer = null;
let statusTimer = null;
let availabilityTimer = null;
let availabilityObserver = null;
let lastKnownHasForm = null;
const SETTINGS_KEY = "aiFormFillerSettings";
const SUPPORTED_LANGUAGE_OVERRIDES = new Set(["default", "en", "pt_BR", "es"]);
let languageMessages = {};

function applySubstitutions(template, substitutions) {
  const values = Array.isArray(substitutions)
    ? substitutions.map((value) => String(value))
    : substitutions == null
      ? []
      : [String(substitutions)];

  let result = String(template || "");
  values.forEach((value, idx) => {
    result = result.split(`$${idx + 1}`).join(value);
  });
  return result;
}

function getOverrideMessage(key, substitutions) {
  const entry = languageMessages && languageMessages[key];
  const message = entry && entry.message;
  if (!message) {
    return "";
  }
  return applySubstitutions(message, substitutions);
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

async function loadLanguageMessages(language) {
  const safeLanguage = SUPPORTED_LANGUAGE_OVERRIDES.has(language) ? language : "default";
  if (safeLanguage === "default") {
    languageMessages = {};
    return;
  }

  try {
    const url = chrome.runtime.getURL(`_locales/${safeLanguage}/messages.json`);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Could not load locale file for ${safeLanguage}`);
    }
    languageMessages = await response.json();
  } catch (_error) {
    languageMessages = {};
  }
}

async function initializeLanguageOverride() {
  try {
    const data = await storageGet([SETTINGS_KEY]);
    const settings = data[SETTINGS_KEY] || {};
    const preferred = SUPPORTED_LANGUAGE_OVERRIDES.has(settings.language) ? settings.language : "default";
    await loadLanguageMessages(preferred);
  } catch (_error) {
    languageMessages = {};
  }

  if (hoverButton && !hoverButton.disabled) {
    hoverButton.textContent = t("contentFillWithAi", undefined, "Fill with AI");
  }
}

function t(key, substitutions, fallback) {
  const override = getOverrideMessage(key, substitutions);
  if (override) {
    return override;
  }

  const message = chrome.i18n.getMessage(key, substitutions);
  if (message) {
    return message;
  }
  return fallback || key;
}

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

function ensureFieldUid(el) {
  if (!el.dataset.affUid) {
    uidCounter += 1;
    el.dataset.affUid = `aff-${Date.now()}-${uidCounter}`;
  }
  return el.dataset.affUid;
}

function getFieldDescriptor(el) {
  const tag = el.tagName.toLowerCase();
  const uid = ensureFieldUid(el);

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

  fieldMap.set(uid, el);
  return descriptor;
}

function collectFields() {
  fieldMap = new Map();

  const elements = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((el) => !shouldSkipInput(el));

  return elements.map((el) => getFieldDescriptor(el));
}

function hasFillableForms() {
  const elements = Array.from(document.querySelectorAll("input, textarea, select"));
  return elements.some((el) => {
    if (el.disabled || el.readOnly) {
      return false;
    }

    if (el.tagName.toLowerCase() === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "file", "image"].includes(t)) {
        return false;
      }
    }

    return true;
  });
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
  const trimmedValue = cleanText(String(value == null ? "" : value));

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
      const normalizedValue = trimmedValue.toLowerCase();
      const match = radios.find((r) => {
        const label = getLabelText(r).toLowerCase();
        const val = cleanText(r.value).toLowerCase();
        return label === normalizedValue || val === normalizedValue || label.includes(normalizedValue);
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

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function hasFillableForms() {
  const selectors = [
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='textbox']"
  ];

  const elements = Array.from(document.querySelectorAll(selectors.join(",")));
  return elements.some((el) => {
    if (!(el instanceof HTMLElement)) {
      return false;
    }

    if (el.closest("[aria-hidden='true']")) {
      return false;
    }

    if ("disabled" in el && el.disabled) {
      return false;
    }
    if ("readOnly" in el && el.readOnly) {
      return false;
    }

    if (el.tagName.toLowerCase() === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "file", "image"].includes(t)) {
        return false;
      }
    }

    return true;
  });
}

function notifyFormAvailability(force) {
  const hasForm = hasFillableForms();
  if (!force && hasForm === lastKnownHasForm) {
    return;
  }

  lastKnownHasForm = hasForm;
  runtimeSendMessage({
    type: "FORM_AVAILABILITY_CHANGED",
    hasForm
  }).catch(() => {
    // Ignore transient messaging errors.
  });
}

function scheduleAvailabilityCheck() {
  clearTimeout(availabilityTimer);
  availabilityTimer = setTimeout(() => {
    notifyFormAvailability(false);
  }, 120);
}

function initFormAvailabilityTracking() {
  notifyFormAvailability(true);

  if (!availabilityObserver) {
    availabilityObserver = new MutationObserver(() => {
      scheduleAvailabilityCheck();
    });
    availabilityObserver.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["type", "disabled", "readonly", "aria-hidden", "style", "class", "contenteditable", "role"]
    });
  }

  window.addEventListener("load", () => notifyFormAvailability(true));
  document.addEventListener("visibilitychange", () => scheduleAvailabilityCheck());
  window.addEventListener("pageshow", () => notifyFormAvailability(true));
}

function ensureHoverControls() {
  if (hoverButton && hoverStatus) {
    return;
  }

  hoverButton = document.createElement("button");
  hoverButton.type = "button";
  hoverButton.textContent = t("contentFillWithAi", undefined, "Fill with AI");
  hoverButton.style.position = "fixed";
  hoverButton.style.zIndex = "2147483647";
  hoverButton.style.display = "none";
  hoverButton.style.padding = "4px 8px";
  hoverButton.style.fontSize = "12px";
  hoverButton.style.borderRadius = "6px";
  hoverButton.style.border = "1px solid #0f766e";
  hoverButton.style.background = "#0f766e";
  hoverButton.style.color = "#ffffff";
  hoverButton.style.cursor = "pointer";
  hoverButton.style.boxShadow = "0 4px 10px rgba(0,0,0,.15)";

  hoverStatus = document.createElement("div");
  hoverStatus.style.position = "fixed";
  hoverStatus.style.zIndex = "2147483647";
  hoverStatus.style.display = "none";
  hoverStatus.style.padding = "4px 8px";
  hoverStatus.style.fontSize = "12px";
  hoverStatus.style.borderRadius = "6px";
  hoverStatus.style.background = "#111827";
  hoverStatus.style.color = "#ffffff";
  hoverStatus.style.pointerEvents = "none";
  hoverStatus.style.maxWidth = "240px";

  document.documentElement.appendChild(hoverButton);
  document.documentElement.appendChild(hoverStatus);

  hoverButton.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
  });

  hoverButton.addEventListener("mouseleave", () => {
    scheduleHideHoverButton();
  });

  hoverButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!activeHoverField || shouldSkipInput(activeHoverField)) {
      showFieldStatus(t("contentFieldUnavailable", undefined, "Field unavailable"), true);
      hideHoverButton();
      return;
    }

    const descriptor = getFieldDescriptor(activeHoverField);

    hoverButton.disabled = true;
    hoverButton.textContent = t("contentFilling", undefined, "Filling...");
    showFieldStatus(t("contentSearchingDocs", undefined, "Searching docs..."), false);

    try {
      const response = await runtimeSendMessage({
        type: "FILL_SINGLE_FIELD",
        field: descriptor
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || t("contentCouldNotFetchFieldValue", undefined, "Could not fetch value for this field."));
      }

      if (!response.found || !response.value) {
        showFieldStatus(t("contentNoAnswerFound", undefined, "No answer found"), true);
        return;
      }

      const fillResult = fillField(descriptor.uid, response.value);
      if (!fillResult.ok) {
        throw new Error(fillResult.error || t("contentUnableApplyAnswer", undefined, "Unable to apply answer to field."));
      }

      showFieldStatus(t("contentFieldFilled", undefined, "Field filled"), false);
    } catch (error) {
      showFieldStatus((error && error.message) || t("contentFillFailed", undefined, "Fill failed"), true);
    } finally {
      hoverButton.disabled = false;
      hoverButton.textContent = t("contentFillWithAi", undefined, "Fill with AI");
    }
  });
}

function positionHoverControlsFor(el) {
  if (!hoverButton || !hoverStatus) {
    return;
  }

  const rect = el.getBoundingClientRect();
  const top = Math.max(8, rect.top - 30);
  const left = Math.max(8, Math.min(window.innerWidth - 120, rect.right - 100));

  hoverButton.style.top = `${top}px`;
  hoverButton.style.left = `${left}px`;

  if (hoverStatus.style.display !== "none") {
    hoverStatus.style.top = `${top + 30}px`;
    hoverStatus.style.left = `${left}px`;
  }
}

function showHoverButtonFor(el) {
  ensureHoverControls();

  if (shouldSkipInput(el)) {
    hideHoverButton();
    return;
  }

  activeHoverField = el;
  positionHoverControlsFor(el);
  hoverButton.style.display = "block";
}

function hideHoverButton() {
  if (hoverButton) {
    hoverButton.style.display = "none";
  }
  if (hoverStatus) {
    hoverStatus.style.display = "none";
  }
  activeHoverField = null;
}

function scheduleHideHoverButton() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideHoverButton();
  }, 220);
}

function showFieldStatus(message, isError) {
  if (!hoverStatus || !activeHoverField) {
    return;
  }

  clearTimeout(statusTimer);
  hoverStatus.textContent = message;
  hoverStatus.style.background = isError ? "#b91c1c" : "#111827";
  hoverStatus.style.display = "block";
  positionHoverControlsFor(activeHoverField);

  statusTimer = setTimeout(() => {
    if (hoverStatus) {
      hoverStatus.style.display = "none";
    }
  }, 2400);
}

function handlePointerOver(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (hoverButton && (target === hoverButton || hoverButton.contains(target))) {
    clearTimeout(hideTimer);
    return;
  }

  const field = target.closest("input, textarea, select");
  if (!field) {
    return;
  }

  clearTimeout(hideTimer);
  showHoverButtonFor(field);
}

function handlePointerOut(event) {
  const target = event.target;
  const related = event.relatedTarget;

  if (!(target instanceof Element)) {
    return;
  }

  const isField = Boolean(target.closest("input, textarea, select"));
  const goingToButton = Boolean(hoverButton && related instanceof Node && hoverButton.contains(related));

  if (isField && !goingToButton) {
    scheduleHideHoverButton();
  }
}

function handleViewportChange() {
  if (activeHoverField && hoverButton && hoverButton.style.display !== "none") {
    positionHoverControlsFor(activeHoverField);
  }
}

function initInlineFillControl() {
  ensureHoverControls();
  document.addEventListener("mouseover", handlePointerOver, true);
  document.addEventListener("mouseout", handlePointerOut, true);
  window.addEventListener("scroll", handleViewportChange, true);
  window.addEventListener("resize", handleViewportChange);
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

  if (message.type === "HAS_FILLABLE_FORMS") {
    sendResponse({ ok: true, hasForm: hasFillableForms() });
    return;
  }

  if (message.type === "HAS_FILLABLE_FORMS") {
    sendResponse({ ok: true, hasForm: hasFillableForms() });
    return;
  }

  if (message.type === "FILL_FORM_FIELD") {
    const result = fillField(message.uid, message.value);
    sendResponse(result);
  }
});

initInlineFillControl();
initFormAvailabilityTracking();
initializeLanguageOverride().catch(() => {
  // ignore
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes || !changes[SETTINGS_KEY]) {
    return;
  }
  initializeLanguageOverride().catch(() => {
    // ignore
  });
});
