export interface ShortcutEntry {
  keys: string;
  label: string;
  scope: "global" | "library" | "result" | "edit";
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { scope: "global", keys: "?", label: "단축키 도움말" },
  { scope: "global", keys: "/", label: "검색" },
  { scope: "global", keys: "G H", label: "보관함으로 이동" },
  { scope: "global", keys: "G B", label: "일괄 캡처로 이동" },
  { scope: "global", keys: "G S", label: "설정으로 이동" },
  { scope: "library", keys: "Delete", label: "선택 항목 삭제" },
  { scope: "library", keys: "Ctrl/Cmd+A", label: "전체 선택 전환" },
  { scope: "result", keys: "Escape", label: "보관함으로 돌아가기" },
  { scope: "result", keys: "E", label: "편집 전환" },
  { scope: "result", keys: "+/=", label: "확대" },
  { scope: "result", keys: "-", label: "축소" },
  { scope: "result", keys: "0", label: "화면에 맞춤" },
  { scope: "result", keys: "1", label: "100%" },
  { scope: "result", keys: "Ctrl/Cmd+S", label: "내보내기" },
  { scope: "result", keys: "Ctrl/Cmd+C", label: "이미지 복사" },
  { scope: "result", keys: "Ctrl/Cmd+P", label: "인쇄" },
  { scope: "edit", keys: "Escape", label: "선택 해제 또는 편집 종료" },
  { scope: "edit", keys: "V", label: "선택" },
  { scope: "edit", keys: "C", label: "자르기" },
  { scope: "edit", keys: "R", label: "사각형" },
  { scope: "edit", keys: "O", label: "타원" },
  { scope: "edit", keys: "A", label: "화살표" },
  { scope: "edit", keys: "L", label: "직선" },
  { scope: "edit", keys: "T", label: "텍스트" },
  { scope: "edit", keys: "H", label: "강조" },
  { scope: "edit", keys: "X", label: "가리기" },
  { scope: "edit", keys: "B", label: "번호" },
  { scope: "edit", keys: "P", label: "펜" },
  { scope: "edit", keys: "M", label: "마커" },
  { scope: "edit", keys: "Ctrl/Cmd+Z", label: "실행 취소" },
  { scope: "edit", keys: "Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y", label: "다시 실행" },
  { scope: "edit", keys: "Ctrl/Cmd+C", label: "선택한 객체 복사" },
  { scope: "edit", keys: "Ctrl/Cmd+Shift+C", label: "이미지 복사" },
  { scope: "edit", keys: "Ctrl/Cmd+V", label: "객체 붙여넣기" },
  { scope: "edit", keys: "Ctrl/Cmd+D", label: "복제" },
  { scope: "edit", keys: "Delete / Backspace", label: "객체 삭제" },
  { scope: "edit", keys: "[", label: "뒤로 보내기" },
  { scope: "edit", keys: "]", label: "앞으로 가져오기" },
  {
    scope: "edit",
    keys: "방향키 / Shift+방향키",
    label: "객체 이동 / 크게 이동",
  },
];

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

export function showShortcutHelp(): void {
  const existing =
    document.querySelector<HTMLDialogElement>(".shortcut-dialog");
  if (existing?.open) {
    existing.close();
    return;
  }
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const dialog = document.createElement("dialog");
  dialog.className = "shortcut-dialog";
  dialog.setAttribute("aria-label", "단축키 도움말");
  const title = document.createElement("h2");
  title.textContent = "단축키";
  dialog.append(title);
  for (const [scope, heading] of [
    ["global", "전체"],
    ["library", "보관함"],
    ["result", "결과"],
    ["edit", "편집"],
  ] as const) {
    const h = document.createElement("h3");
    h.textContent = heading;
    const list = document.createElement("dl");
    for (const entry of SHORTCUTS.filter((item) => item.scope === scope)) {
      const term = document.createElement("dt");
      const key = document.createElement("kbd");
      key.textContent = entry.keys;
      term.append(key);
      const description = document.createElement("dd");
      description.textContent = entry.label;
      list.append(term, description);
    }
    dialog.append(h, list);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "닫기";
  close.addEventListener("click", () => dialog.close());
  dialog.append(close);
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      opener?.focus();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  dialog.scrollTop = 0;
}
