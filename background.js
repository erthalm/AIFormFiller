const SETTINGS_KEY = "aiFormFillerSettings";
const CRYPTO_KEY_KEY = "aiFormFillerCryptoKey";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_FILES_URL = "https://api.openai.com/v1/files";

function safeRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, () => {
      resolve();
    });
  });
}

function tabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKeyFromRaw(rawBase64) {
  const keyBytes = base64ToBytes(rawBase64);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptApiKey(encryptedPayload) {
  if (!encryptedPayload || !encryptedPayload.ciphertext || !encryptedPayload.iv) {
    return "";
  }

  const data = await chrome.storage.local.get([CRYPTO_KEY_KEY]);
  const keyRaw = data[CRYPTO_KEY_KEY];
  if (!keyRaw) {
    throw new Error("Encrypted API key exists but cryptographic key is missing. Re-save configuration.");
  }

  const aesKey = await importAesKeyFromRaw(keyRaw);
  const iv = base64ToBytes(encryptedPayload.iv);
  const ciphertext = base64ToBytes(encryptedPayload.ciphertext);

  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plainBuffer).trim();
}

async function getSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = data[SETTINGS_KEY] || {};

  let apiKey = "";
  if (settings.apiKeyEncrypted) {
    apiKey = await decryptApiKey(settings.apiKeyEncrypted);
  } else if (settings.apiKey) {
    apiKey = settings.apiKey.trim();
  }

  return {
    apiKey,
    vectorStoreId: settings.vectorStoreId || "",
    model: settings.model || "gpt-4.1-mini"
  };
}

function fieldDisplayName(field) {
  return field.label || field.name || field.placeholder || field.id || `${field.tag || "field"}`;
}

function parseOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (typeof chunk?.text === "string" && chunk.text.trim()) {
        return chunk.text.trim();
      }
    }
  }

  return "";
}

function cleanModelAnswer(answer) {
  const stripped = (answer || "").trim().replace(/^"|"$/g, "");
  if (!stripped) {
    return "";
  }
  if (/^NOT_FOUND$/i.test(stripped)) {
    return "";
  }
  return stripped;
}

function classifyHttpError(status) {
  if (status === 401 || status === 403) {
    return "Authentication failed. Check your API key.";
  }
  if (status === 429) {
    return "Rate limited by OpenAI. Please retry shortly.";
  }
  if (status >= 500) {
    return "OpenAI service error. Please try again.";
  }
  return `OpenAI request failed with status ${status}.`;
}

function encodeURIComponentSafe(value) {
  return encodeURIComponent(String(value || ""));
}

async function parseErrorDetails(response) {
  try {
    const err = await response.json();
    return err?.error?.message || "";
  } catch (_ignored) {
    return "";
  }
}

function buildOpenAIHeaders(apiKey, useJson, useAssistantsBeta) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };

  if (useJson) {
    headers["Content-Type"] = "application/json";
  }
  if (useAssistantsBeta) {
    headers["OpenAI-Beta"] = "assistants=v2";
  }

  return headers;
}

async function queryFieldAnswer({ apiKey, vectorStoreId, model, field }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  const fieldContext = {
    label: field.label,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    type: field.type,
    tag: field.tag,
    required: field.required,
    options: field.options || []
  };

  const body = {
    model,
    temperature: 0,
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId]
      }
    ],
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You fill web form fields from retrieved documents. Return only the best value for the target field, with no explanation. If not found, return NOT_FOUND."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Target form field metadata: ${JSON.stringify(fieldContext)}\nRespond with only the value for this field. For select fields, return one option from the provided options.`
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const details = await parseErrorDetails(response);
      throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
    }

    const json = await response.json();
    return cleanModelAnswer(parseOutputText(json));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("OpenAI request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadFileToOpenAI({ apiKey, file }) {
  if (!file?.filename || !file?.base64) {
    throw new Error("Invalid file payload.");
  }

  const bytes = base64ToBytes(file.base64);
  const blob = new Blob([bytes], { type: file.mimeType || "application/octet-stream" });
  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", blob, file.filename);

  const response = await fetch(OPENAI_FILES_URL, {
    method: "POST",
    headers: buildOpenAIHeaders(apiKey, false, false),
    body: formData
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }

  return response.json();
}

async function attachFileToVectorStore({ apiKey, vectorStoreId, fileId }) {
  const response = await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponentSafe(vectorStoreId)}/files`, {
    method: "POST",
    headers: buildOpenAIHeaders(apiKey, true, true),
    body: JSON.stringify({ file_id: fileId })
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }

  return response.json();
}

async function detachFileFromVectorStore({ apiKey, vectorStoreId, fileId }) {
  const response = await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponentSafe(vectorStoreId)}/files/${encodeURIComponentSafe(fileId)}`, {
    method: "DELETE",
    headers: buildOpenAIHeaders(apiKey, false, true)
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }
}

