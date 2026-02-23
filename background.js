importScripts("shared-utils.js", "lib/field-safety.js");

const SETTINGS_KEY = "aiFormFillerSettings";
const CRYPTO_KEY_KEY = "aiFormFillerCryptoKey";
const SESSION_SETTINGS_KEY = "aiFormFillerSessionSettings";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const ACTION_ICON = {
  16: "icon128x128_green.png",
  32: "icon128x128_green.png",
  48: "icon128x128_green.png",
  128: "icon128x128_green.png"
};
const SUPPORTED_LANGUAGE_OVERRIDES = new Set(["default", "en", "pt_BR", "es"]);
const { storageGet, runtimeSendMessage, base64ToBytes, createTranslator } = self.AFFShared;
const { isSensitiveFieldDescriptor } = self.AFFFieldSafety;
const AUTOFILL_BATCH_SIZE = 4;
const AUTOFILL_MAX_CONCURRENCY = 2;
const AUTOFILL_RETRIES = 3;

const i18n = createTranslator({
  supportedLanguages: SUPPORTED_LANGUAGE_OVERRIDES,
  settingsKey: SETTINGS_KEY
});

const t = i18n.t;

function safeRuntimeMessage(message) {
  return runtimeSendMessage(message).catch(() => undefined);
}

function actionSetIcon(details) {
  return new Promise((resolve) => {
    chrome.action.setIcon(details, () => {
      resolve();
    });
  });
}

function actionSetTitle(details) {
  return new Promise((resolve) => {
    chrome.action.setTitle(details, () => {
      resolve();
    });
  });
}

async function ensureContentScriptInjected(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  try {
    const markerResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__aiFormFillerContentLoaded)
    });
    const alreadyInjected = Boolean(markerResult && markerResult[0] && markerResult[0].result);
    if (alreadyInjected) {
      return true;
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["shared-utils.js", "lib/field-safety.js", "content.js"]
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function tabMessage(tabId, message) {
  return ensureContentScriptInjected(tabId).then((injected) => {
    if (!injected) {
      throw new Error(t("errCouldNotInjectPageScript", undefined, "Could not run on this page. Open a regular web page and try again."));
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  });
}

async function detectTabHasFillableForm(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  try {
    const quickResponse = await tabMessage(tabId, { type: "HAS_FILLABLE_FORMS" });
    if (quickResponse?.ok) {
      return Boolean(quickResponse.hasForm);
    }

    const fallback = await tabMessage(tabId, { type: "GET_FORM_FIELDS" });
    const fields = Array.isArray(fallback?.fields) ? fallback.fields : [];
    return Boolean(fallback?.ok && fields.length > 0);
  } catch (_error) {
    return false;
  }
}

async function updateActionStateForTab(tabId) {
  const hasForm = await detectTabHasFillableForm(tabId);
  await updateActionStateForTabKnownValue(tabId, hasForm);
  return hasForm;
}

async function updateActionStateForTabKnownValue(tabId, hasForm) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await actionSetIcon({ tabId, path: ACTION_ICON });
  await actionSetTitle({
    tabId,
    title: hasForm
      ? t("actionTitleFormDetected", undefined, "AI Form Filler: form detected")
      : t("actionTitleNoFormDetected", undefined, "AI Form Filler: no fillable form on this page")
  });
}

async function importAesKeyFromRaw(rawBase64) {
  const keyBytes = base64ToBytes(rawBase64);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptApiKey(encryptedPayload) {
  if (!encryptedPayload || !encryptedPayload.ciphertext || !encryptedPayload.iv) {
    return "";
  }

  const data = await storageGet([CRYPTO_KEY_KEY]);
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
  const [localData, sessionData] = await Promise.all([
    storageGet([SETTINGS_KEY], "local"),
    storageGet([SESSION_SETTINGS_KEY], "session")
  ]);
  const settings = localData[SETTINGS_KEY] || {};
  const sessionSettings = sessionData[SESSION_SETTINGS_KEY] || {};
  const storageMode = settings.apiKeyStorageMode === "session" ? "session" : "persistent";

  let apiKey = "";
  if (storageMode === "session") {
    apiKey = String(sessionSettings.apiKey || "").trim();
  }

  if (!apiKey && settings.apiKeyEncrypted) {
    apiKey = await decryptApiKey(settings.apiKeyEncrypted);
  } else if (!apiKey && settings.apiKey) {
    apiKey = settings.apiKey.trim();
  }

  return {
    apiKey,
    apiKeyStorageMode: storageMode,
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
    return t("errAuthFailedCheckApiKey", undefined, "Authentication failed. Check your API key.");
  }
  if (status === 429) {
    return t("errRateLimitedRetry", undefined, "Rate limited by OpenAI. Please retry shortly.");
  }
  if (status >= 500) {
    return t("errOpenAiService", undefined, "OpenAI service error. Please try again.");
  }
  return t("errOpenAiStatus", [String(status)], `OpenAI request failed with status ${status}.`);
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

function createHttpError(status, details) {
  const error = new Error(`${classifyHttpError(status)}${details ? ` ${details}` : ""}`);
  error.status = status;
  return error;
}

function extractJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) {
    return null;
  }

  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : input;

  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch (_ignored) {
        return null;
      }
    }
    return null;
  }
}

