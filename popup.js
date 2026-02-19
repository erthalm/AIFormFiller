const SETTINGS_KEY = "aiFormFillerSettings";
const CRYPTO_KEY_KEY = "aiFormFillerCryptoKey";

const ui = {
  actionsView: document.getElementById("actionsView"),
  settingsView: document.getElementById("settingsView"),
  filesView: document.getElementById("filesView"),

  configSummary: document.getElementById("configSummary"),

  apiKey: document.getElementById("apiKey"),
  vectorStoreId: document.getElementById("vectorStoreId"),
  refreshStoresBtn: document.getElementById("refreshStoresBtn"),
  newStoreName: document.getElementById("newStoreName"),
  createStoreBtn: document.getElementById("createStoreBtn"),
  deleteStoreBtn: document.getElementById("deleteStoreBtn"),
  selectedStoreForDelete: document.getElementById("selectedStoreForDelete"),
  model: document.getElementById("model"),

  saveBtn: document.getElementById("saveBtn"),
  backBtn: document.getElementById("backBtn"),
  openSettingsBtn: document.getElementById("openSettingsBtn"),
  openFilesBtn: document.getElementById("openFilesBtn"),
  fillBtn: document.getElementById("fillBtn"),

  status: document.getElementById("status"),
  log: document.getElementById("log"),

  filesBackBtn: document.getElementById("filesBackBtn"),
  refreshFilesBtn: document.getElementById("refreshFilesBtn"),
  uploadFileBtn: document.getElementById("uploadFileBtn"),
  newFileInput: document.getElementById("newFileInput"),
  replaceFileInput: document.getElementById("replaceFileInput"),
  filesStatus: document.getElementById("filesStatus"),
  filesList: document.getElementById("filesList")
};

let pendingReplaceFileId = null;
let cachedVectorStores = [];
let hasFillableFormOnPage = false;

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

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
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

function setStatus(message, isError) {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", Boolean(isError));
}

function setFilesStatus(message, isError) {
  ui.filesStatus.textContent = message;
  ui.filesStatus.style.color = isError ? "#b91c1c" : "#6b7280";
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
  ui.actionsView.classList.toggle("active", view === "actions");
  ui.settingsView.classList.toggle("active", view === "settings");
  ui.filesView.classList.toggle("active", view === "files");
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

async function getSettings() {
  const data = await storageGet([SETTINGS_KEY]);
  return data[SETTINGS_KEY] || {};
}

async function getOrCreateCryptoKeyRaw() {
  const data = await storageGet([CRYPTO_KEY_KEY]);
  if (data[CRYPTO_KEY_KEY]) {
    return data[CRYPTO_KEY_KEY];
  }

  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const raw = bytesToBase64(keyBytes);
  await storageSet({ [CRYPTO_KEY_KEY]: raw });
  return raw;
}

async function importAesKeyFromRaw(rawBase64) {
  const keyBytes = base64ToBytes(rawBase64);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(plainApiKey) {
  const keyRaw = await getOrCreateCryptoKeyRaw();
  const aesKey = await importAesKeyFromRaw(keyRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(plainApiKey);

  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, payload);

  return {
    v: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuffer))
  };
}

function hasConfiguredApiKey(settings) {
  const hasEncrypted = Boolean(settings.apiKeyEncrypted && settings.apiKeyEncrypted.ciphertext && settings.apiKeyEncrypted.iv);
  const hasLegacyPlain = Boolean(settings.apiKey && settings.apiKey.trim());
  return hasEncrypted || hasLegacyPlain;
}

function summarizeConfig(settings) {
  const hasKey = hasConfiguredApiKey(settings);
  const hasStore = Boolean(settings.vectorStoreId && settings.vectorStoreId.trim());
  const model = settings.model || "gpt-4.1-mini";

  if (hasKey && hasStore) {
    return `Configured. Model: ${model}`;
  }

  return "Not fully configured. Open Configuration.";
}