async function deleteOpenAIFile({ apiKey, fileId }) {
  const response = await fetch(`${OPENAI_FILES_URL}/${encodeURIComponentSafe(fileId)}`, {
    method: "DELETE",
    headers: buildOpenAIHeaders(apiKey, false, false)
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }
}

async function listAllVectorStoreFilesRaw({ apiKey, vectorStoreId }) {
  const allFiles = [];
  let after = "";

  while (true) {
    const afterQuery = after ? `&after=${encodeURIComponentSafe(after)}` : "";
    const response = await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponentSafe(vectorStoreId)}/files?limit=100${afterQuery}`, {
      method: "GET",
      headers: buildOpenAIHeaders(apiKey, false, true)
    });

    if (!response.ok) {
      const details = await parseErrorDetails(response);
      throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
    }

    const payload = await response.json();
    const pageFiles = Array.isArray(payload?.data) ? payload.data : [];
    allFiles.push(...pageFiles);

    const hasMore = Boolean(payload?.has_more);
    if (!hasMore || pageFiles.length === 0) {
      break;
    }

    const last = pageFiles[pageFiles.length - 1];
    if (!last || !last.id) {
      break;
    }
    after = last.id;
  }

  return allFiles;
}

async function listVectorStoreFiles({ apiKey, vectorStoreId }) {
  const [vsFiles, allFilesResponse] = await Promise.all([
    listAllVectorStoreFilesRaw({ apiKey, vectorStoreId }),
    fetch(`${OPENAI_FILES_URL}?limit=100`, {
      method: "GET",
      headers: buildOpenAIHeaders(apiKey, false, false)
    })
  ]);

  const fileNameById = {};
  if (allFilesResponse.ok) {
    try {
      const filesPayload = await allFilesResponse.json();
      const allFiles = Array.isArray(filesPayload?.data) ? filesPayload.data : [];
      allFiles.forEach((file) => {
        if (file?.id && file?.filename) {
          fileNameById[file.id] = file.filename;
        }
      });
    } catch (_ignored) {
      // Keep graceful fallback behavior.
    }
  }

  return vsFiles.map((item) => {
    const itemFileId = item?.file_id || item?.id || "";
    const payloadFilename = item?.filename || item?.name || item?.attributes?.filename || "";
    const resolvedFilename = payloadFilename || fileNameById[itemFileId] || "";

    return {
      ...item,
      filename: resolvedFilename
    };
  });
}

async function listVectorStores({ apiKey }) {
  const response = await fetch("https://api.openai.com/v1/vector_stores?limit=100", {
    method: "GET",
    headers: buildOpenAIHeaders(apiKey, false, true)
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function createVectorStore({ apiKey, name }) {
  const response = await fetch("https://api.openai.com/v1/vector_stores", {
    method: "POST",
    headers: buildOpenAIHeaders(apiKey, true, true),
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }

  return response.json();
}

async function processAutofill(tabId) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();
  const model = settings.model?.trim() || "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!vectorStoreId) {
    throw new Error("Vector Store ID is missing. Add it in the extension popup.");
  }

  const fieldsResponse = await tabMessage(tabId, { type: "GET_FORM_FIELDS" });
  if (!fieldsResponse?.ok) {
    throw new Error(fieldsResponse?.error || "Unable to read form fields from page.");
  }

  const fields = Array.isArray(fieldsResponse.fields) ? fieldsResponse.fields : [];
  if (!fields.length) {
    await safeRuntimeMessage({ type: "AUTOFILL_STATUS", message: "No supported editable fields found on this page.", error: false });
    return;
  }

  await safeRuntimeMessage({ type: "AUTOFILL_STATUS", message: `Found ${fields.length} field(s). Filling now...`, error: false });

  let filled = 0;
  let skipped = 0;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const label = fieldDisplayName(field);

    await safeRuntimeMessage({ type: "AUTOFILL_PROGRESS", message: `[${i + 1}/${fields.length}] Searching: ${label}` });

    let answer;
    try {
      answer = await queryFieldAnswer({ apiKey, vectorStoreId, model, field });
    } catch (error) {
      await safeRuntimeMessage({ type: "AUTOFILL_PROGRESS", message: `[${i + 1}/${fields.length}] Error: ${label} -> ${error.message || "request failed"}` });
      skipped += 1;
      continue;
    }

    if (!answer) {
      await safeRuntimeMessage({ type: "AUTOFILL_PROGRESS", message: `[${i + 1}/${fields.length}] Not found: ${label}` });
      skipped += 1;
      continue;
    }

    const fillResponse = await tabMessage(tabId, { type: "FILL_FORM_FIELD", uid: field.uid, value: answer });
    if (!fillResponse?.ok) {
      await safeRuntimeMessage({ type: "AUTOFILL_PROGRESS", message: `[${i + 1}/${fields.length}] Could not fill: ${label} (${fillResponse?.error || "unknown error"})` });
      skipped += 1;
      continue;
    }

    filled += 1;
    await safeRuntimeMessage({ type: "AUTOFILL_PROGRESS", message: `[${i + 1}/${fields.length}] Filled: ${label}` });
  }

  await safeRuntimeMessage({ type: "AUTOFILL_STATUS", message: `Completed. Filled ${filled}, skipped ${skipped}.`, error: false });
}

async function processSingleField(field) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();
  const model = settings.model?.trim() || "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!vectorStoreId) {
    throw new Error("Vector Store ID is missing. Add it in the extension popup.");
  }
  if (!field || typeof field !== "object") {
    throw new Error("Invalid field payload.");
  }

  const answer = await queryFieldAnswer({ apiKey, vectorStoreId, model, field });
  if (!answer) {
    return { ok: true, found: false };
  }

  return { ok: true, found: true, value: answer };
}

async function processVectorFilesList() {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!vectorStoreId) {
    throw new Error("Vector Store ID is missing. Add it in the extension popup.");
  }

  const files = await listVectorStoreFiles({ apiKey, vectorStoreId });
  return { ok: true, files };
}

async function processVectorFileAdd(file) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!vectorStoreId) {
    throw new Error("Vector Store ID is missing. Add it in the extension popup.");
  }

  const uploaded = await uploadFileToOpenAI({ apiKey, file });
  await attachFileToVectorStore({ apiKey, vectorStoreId, fileId: uploaded.id });
  return { ok: true };
}

async function processVectorFileDelete(fileId) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!vectorStoreId) {
    throw new Error("Vector Store ID is missing. Add it in the extension popup.");
  }
  if (!fileId) {
    throw new Error("Missing file id.");
  }

  await detachFileFromVectorStore({ apiKey, vectorStoreId, fileId });

  try {
    await deleteOpenAIFile({ apiKey, fileId });
  } catch (_ignored) {
    // Detach is the primary vector store action.
  }

  return { ok: true };
}

async function processVectorFileUpdate(fileId, file) {
  await processVectorFileDelete(fileId);
  await processVectorFileAdd(file);
  return { ok: true };
}

async function processVectorStoresList() {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }

  const stores = await listVectorStores({ apiKey });
  const vectorStores = stores.map((store) => ({
    id: store.id,
    name: store.name || ""
  }));
  return { ok: true, vectorStores };
}

async function processVectorStoreCreate(name) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }

  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    throw new Error("Name is required.");
  }

  const created = await createVectorStore({ apiKey, name: trimmedName });
  return {
    ok: true,
    vectorStoreId: created?.id || "",
    vectorStoreName: created?.name || trimmedName
  };
}

async function processVectorStoreDeletePreview(vectorStoreId) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const selectedVectorStoreId = (vectorStoreId || settings.vectorStoreId || "").trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!selectedVectorStoreId) {
    throw new Error("No file database selected.");
  }

  const files = await listAllVectorStoreFilesRaw({ apiKey, vectorStoreId: selectedVectorStoreId });
  return {
    ok: true,
    fileCount: files.length
  };
}

async function deleteVectorStore({ apiKey, vectorStoreId }) {
  const response = await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponentSafe(vectorStoreId)}`, {
    method: "DELETE",
    headers: buildOpenAIHeaders(apiKey, false, true)
  });

  if (!response.ok) {
    const details = await parseErrorDetails(response);
    throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
  }
}

