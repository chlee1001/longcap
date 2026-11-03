import test from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS } from "../src/shortcuts.js";

test("shortcut keys are unique within each scope", () => {
  const keys = SHORTCUTS.map(({ scope, keys }) => `${scope}:${keys}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("editor tool shortcuts use distinct letters", () => {
  const labels = [
    "선택",
    "자르기",
    "사각형",
    "타원",
    "화살표",
    "직선",
    "텍스트",
    "강조",
    "가리기",
    "번호",
    "펜",
    "마커",
  ];
  const tools = SHORTCUTS.filter(
    (entry) => entry.scope === "edit" && labels.includes(entry.label),
  );
  assert.equal(tools.length, labels.length);
  assert.ok(tools.every((entry) => /^[A-Z]$/.test(entry.keys)));
  assert.equal(new Set(tools.map((entry) => entry.keys)).size, tools.length);
});