function updateStoreActionsState() {
  const hasSelection = Boolean((ui.vectorStoreId.value || "").trim());
  ui.deleteStoreBtn.disabled = !hasSelection;
  ui.fillBtn.disabled = !hasSelection;
  ui.openFilesBtn.disabled = !hasSelection;

  const selectedOption = ui.vectorStoreId.options[ui.vectorStoreId.selectedIndex];
  const selectedName = hasSelection && selectedOption ? selectedOption.textContent : "None";
  ui.selectedStoreForDelete.textContent = selectedName;

  if (!hasSelection) {
    ui.deleteStoreBtn.textContent = "Delete Database";
    return;
  }

  const normalizedName = selectedName.replace(/\s+/g, " ").trim();
  const shortName = normalizedName.length > 26 ? `${normalizedName.slice(0, 26)}...` : normalizedName;
  ui.deleteStoreBtn.textContent = `Delete "${shortName}"`;
}

async function refreshFillAvailability() {
  hasFillableFormOnPage = false;

  try {
    const activeTab = await getActiveTab();
    const tabId = activeTab && activeTab.id;
    if (!Number.isInteger(tabId)) {
      updateStoreActionsState();
      return;
    }

    const response = await runtimeSendMessage({
      type: "GET_TAB_FORM_AVAILABILITY",
      tabId
    });

    hasFillableFormOnPage = Boolean(response && response.ok && response.hasForm);
  } catch (_error) {
    hasFillableFormOnPage = false;
  }

  updateStoreActionsState();
}

async function loadSettings() {
  const settings = await getSettings();
  ui.apiKey.value = "";
  ui.apiKey.placeholder = hasConfiguredApiKey(settings) ? "Stored securely (leave blank to keep current)" : "sk-...";
  ui.model.value = settings.model || "gpt-4.1-mini";
  ui.configSummary.textContent = summarizeConfig(settings);
  const savedStoreId = settings.vectorStoreId || "";
  const savedStoreName = settings.vectorStoreName || "Selected file database";
  cachedVectorStores = savedStoreId ? [{ id: savedStoreId, name: savedStoreName }] : [];
  populateVectorStoreSelect(cachedVectorStores, savedStoreId);
}

function populateVectorStoreSelect(stores, selectedId) {
  ui.vectorStoreId.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = stores.length ? "Select a file database..." : "No file databases available";
  ui.vectorStoreId.appendChild(placeholder);

  stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = store.name || "Unnamed file database";
    ui.vectorStoreId.appendChild(option);
  });

  if (selectedId && !stores.some((store) => store.id === selectedId)) {
    const fallback = document.createElement("option");
    fallback.value = selectedId;
    fallback.textContent = "Previously selected vector store";
    ui.vectorStoreId.appendChild(fallback);
  }

  ui.vectorStoreId.value = selectedId || "";
  updateStoreActionsState();
}

async function refreshVectorStores(selectedId) {
  const settings = await getSettings();
  const preferredId = selectedId || settings.vectorStoreId || "";
  const typedApiKey = ui.apiKey.value.trim();
  const hasAnyApiKey = hasConfiguredApiKey(settings) || Boolean(typedApiKey);

  if (!hasAnyApiKey) {
    cachedVectorStores = [];
    populateVectorStoreSelect([], preferredId);
    setStatus("Add an API key in Configuration, then refresh file databases.", true);
    return;
  }

  try {
    ui.refreshStoresBtn.disabled = true;
    const response = await runtimeSendMessage({
      type: "VECTOR_STORES_LIST",
      apiKey: typedApiKey || undefined
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Could not load file databases.");
    }

    cachedVectorStores = Array.isArray(response.vectorStores) ? response.vectorStores : [];
    populateVectorStoreSelect(cachedVectorStores, preferredId);
    setStatus(`Loaded ${cachedVectorStores.length} file database(s).`, false);
  } catch (error) {
    cachedVectorStores = [];
    populateVectorStoreSelect([], preferredId);
    setStatus((error && error.message) || "Could not load file databases.", true);
  } finally {
    ui.refreshStoresBtn.disabled = false;
  }
}

async function createVectorStore() {
  const name = (ui.newStoreName.value || "").trim();
  if (!name) {
    throw new Error("Enter a name for the new file database.");
  }

  const response = await runtimeSendMessage({
    type: "VECTOR_STORES_CREATE",
    name
  });

  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Could not create file database.");
  }

  ui.newStoreName.value = "";
  await refreshVectorStores(response.vectorStoreId || "");
  if (response.vectorStoreId) {
    ui.vectorStoreId.value = response.vectorStoreId;
  }
  setStatus("File database created.", false);
}