async function processVectorStoreDelete(vectorStoreId) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const selectedVectorStoreId = (vectorStoreId || settings.vectorStoreId || "").trim();

  if (!apiKey) {
    throw new Error("OpenAI API key is missing. Add it in the extension popup.");
  }
  if (!selectedVectorStoreId) {
    throw new Error("No file database selected.");
  }

  const files = await listAllVectorStoreFilesRaw({ apiKey, vectorStoreId: selectedVectorStoreId });
  const uniqueFileIds = Array.from(
    new Set(
      files
        .map((item) => item?.file_id || "")
        .filter(Boolean)
    )
  );

  for (let i = 0; i < uniqueFileIds.length; i += 1) {
    const fileId = uniqueFileIds[i];
    try {
      await detachFileFromVectorStore({ apiKey, vectorStoreId: selectedVectorStoreId, fileId });
    } catch (_ignored) {
      // Continue deleting remaining files.
    }
    try {
      await deleteOpenAIFile({ apiKey, fileId });
    } catch (_ignored) {
      // Continue deleting remaining files.
    }
  }

  await deleteVectorStore({ apiKey, vectorStoreId: selectedVectorStoreId });
  return { ok: true, deletedFiles: uniqueFileIds.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "START_AUTOFILL") {
    const tabId = message.tabId;

    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Invalid tab identifier." });
      return;
    }

    processAutofill(tabId)
      .then(() => {})
      .catch(async (error) => {
        await safeRuntimeMessage({ type: "AUTOFILL_STATUS", message: error.message || "Autofill failed.", error: true });
      });

    sendResponse({ ok: true });
    return;
  }

  if (message.type === "FILL_SINGLE_FIELD") {
    processSingleField(message.field)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not fill field." }));
    return true;
  }

  if (message.type === "VECTOR_FILES_LIST") {
    processVectorFilesList()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not list files." }));
    return true;
  }

  if (message.type === "VECTOR_FILES_ADD") {
    processVectorFileAdd(message.file)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not add file." }));
    return true;
  }

  if (message.type === "VECTOR_FILES_DELETE") {
    processVectorFileDelete(message.fileId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not delete file." }));
    return true;
  }

  if (message.type === "VECTOR_FILES_UPDATE") {
    processVectorFileUpdate(message.fileId, message.file)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not update file." }));
    return true;
  }

  if (message.type === "VECTOR_STORES_LIST") {
    processVectorStoresList()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not list vector stores." }));
    return true;
  }

  if (message.type === "VECTOR_STORES_CREATE") {
    processVectorStoreCreate(message.name)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not create vector store." }));
    return true;
  }

  if (message.type === "VECTOR_STORE_DELETE_PREVIEW") {
    processVectorStoreDeletePreview(message.vectorStoreId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not prepare deletion preview." }));
    return true;
  }

  if (message.type === "VECTOR_STORE_DELETE") {
    processVectorStoreDelete(message.vectorStoreId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not delete file database." }));
    return true;
  }
});
