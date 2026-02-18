const SETTINGS_KEY = "aiFormFillerSettings";

const ui = {
  actionsView: document.getElementById("actionsView"),
  settingsView: document.getElementById("settingsView"),
  configSummary: document.getElementById("configSummary"),
  apiKey: document.getElementById("apiKey"),
  vectorStoreId: document.getElementById("vectorStoreId"),
  model: document.getElementById("model"),
  saveBtn: document.getElementById("saveBtn"),
  backBtn: document.getElementById("backBtn"),
  openSettingsBtn: document.getElementById("openSettingsBtn"),
  fillBtn: document.getElementById("fillBtn"),
  status: document.getElementById("status"),
  log: document.getElementById("log")
};

function setStatus(message, isError) {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", Boolean(isError));
}

function appendLog(message) {
  const li = document.createElement("li");
  li.textContent = message;
  ui.log.appendChild(li);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function clearLog() {
  ui.log.innerHTML = "";
}

function switchView(view) {
  const actionsActive = view === "actions";
  ui.actionsView.classList.toggle("active", actionsActive);
  ui.settingsView.classList.toggle("active", !actionsActive);
}

async function getSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  return data[SETTINGS_KEY] || {};
}

function summarizeConfig(settings) {
  const hasKey = Boolean(settings.apiKey && settings.apiKey.trim());
  const hasStore = Boolean(settings.vectorStoreId && settings.vectorStoreId.trim());
  const model = settings.model || "gpt-4.1-mini";

  if (hasKey && hasStore) {
    return `Configured. Model: ${model}`;
  }

  return "Not fully configured. Open Configuration.";
}

async function loadSettings() {
  const settings = await getSettings();
  ui.apiKey.value = settings.apiKey || "";
  ui.vectorStoreId.value = settings.vectorStoreId || "";
  ui.model.value = settings.model || "gpt-4.1-mini";
  ui.configSummary.textContent = summarizeConfig(settings);
}

async function saveSettings() {
  const settings = {
    apiKey: ui.apiKey.value.trim(),
    vectorStoreId: ui.vectorStoreId.value.trim(),
    model: ui.model.value.trim() || "gpt-4.1-mini"
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  ui.configSummary.textContent = summarizeConfig(settings);
  setStatus("Configuration saved.", false);
}

function validateInputs() {
  if (!ui.apiKey.value.trim()) {
    throw new Error("OpenAI API key is required.");
  }
  if (!ui.vectorStoreId.value.trim()) {
    throw new Error("Vector Store ID is required.");
  }
}

async function ensureConfigured() {
  const settings = await getSettings();

  if (!settings.apiKey || !settings.apiKey.trim() || !settings.vectorStoreId || !settings.vectorStoreId.trim()) {
    switchView("settings");
    throw new Error("Set API key and Vector Store ID in Configuration first.");
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
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

async function startFill() {
  try {
    setStatus("Preparing autofill...", false);
    clearLog();
    await ensureConfigured();

    const activeTab = await getActiveTab();
    if (!activeTab || !activeTab.id) {
      throw new Error("Unable to find the active browser tab.");
    }

    const response = await runtimeSendMessage({
      type: "START_AUTOFILL",
      tabId: activeTab.id
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Failed to start autofill.");
    }

    setStatus("Autofill started. Processing fields...", false);
  } catch (error) {
    setStatus((error && error.message) || "Unexpected error.", true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "AUTOFILL_PROGRESS") {
    appendLog(message.message);
  }

  if (message.type === "AUTOFILL_STATUS") {
    setStatus(message.message, Boolean(message.error));
  }
});

ui.openSettingsBtn.addEventListener("click", () => {
  switchView("settings");
});

ui.backBtn.addEventListener("click", () => {
  switchView("actions");
});

ui.saveBtn.addEventListener("click", async () => {
  try {
    validateInputs();
    await saveSettings();
    switchView("actions");
  } catch (error) {
    setStatus((error && error.message) || "Could not save settings.", true);
  }
});

ui.fillBtn.addEventListener("click", startFill);

document.addEventListener("DOMContentLoaded", () => {
  loadSettings().catch((error) => {
    setStatus((error && error.message) || "Failed to load settings.", true);
  });
});