async function validateApiKeyBeforeSave(existingSettings) {
  const typedApiKey = ui.apiKey.value.trim();
  const hasSavedKey = hasConfiguredApiKey(existingSettings);

  if (!typedApiKey && hasSavedKey) {
    return;
  }

  if (!typedApiKey && !hasSavedKey) {
    throw new Error("OpenAI API key is required.");
  }

  const payload = {
    type: "VALIDATE_API_KEY",
    apiKey: typedApiKey
  };

  const response = await runtimeSendMessage(payload);
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Invalid OpenAI API key.");
  }
}

async function persistSelectedVectorStore(selectedStoreId) {
  const settings = await getSettings();
  const selectedId = (selectedStoreId || "").trim();
  const selectedStore = cachedVectorStores.find((store) => store.id === selectedId);

  const updatedSettings = {
    ...settings,
    vectorStoreId: selectedId,
    vectorStoreName: selectedStore ? (selectedStore.name || "") : ""
  };

  await storageSet({ [SETTINGS_KEY]: updatedSettings });
  ui.configSummary.textContent = summarizeConfig(updatedSettings);
}

async function syncSelectedStoreToSettings() {
  const selectedId = (ui.vectorStoreId.value || "").trim();
  if (!selectedId) {
    return;
  }

  const settings = await getSettings();
  if ((settings.vectorStoreId || "") === selectedId) {
    return;
  }

  await persistSelectedVectorStore(selectedId);
}

async function clearStoredVectorStoreIfMatches(storeId) {
  const settings = await getSettings();
  if ((settings.vectorStoreId || "") !== (storeId || "")) {
    return;
  }

  const updatedSettings = {
    ...settings,
    vectorStoreId: "",
    vectorStoreName: ""
  };
  await storageSet({ [SETTINGS_KEY]: updatedSettings });
  ui.configSummary.textContent = summarizeConfig(updatedSettings);
}

