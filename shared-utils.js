(function initAffShared(globalScope) {
  const root = globalScope || {};

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

  function storageGet(keys, area = "local") {
    return new Promise((resolve, reject) => {
      chrome.storage[area].get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function storageSet(items, area = "local") {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(items, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageRemove(keys, area = "local") {
    return new Promise((resolve, reject) => {
      chrome.storage[area].remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
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

  function queryTabs(queryInfo) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tabs || []);
      });
    });
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function createTranslator({ supportedLanguages, settingsKey }) {
    const supported = supportedLanguages || new Set(["default"]);
    let languageMessages = {};
    let languageOverride = "default";

    function getOverrideMessage(key, substitutions) {
      const entry = languageMessages && languageMessages[key];
      const message = entry && entry.message;
      if (!message) {
        return "";
      }
      return applySubstitutions(message, substitutions);
    }

    async function loadLanguageMessages(language) {
      const safeLanguage = supported.has(language) ? language : "default";
      if (safeLanguage === "default") {
        languageOverride = "default";
        languageMessages = {};
        return;
      }

      try {
        const url = chrome.runtime.getURL(`_locales/${safeLanguage}/messages.json`);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Could not load locale file for ${safeLanguage}`);
        }
        languageOverride = safeLanguage;
        languageMessages = await response.json();
      } catch (_error) {
        languageOverride = "default";
        languageMessages = {};
      }
    }

    async function initializeLanguageOverride() {
      try {
        const data = await storageGet([settingsKey], "local");
        const settings = data[settingsKey] || {};
        const preferred = supported.has(settings.language) ? settings.language : "default";
        await loadLanguageMessages(preferred);
      } catch (_error) {
        languageOverride = "default";
        languageMessages = {};
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

    return {
      t,
      loadLanguageMessages,
      initializeLanguageOverride,
      getLanguageOverride: () => languageOverride
    };
  }

  root.AFFShared = {
    applySubstitutions,
    storageGet,
    storageSet,
    storageRemove,
    runtimeSendMessage,
    queryTabs,
    bytesToBase64,
    base64ToBytes,
    createTranslator
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));