function shouldRetry(error) {
  const status = Number(error && error.status);
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(work, attempts = AUTOFILL_RETRIES) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }
      const delay = Math.min(5000, 400 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 120);
      await sleep(delay);
    }
  }
  throw lastError;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const workers = [];

  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) {
          break;
        }
        await worker(next);
      }
    })());
  }

  await Promise.all(workers);
}

function fieldFingerprint(field) {
  return JSON.stringify({
    label: String(field.label || "").trim().toLowerCase(),
    name: String(field.name || "").trim().toLowerCase(),
    id: String(field.id || "").trim().toLowerCase(),
    placeholder: String(field.placeholder || "").trim().toLowerCase(),
    type: String(field.type || "").trim().toLowerCase(),
    tag: String(field.tag || "").trim().toLowerCase(),
    options: Array.isArray(field.options)
      ? field.options.map((option) => String(option || "").trim().toLowerCase()).slice(0, 50)
      : []
  });
}

async function queryFieldBatchAnswers({ apiKey, vectorStoreId, model, fields }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  const fieldContext = fields.map((field) => ({
    uid: field.uid,
    label: field.label,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    type: field.type,
    tag: field.tag,
    required: field.required,
    options: field.options || []
  }));

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
            text: "You fill web form fields from retrieved documents. Return strict JSON only. Keys must be the uid values provided. Value must be best match, or NOT_FOUND."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Return a JSON object only for these fields: ${JSON.stringify(fieldContext)}. For select fields, return one option from options.`
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
      throw createHttpError(response.status, details);
    }

    const json = await response.json();
    const parsed = extractJsonObject(parseOutputText(json));
    if (!parsed || typeof parsed !== "object") {
      throw new Error(t("errInvalidModelOutput", undefined, "Model response format was invalid."));
    }

    const answersByUid = {};
    fields.forEach((field) => {
      const raw = parsed[field.uid];
      answersByUid[field.uid] = cleanModelAnswer(typeof raw === "string" ? raw : "");
    });
    return answersByUid;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(t("errOpenAiTimeout", undefined, "OpenAI request timed out."));
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadFileToOpenAI({ apiKey, file }) {
  if (!file?.filename || !file?.base64) {
    throw new Error(t("errInvalidFilePayload", undefined, "Invalid file payload."));
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
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!vectorStoreId) {
    throw new Error(t("errVectorStoreMissingPopup", undefined, "Vector Store ID is missing. Add it in the extension popup."));
  }

  const fieldsResponse = await tabMessage(tabId, { type: "GET_FORM_FIELDS", includeSensitive: false });
  if (!fieldsResponse?.ok) {
    throw new Error(fieldsResponse?.error || "Unable to read form fields from page.");
  }

  const fields = Array.isArray(fieldsResponse.fields) ? fieldsResponse.fields : [];
  if (!fields.length) {
    await safeRuntimeMessage({
      type: "AUTOFILL_STATUS",
      message: t("statusNoEditableFields", undefined, "No supported editable fields found on this page."),
      error: false
    });
    return;
  }

  await safeRuntimeMessage({
    type: "AUTOFILL_STATUS",
    message: t("statusFoundFieldsFilling", [String(fields.length)], `Found ${fields.length} field(s). Filling now...`),
    error: false
  });

  const byFingerprint = new Map();
  fields.forEach((field) => {
    const key = fieldFingerprint(field);
    if (!byFingerprint.has(key)) {
      byFingerprint.set(key, field);
    }
  });

  const uniqueFields = Array.from(byFingerprint.values());
  const batches = chunkArray(uniqueFields, AUTOFILL_BATCH_SIZE);
  const answerByFingerprint = new Map();
  const errorByFingerprint = new Map();

  await runWithConcurrency(batches, AUTOFILL_MAX_CONCURRENCY, async (batch) => {
    try {
      const answersByUid = await withRetry(
        () => queryFieldBatchAnswers({ apiKey, vectorStoreId, model, fields: batch }),
        AUTOFILL_RETRIES
      );

      batch.forEach((field) => {
        const key = fieldFingerprint(field);
        answerByFingerprint.set(key, answersByUid[field.uid] || "");
      });
    } catch (error) {
      batch.forEach((field) => {
        const key = fieldFingerprint(field);
        errorByFingerprint.set(key, error.message || t("requestFailed", undefined, "request failed"));
      });
    }
  });

  let filled = 0;
  let skipped = 0;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const label = fieldDisplayName(field);
    const key = fieldFingerprint(field);

    if (errorByFingerprint.has(key)) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: t(
          "progressError",
          [String(i + 1), String(fields.length), label, errorByFingerprint.get(key)],
          `[${i + 1}/${fields.length}] Error: ${label} -> ${errorByFingerprint.get(key)}`
        )
      });
      skipped += 1;
      continue;
    }

    const answer = answerByFingerprint.get(key) || "";
    if (!answer) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: t("progressNotFound", [String(i + 1), String(fields.length), label], `[${i + 1}/${fields.length}] Not found: ${label}`)
      });
      skipped += 1;
      continue;
    }

    const fillResponse = await tabMessage(tabId, { type: "FILL_FORM_FIELD", uid: field.uid, value: answer, allowSensitive: false });
    if (!fillResponse?.ok) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: t(
          "progressCouldNotFill",
          [String(i + 1), String(fields.length), label, fillResponse?.error || t("unknownError", undefined, "unknown error")],
          `[${i + 1}/${fields.length}] Could not fill: ${label} (${fillResponse?.error || "unknown error"})`
        )
      });
      skipped += 1;
      continue;
    }

    filled += 1;
    await safeRuntimeMessage({
      type: "AUTOFILL_PROGRESS",
      message: t("progressFilled", [String(i + 1), String(fields.length), label], `[${i + 1}/${fields.length}] Filled: ${label}`)
    });
  }

  await safeRuntimeMessage({
    type: "AUTOFILL_STATUS",
    message: t("statusCompletedFilledSkipped", [String(filled), String(skipped)], `Completed. Filled ${filled}, skipped ${skipped}.`),
    error: false
  });
}

async function processSingleField(field, allowSensitive) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();
  const model = settings.model?.trim() || "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!vectorStoreId) {
    throw new Error(t("errVectorStoreMissingPopup", undefined, "Vector Store ID is missing. Add it in the extension popup."));
  }
  if (!field || typeof field !== "object") {
    throw new Error(t("errInvalidFieldPayload", undefined, "Invalid field payload."));
  }

  const sensitivity = isSensitiveFieldDescriptor(field);
  if (sensitivity.sensitive && !allowSensitive) {
    throw new Error(t("errSensitiveFieldRequiresConfirmation", undefined, "Sensitive field requires explicit confirmation."));
  }

  const answerByUid = await withRetry(
    () => queryFieldBatchAnswers({ apiKey, vectorStoreId, model, fields: [field] }),
    AUTOFILL_RETRIES
  );
  const answer = answerByUid[field.uid] || "";
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
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!vectorStoreId) {
    throw new Error(t("errVectorStoreMissingPopup", undefined, "Vector Store ID is missing. Add it in the extension popup."));
  }

  const files = await listVectorStoreFiles({ apiKey, vectorStoreId });
  return { ok: true, files };
}

async function processVectorFileAdd(file) {
  const settings = await getSettings();
  const apiKey = settings.apiKey?.trim();
  const vectorStoreId = settings.vectorStoreId?.trim();

  if (!apiKey) {
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!vectorStoreId) {
    throw new Error(t("errVectorStoreMissingPopup", undefined, "Vector Store ID is missing. Add it in the extension popup."));
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
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!vectorStoreId) {
    throw new Error(t("errVectorStoreMissingPopup", undefined, "Vector Store ID is missing. Add it in the extension popup."));
  }
  if (!fileId) {
    throw new Error(t("errMissingFileId", undefined, "Missing file id."));
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

async function processVectorStoresList(apiKeyOverride) {
  const settings = await getSettings();
  const apiKey = String(apiKeyOverride || "").trim() || settings.apiKey?.trim();

  if (!apiKey) {
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
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
    throw new Error(t("errNameRequired", undefined, "Name is required."));
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
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!selectedVectorStoreId) {
    throw new Error(t("errNoFileDatabaseSelected", undefined, "No file database selected."));
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
    throw new Error(t("errApiKeyMissingPopup", undefined, "OpenAI API key is missing. Add it in the extension popup."));
  }
  if (!selectedVectorStoreId) {
    throw new Error(t("errNoFileDatabaseSelected", undefined, "No file database selected."));
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

async function processValidateApiKey(apiKeyOverride) {
  let apiKey = String(apiKeyOverride || "").trim();
  if (!apiKey) {
    const settings = await getSettings();
    apiKey = settings.apiKey?.trim() || "";
  }

  if (!apiKey) {
    throw new Error(t("errApiKeyMissing", undefined, "OpenAI API key is missing."));
  }

  const response = await fetch("https://api.openai.com/v1/vector_stores?limit=1", {
    method: "GET",
    headers: buildOpenAIHeaders(apiKey, false, true)
  });

  if (response.ok) {
    return { ok: true };
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(t("errInvalidApiKey", undefined, "Invalid OpenAI API key."));
  }

  const details = await parseErrorDetails(response);
  throw new Error(`${classifyHttpError(response.status)}${details ? ` ${details}` : ""}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const sender = _sender;

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "START_AUTOFILL") {
    const tabId = message.tabId;

    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: t("errInvalidTabId", undefined, "Invalid tab identifier.") });
      return;
    }

    processAutofill(tabId)
      .then(() => {})
      .catch(async (error) => {
        await safeRuntimeMessage({
          type: "AUTOFILL_STATUS",
          message: error.message || t("errAutofillFailed", undefined, "Autofill failed."),
          error: true
        });
      });

    sendResponse({ ok: true });
    return;
  }

  if (message.type === "FILL_SINGLE_FIELD") {
    processSingleField(message.field, Boolean(message.allowSensitive))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotFillField", undefined, "Could not fill field.") }));
    return true;
  }

  if (message.type === "VECTOR_FILES_LIST") {
    processVectorFilesList()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotListFiles", undefined, "Could not list files.") }));
    return true;
  }

  if (message.type === "VECTOR_FILES_ADD") {
    processVectorFileAdd(message.file)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotAddFile", undefined, "Could not add file.") }));
    return true;
  }

  if (message.type === "VECTOR_FILES_DELETE") {
    processVectorFileDelete(message.fileId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotDeleteFile", undefined, "Could not delete file.") }));
    return true;
  }

  if (message.type === "VECTOR_FILES_UPDATE") {
    processVectorFileUpdate(message.fileId, message.file)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotUpdateFile", undefined, "Could not update file.") }));
    return true;
  }

  if (message.type === "VECTOR_STORES_LIST") {
    processVectorStoresList(message.apiKey)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotListVectorStores", undefined, "Could not list vector stores.") }));
    return true;
  }

  if (message.type === "VECTOR_STORES_CREATE") {
    processVectorStoreCreate(message.name)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotCreateVectorStore", undefined, "Could not create vector store.") }));
    return true;
  }

  if (message.type === "VECTOR_STORE_DELETE_PREVIEW") {
    processVectorStoreDeletePreview(message.vectorStoreId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotPrepareDeletionPreview", undefined, "Could not prepare deletion preview.") }));
    return true;
  }

  if (message.type === "VECTOR_STORE_DELETE") {
    processVectorStoreDelete(message.vectorStoreId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errCouldNotDeleteFileDatabase", undefined, "Could not delete file database.") }));
    return true;
  }

  if (message.type === "VALIDATE_API_KEY") {
    processValidateApiKey(message.apiKey)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || t("errInvalidApiKey", undefined, "Invalid OpenAI API key.") }));
    return true;
  }

  if (message.type === "GET_TAB_FORM_AVAILABILITY") {
    const tabId = Number(message.tabId);
    updateActionStateForTab(tabId)
      .then((hasForm) => sendResponse({ ok: true, hasForm }))
      .catch(() => sendResponse({ ok: true, hasForm: false }));
    return true;
  }

  if (message.type === "FORM_AVAILABILITY_CHANGED") {
    const tabId = sender?.tab?.id;
    const hasForm = Boolean(message.hasForm);
    updateActionStateForTabKnownValue(tabId, hasForm).catch(() => {
      // ignore
    });
    sendResponse({ ok: true });
    return;
  }
});

function initializeActionIcons() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      return;
    }
    const activeTab = tabs && tabs[0];
    if (activeTab && Number.isInteger(activeTab.id)) {
      updateActionStateForTab(activeTab.id).catch(() => {
        // ignore
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  i18n.initializeLanguageOverride().catch(() => {
    // ignore
  });
  initializeActionIcons();
});

chrome.runtime.onStartup.addListener(() => {
  i18n.initializeLanguageOverride().catch(() => {
    // ignore
  });
  initializeActionIcons();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes || !changes[SETTINGS_KEY]) {
    return;
  }
  i18n.initializeLanguageOverride().catch(() => {
    // ignore
  });
});

i18n.initializeLanguageOverride().catch(() => {
  // ignore
});