async function deleteSelectedVectorStore() {
  const selectedStoreId = (ui.vectorStoreId.value || "").trim();
  if (!selectedStoreId) {
    throw new Error("Select a file database first.");
  }

  const selectedOption = ui.vectorStoreId.options[ui.vectorStoreId.selectedIndex];
  const selectedStoreName = (selectedOption && selectedOption.textContent) || "selected file database";

  const preview = await runtimeSendMessage({
    type: "VECTOR_STORE_DELETE_PREVIEW",
    vectorStoreId: selectedStoreId
  });
  if (!preview || !preview.ok) {
    throw new Error((preview && preview.error) || "Could not preview deletion.");
  }

  const fileCount = Number(preview.fileCount || 0);
  if (fileCount > 0) {
    const shouldDelete = window.confirm(
      `Delete "${selectedStoreName}"?\n\nThis will also delete ${fileCount} file(s) in this file database.\nThis action cannot be undone.`
    );
    if (!shouldDelete) {
      return;
    }
  }

  setStatus("Deleting file database and files...", false);
  const response = await runtimeSendMessage({
    type: "VECTOR_STORE_DELETE",
    vectorStoreId: selectedStoreId
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Could not delete file database.");
  }

  await clearStoredVectorStoreIfMatches(selectedStoreId);
  await refreshVectorStores("");
  ui.vectorStoreId.value = "";
  setStatus(`Deleted "${selectedStoreName}" and ${fileCount} file(s).`, false);
}

async function saveSettings() {
  const existingSettings = await getSettings();
  const typedApiKey = ui.apiKey.value.trim();

  let apiKeyEncrypted = existingSettings.apiKeyEncrypted || null;
  if (typedApiKey) {
    apiKeyEncrypted = await encryptApiKey(typedApiKey);
  }

  const settings = {
    apiKeyEncrypted,
    vectorStoreId: ui.vectorStoreId.value.trim(),
    vectorStoreName: (cachedVectorStores.find((store) => store.id === ui.vectorStoreId.value) || {}).name || "",
    model: ui.model.value || "gpt-4.1-mini"
  };

  await storageSet({ [SETTINGS_KEY]: settings });

  ui.apiKey.value = "";
  ui.apiKey.placeholder = hasConfiguredApiKey(settings) ? "Stored securely (leave blank to keep current)" : "sk-...";
  ui.configSummary.textContent = summarizeConfig(settings);
}

function validateInputs(existingSettings) {
  const typedApiKey = ui.apiKey.value.trim();
  const hasSavedKey = hasConfiguredApiKey(existingSettings);

  if (!typedApiKey && !hasSavedKey) {
    throw new Error("OpenAI API key is required.");
  }
}

async function ensureConfigured() {
  await syncSelectedStoreToSettings();
  const settings = await getSettings();

  if (!hasConfiguredApiKey(settings) || !settings.vectorStoreId || !settings.vectorStoreId.trim()) {
    switchView("settings");
    throw new Error("Set API key and File Database in Configuration first.");
  }
}

async function getActiveTab() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
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

async function fileToPayload(file) {
  const buffer = await file.arrayBuffer();
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    base64: bytesToBase64(new Uint8Array(buffer))
  };
}

function formatDate(epochSeconds) {
  if (!epochSeconds) {
    return "-";
  }
  return new Date(epochSeconds * 1000).toLocaleString();
}

function renderFiles(files) {
  ui.filesList.innerHTML = "";

  if (!files.length) {
    const item = document.createElement("li");
    item.className = "file-item";
    item.textContent = "No files available.";
    ui.filesList.appendChild(item);
    return;
  }

  files.forEach((file) => {
    const item = document.createElement("li");
    item.className = "file-item";

    const title = document.createElement("div");
    title.className = "file-title";
    title.textContent = file.filename || file.name || "File name unavailable";

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = `status: ${file.status || "unknown"} | created: ${formatDate(file.created_at)}`;

    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";

    const replaceBtn = document.createElement("button");
    replaceBtn.className = "secondary";
    replaceBtn.type = "button";
    replaceBtn.textContent = "Update";
    replaceBtn.addEventListener("click", () => {
      pendingReplaceFileId = file.file_id || file.id;
      ui.replaceFileInput.value = "";
      ui.replaceFileInput.click();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "secondary";
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      handleDeleteFile(file.file_id || file.id);
    });

    rowActions.appendChild(replaceBtn);
    rowActions.appendChild(deleteBtn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(rowActions);

    ui.filesList.appendChild(item);
  });
}

async function refreshFiles() {
  try {
    await ensureConfigured();
    setFilesStatus("Loading files...", false);

    const response = await runtimeSendMessage({ type: "VECTOR_FILES_LIST" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Failed to load files.");
    }

    renderFiles(response.files || []);
    setFilesStatus(`Loaded ${response.files.length} file(s).`, false);
  } catch (error) {
    renderFiles([]);
    setFilesStatus((error && error.message) || "Failed to load files.", true);
  }
}

async function handleUploadFile() {
  try {
    await ensureConfigured();

    const file = ui.newFileInput.files && ui.newFileInput.files[0];
    if (!file) {
      throw new Error("Choose a file first.");
    }

    setFilesStatus("Uploading file...", false);
    const payload = await fileToPayload(file);
    const response = await runtimeSendMessage({ type: "VECTOR_FILES_ADD", file: payload });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Upload failed.");
    }

    ui.newFileInput.value = "";
    setFilesStatus("File uploaded and attached.", false);
    await refreshFiles();
  } catch (error) {
    setFilesStatus((error && error.message) || "Upload failed.", true);
  }
}

async function handleDeleteFile(fileId) {
  try {
    await ensureConfigured();
    setFilesStatus("Deleting file...", false);

    const response = await runtimeSendMessage({ type: "VECTOR_FILES_DELETE", fileId });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Delete failed.");
    }

    setFilesStatus("File deleted.", false);
    await refreshFiles();
  } catch (error) {
    setFilesStatus((error && error.message) || "Delete failed.", true);
  }
}

