const SETTINGS_KEY = "aiFormFillerSettings";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

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

async function getSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  return data[SETTINGS_KEY] || {};
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
      let details = "";
      try {
        const err = await response.json();
        details = err?.error?.message ? ` ${err.error.message}` : "";
      } catch (_ignored) {
        // No-op.
      }
      throw new Error(`${classifyHttpError(response.status)}${details}`);
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
    await safeRuntimeMessage({
      type: "AUTOFILL_STATUS",
      message: "No supported editable fields found on this page.",
      error: false
    });
    return;
  }

  await safeRuntimeMessage({
    type: "AUTOFILL_STATUS",
    message: `Found ${fields.length} field(s). Filling now...`,
    error: false
  });

  let filled = 0;
  let skipped = 0;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const label = fieldDisplayName(field);

    await safeRuntimeMessage({
      type: "AUTOFILL_PROGRESS",
      message: `[${i + 1}/${fields.length}] Searching: ${label}`
    });

    let answer;
    try {
      answer = await queryFieldAnswer({ apiKey, vectorStoreId, model, field });
    } catch (error) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: `[${i + 1}/${fields.length}] Error: ${label} -> ${error.message || "request failed"}`
      });
      skipped += 1;
      continue;
    }

    if (!answer) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: `[${i + 1}/${fields.length}] Not found: ${label}`
      });
      skipped += 1;
      continue;
    }

    const fillResponse = await tabMessage(tabId, {
      type: "FILL_FORM_FIELD",
      uid: field.uid,
      value: answer
    });

    if (!fillResponse?.ok) {
      await safeRuntimeMessage({
        type: "AUTOFILL_PROGRESS",
        message: `[${i + 1}/${fields.length}] Could not fill: ${label} (${fillResponse?.error || "unknown error"})`
      });
      skipped += 1;
      continue;
    }

    filled += 1;
    await safeRuntimeMessage({
      type: "AUTOFILL_PROGRESS",
      message: `[${i + 1}/${fields.length}] Filled: ${label}`
    });
  }

  await safeRuntimeMessage({
    type: "AUTOFILL_STATUS",
    message: `Completed. Filled ${filled}, skipped ${skipped}.`,
    error: false
  });
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
      .then(() => {
        // Completed.
      })
      .catch(async (error) => {
        await safeRuntimeMessage({
          type: "AUTOFILL_STATUS",
          message: error.message || "Autofill failed.",
          error: true
        });
      });

    sendResponse({ ok: true });
    return;
  }

  if (message.type === "FILL_SINGLE_FIELD") {
    processSingleField(message.field)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Could not fill field."
        });
      });

    return true;
  }
});
