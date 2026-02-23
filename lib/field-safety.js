(function initFieldSafety(globalScope) {
  const SENSITIVE_INPUT_TYPES = new Set(["password"]);
  const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-name",
    "cc-given-name",
    "cc-additional-name",
    "cc-family-name",
    "cc-number",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-csc",
    "cc-type",
    "transaction-amount",
    "transaction-currency",
    "bday",
    "bday-day",
    "bday-month",
    "bday-year",
    "sex",
    "tel",
    "tel-country-code",
    "tel-national",
    "tel-area-code",
    "tel-local",
    "tel-extension"
  ]);

  const SENSITIVE_PATTERN = /(password|passcode|otp|one[-_ ]?time|2fa|mfa|token|security\s*code|verification\s*code|cvv|cvc|card\s*number|credit\s*card|debit\s*card|routing|iban|swift|ssn|social\s*security|tax\s*id|tin|ein|passport|driver('|’)s?\s*license|bank\s*account)/i;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getAutocompleteTokens(element) {
    const autocomplete = clean(element && element.getAttribute ? element.getAttribute("autocomplete") : "").toLowerCase();
    if (!autocomplete) {
      return [];
    }
    return autocomplete.split(/\s+/).filter(Boolean);
  }

  function getElementTextForSensitivity(element, label) {
    return [
      label,
      element && element.getAttribute ? element.getAttribute("name") : "",
      element && element.id,
      element && element.getAttribute ? element.getAttribute("placeholder") : "",
      element && element.getAttribute ? element.getAttribute("aria-label") : ""
    ]
      .map(clean)
      .filter(Boolean)
      .join(" ");
  }

  function isSensitiveFieldElement(element, label) {
    const tag = (element && element.tagName ? element.tagName : "").toLowerCase();
    if (!tag) {
      return { sensitive: false, reason: "" };
    }

    if (tag === "input") {
      const inputType = clean(element.type).toLowerCase() || "text";
      if (SENSITIVE_INPUT_TYPES.has(inputType)) {
        return { sensitive: true, reason: `input type '${inputType}'` };
      }
    }

    const autocompleteTokens = getAutocompleteTokens(element);
    const matchedAutocomplete = autocompleteTokens.find((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
    if (matchedAutocomplete) {
      return { sensitive: true, reason: `autocomplete '${matchedAutocomplete}'` };
    }

    const text = getElementTextForSensitivity(element, label);
    if (SENSITIVE_PATTERN.test(text)) {
      return { sensitive: true, reason: "field metadata matched sensitive pattern" };
    }

    return { sensitive: false, reason: "" };
  }

  function isSensitiveFieldDescriptor(field) {
    if (!field || typeof field !== "object") {
      return { sensitive: false, reason: "" };
    }

    const tag = clean(field.tag).toLowerCase();
    const type = clean(field.type).toLowerCase();
    if (tag === "input" && SENSITIVE_INPUT_TYPES.has(type)) {
      return { sensitive: true, reason: `input type '${type}'` };
    }

    const autocomplete = clean(field.autocomplete).toLowerCase();
    const autocompleteTokens = autocomplete ? autocomplete.split(/\s+/).filter(Boolean) : [];
    const matchedAutocomplete = autocompleteTokens.find((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
    if (matchedAutocomplete) {
      return { sensitive: true, reason: `autocomplete '${matchedAutocomplete}'` };
    }

    const text = [field.label, field.name, field.id, field.placeholder, field.ariaLabel].map(clean).filter(Boolean).join(" ");
    if (SENSITIVE_PATTERN.test(text)) {
      return { sensitive: true, reason: "field metadata matched sensitive pattern" };
    }

    return { sensitive: false, reason: "" };
  }

  const api = {
    isSensitiveFieldElement,
    isSensitiveFieldDescriptor
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  const root = globalScope || {};
  root.AFFFieldSafety = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));

