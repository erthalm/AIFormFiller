const SETTINGS_KEY = "aiFormFillerSettings";
const SUPPORTED_LANGUAGE_OVERRIDES = new Set(["default", "en", "pt_BR", "es"]);

globalThis.__aiFormFillerContentLoaded = true;

const {
  storageGet,
  runtimeSendMessage,
  createTranslator
} = self.AFFShared;

const { isSensitiveFieldElement } = self.AFFFieldSafety;

const i18n = createTranslator({
  supportedLanguages: SUPPORTED_LANGUAGE_OVERRIDES,
  settingsKey: SETTINGS_KEY
});

const t = i18n.t;

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

function cleanText(v) {
  return (v || "").replace(/\s+/g, " ").trim();
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
    const inputType = (el.type || "text").toLowerCase();
    return ["hidden", "submit", "button", "reset", "file", "image", "range", "color"].includes(inputType);
  }

  return false;
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
  const label = getLabelText(el);
  const sensitivity = isSensitiveFieldElement(el, label);

  const descriptor = {
    uid,
    tag,
    type: (el.type || "").toLowerCase(),
    autocomplete: cleanText(el.getAttribute("autocomplete")),
    ariaLabel: cleanText(el.getAttribute("aria-label")),
    name: cleanText(el.getAttribute("name")),
    id: cleanText(el.id),
    placeholder: cleanText(el.getAttribute("placeholder")),
    label,
    required: Boolean(el.required),
    sensitive: sensitivity.sensitive,
    sensitiveReason: sensitivity.reason
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

function collectFields(includeSensitive = false) {
  fieldMap = new Map();

  const elements = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((el) => !shouldSkipInput(el));

  const descriptors = elements.map((el) => getFieldDescriptor(el));
  return includeSensitive ? descriptors : descriptors.filter((field) => !field.sensitive);
}

function hasFillableForms() {
  return collectFields(false).length > 0;
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

function fillField(uid, value, allowSensitive) {
  const el = fieldMap.get(uid);
  if (!el) {
    return { ok: false, error: "Field not found in page context." };
  }

  const sensitivity = isSensitiveFieldElement(el, getLabelText(el));
  if (sensitivity.sensitive && !allowSensitive) {
    return { ok: false, error: "Refusing to fill sensitive field without explicit confirmation." };
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
      attributeFilter: ["type", "disabled", "readonly", "aria-hidden", "style", "class", "contenteditable", "role", "autocomplete", "name"]
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
    let allowSensitive = false;
    if (descriptor.sensitive) {
      allowSensitive = window.confirm(
        t(
          "contentConfirmSensitiveFill",
          [descriptor.label || descriptor.name || descriptor.id || descriptor.type || "field"],
          `This looks sensitive (${descriptor.sensitiveReason || "sensitive metadata"}). Fill "${descriptor.label || descriptor.name || descriptor.id || descriptor.type || "field"}" anyway?`
        )
      );
      if (!allowSensitive) {
        showFieldStatus(t("contentSensitiveFillCancelled", undefined, "Sensitive field fill cancelled."), true);
        return;
      }
    }

    hoverButton.disabled = true;
    hoverButton.textContent = t("contentFilling", undefined, "Filling...");
    showFieldStatus(t("contentSearchingDocs", undefined, "Searching docs..."), false);

    try {
      const response = await runtimeSendMessage({
        type: "FILL_SINGLE_FIELD",
        field: descriptor,
        allowSensitive
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || t("contentCouldNotFetchFieldValue", undefined, "Could not fetch value for this field."));
      }

      if (!response.found || !response.value) {
        showFieldStatus(t("contentNoAnswerFound", undefined, "No answer found"), true);
        return;
      }

      const fillResult = fillField(descriptor.uid, response.value, allowSensitive);
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
    const fields = collectFields(Boolean(message.includeSensitive));
    sendResponse({ ok: true, fields });
    return;
  }

  if (message.type === "HAS_FILLABLE_FORMS") {
    sendResponse({ ok: true, hasForm: hasFillableForms() });
    return;
  }

  if (message.type === "FILL_FORM_FIELD") {
    const result = fillField(message.uid, message.value, Boolean(message.allowSensitive));
    sendResponse(result);
  }
});

initInlineFillControl();
initFormAvailabilityTracking();
i18n.initializeLanguageOverride().catch(() => {
  // ignore
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes || !changes[SETTINGS_KEY]) {
    return;
  }

  i18n.initializeLanguageOverride().then(() => {
    if (hoverButton && !hoverButton.disabled) {
      hoverButton.textContent = t("contentFillWithAi", undefined, "Fill with AI");
    }
  }).catch(() => {
    // ignore
  });
});