async function handleReplaceFile(fileId, replacementFile) {
  try {
    await ensureConfigured();
    setFilesStatus("Updating file...", false);

    const payload = await fileToPayload(replacementFile);
    const response = await runtimeSendMessage({
      type: "VECTOR_FILES_UPDATE",
      fileId,
      file: payload
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Update failed.");
    }

    setFilesStatus("File updated.", false);
    await refreshFiles();
  } catch (error) {
    setFilesStatus((error && error.message) || "Update failed.", true);
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

ui.openFilesBtn.addEventListener("click", async () => {
  try {
    await ensureConfigured();
    switchView("files");
    await refreshFiles();
  } catch (error) {
    setStatus((error && error.message) || "Configuration is incomplete.", true);
  }
});

ui.filesBackBtn.addEventListener("click", () => {
  switchView("actions");
});

ui.refreshFilesBtn.addEventListener("click", refreshFiles);
ui.uploadFileBtn.addEventListener("click", handleUploadFile);
ui.refreshStoresBtn.addEventListener("click", async () => {
  await refreshVectorStores(ui.vectorStoreId.value);
});

ui.vectorStoreId.addEventListener("change", () => {
  updateStoreActionsState();
  persistSelectedVectorStore(ui.vectorStoreId.value).catch((error) => {
    setStatus((error && error.message) || "Could not save file database selection.", true);
  });
});

ui.createStoreBtn.addEventListener("click", async () => {
  try {
    await createVectorStore();
  } catch (error) {
    setStatus((error && error.message) || "Could not create file database.", true);
  }
});

ui.deleteStoreBtn.addEventListener("click", async () => {
  try {
    await deleteSelectedVectorStore();
  } catch (error) {
    setStatus((error && error.message) || "Could not delete file database.", true);
  }
});

ui.replaceFileInput.addEventListener("change", async () => {
  const file = ui.replaceFileInput.files && ui.replaceFileInput.files[0];
  if (!file || !pendingReplaceFileId) {
    return;
  }

  const fileId = pendingReplaceFileId;
  pendingReplaceFileId = null;
  ui.replaceFileInput.value = "";
  await handleReplaceFile(fileId, file);
});

ui.saveBtn.addEventListener("click", async () => {
  try {
    const existingSettings = await getSettings();
    validateInputs(existingSettings);
    await validateApiKeyBeforeSave(existingSettings);
    await saveSettings();
    switchView("actions");
  } catch (error) {
    setStatus((error && error.message) || "Could not save settings.", true);
  }
});

ui.fillBtn.addEventListener("click", startFill);

document.addEventListener("DOMContentLoaded", () => {
  loadSettings()
    .then(() => refreshFillAvailability())
    .catch((error) => {
      setStatus((error && error.message) || "Failed to load settings.", true);
      updateStoreActionsState();
    });
});
