# AIFormFiller Chrome Extension

AIFormFiller fills web forms from your OpenAI vector store documents.

## Key improvements in this version

- Reduced extension privilege scope:
  - Removed always-on `content_scripts`.
  - Removed broad `<all_urls>` host permission.
  - Uses on-demand script injection with `activeTab` + `scripting`.
- Sensitive-field safeguards:
  - Password/payment/OTP/SSN-like fields are excluded from bulk autofill.
  - Inline fill requires explicit confirmation for sensitive fields.
- Autofill throughput and cost controls:
  - Deduplicates equivalent fields.
  - Batches retrieval requests.
  - Uses bounded concurrency and retry/backoff on transient failures.
- Shared utilities:
  - Common storage, i18n, messaging, and base64 helpers moved to `shared-utils.js`.
- API key storage options:
  - Persistent mode: encrypted payload in extension local storage.
  - Session mode: key stored in extension session storage and cleared with session.

## Security note

API keys are protected against casual local exposure, but browser extension storage is not a hardware-secure secret vault.

## Development

Install Node.js 20+.

```bash
npm install
npm run lint
npm test
```

## Test scope

Current automated tests validate sensitive-field classification logic (`tests/field-safety.test.js`).
