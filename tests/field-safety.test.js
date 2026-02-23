const test = require("node:test");
const assert = require("node:assert/strict");
const { isSensitiveFieldDescriptor } = require("../lib/field-safety.js");

test("marks password fields as sensitive", () => {
  const result = isSensitiveFieldDescriptor({ tag: "input", type: "password" });
  assert.equal(result.sensitive, true);
});

test("marks payment autocomplete fields as sensitive", () => {
  const result = isSensitiveFieldDescriptor({ tag: "input", type: "text", autocomplete: "cc-number" });
  assert.equal(result.sensitive, true);
});

test("does not mark generic profile fields as sensitive", () => {
  const result = isSensitiveFieldDescriptor({
    tag: "input",
    type: "text",
    label: "First name",
    name: "firstName"
  });
  assert.equal(result.sensitive, false);
});
