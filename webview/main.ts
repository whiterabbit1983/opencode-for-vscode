import { diffLines, type DiffRow } from "./diff.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { modelLabel, modelName } from "../src/shared/model-name.js";
import { compactNumber, contextRatio, formatPercent, meterLevel } from "../src/shared/usage.js";
import type {
  Block,
  ChatItem,
  ChatState,
  ConfigOptionView,
  FormField,
  HostMessage,
  PermissionOption,
  PermissionRequest,
  Question,
  SessionSummary,
  ToolCall,
  ToolCallContent,
  WebviewMessage,
} from "../src/shared/protocol.js";

/* ------------------------------------------------------------------ */
/* VS Code bridge                                                      */
/* ------------------------------------------------------------------ */

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function warn(level: "info" | "warn" | "error", message: string): void {
  post({ type: "log", level, message });
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface UiState {
  chat: ChatState;
  /** Tool call ids the user expanded. */
  openTools: Set<string>;
  /** Plan visibility. */
  planOpen: boolean;
  /** Thought blocks the user expanded. */
  openThoughts: Set<string>;
  /** Which composer menu is open. */
  menu: "none" | "model" | "mode" | "more";
  /** What the user has typed into the model picker's filter. */
  modelFilter: string;
  /** Which choice in the model picker is highlighted, by model id. */
  modelIndex: string | undefined;
  /**
   * The click that opened the current menu.
   *
   * The outside-click listener sits on `document`, so it sees the very same
   * event that `onClick` used to open the menu and would close it again
   * before it is ever painted. Remembering the event lets that listener skip
   * it.
   */
  menuOpenedBy?: Event;
  /** Draft text, preserved across re-renders. */
  draft: string;
  /** Answers collected for an open question. */
  questionDrafts: Record<string, Record<string, unknown>>;
  /** The `@` file picker sitting above the composer. */
  picker: PickerState;
}

/**
 * The `@` file picker.
 *
 * `from` is where the `@` token starts in the draft, so accepting a file
 * replaces the token the user typed rather than appending to the end.
 */
interface PickerState {
  open: boolean;
  query: string;
  from: number;
  files: string[];
  index: number;
  /** Echoed back by the host so replies to abandoned queries can be dropped. */
  requestId: number;
  /** Waiting on the first reply for this query. */
  waiting: boolean;
}

const state: UiState = {
  chat: emptyState(),
  openTools: new Set(),
  planOpen: true,
  openThoughts: new Set(),
  menu: "none",
  modelFilter: "",
  modelIndex: undefined,
  draft: "",
  questionDrafts: {},
  picker: { open: false, query: "", from: 0, files: [], index: 0, requestId: 0, waiting: false },
};

function emptyState(): ChatState {
  return {
    connection: "stopped",
    busy: false,
    items: [],
    fonts: { size: 0 },
    options: {
      showThoughts: false,
      showPlan: true,
      diffView: "inline",
      permissions: "ask",
      maxToolOutputLines: 40,
      confirmDestructiveCommands: true,
    },
  };
}

/** Where a grown composer stops growing and starts scrolling. */
const COMPOSER_MAX_HEIGHT = 240;

const root = document.getElementById("root") as HTMLDivElement;
const dom: Record<string, HTMLElement> = {};
const rendered = new Map<string, { signature: string; element: HTMLElement }>();

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

buildShell();
post({ type: "ready" });

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  handleHostMessage(event.data);
});

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case "state": {
      const previousSession = state.chat.session?.sessionId;
      state.chat = message.state;
      applyFontSize();
      renderAll();
      // Switching chats replaces the whole transcript; start at the newest
      // message rather than wherever the old one was scrolled to.
      if (previousSession !== state.chat.session?.sessionId) {
        scrollToEnd(false);
      }
      return;
    }
    case "patch": {
      state.chat.items = message.items;
      state.chat.plan = message.plan;
      state.chat.usage = message.usage;
      state.chat.retry = message.retry;
      renderPlan();
      renderTranscript();
      renderStatusBar();
      return;
    }
    case "insertDraft":
      insertDraft(message.text);
      return;
    case "submitDraft":
      submit(message.text);
      return;
    case "focusInput":
      focusInput();
      return;
    case "toast":
      showToast(message.level, message.message);
      return;
    case "scrollToEnd":
      scrollToEnd(true);
      return;
    case "fileResults": {
      const picker = state.picker;
      // A reply for a query the user has already moved on from is noise.
      if (!picker.open || picker.requestId !== message.requestId) {
        return;
      }
      state.picker = { ...picker, files: message.files, index: 0, waiting: false };
      renderPicker();
      return;
    }
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function buildShell(): void {
  root.innerHTML = `
    <div class="header">
      <div class="header-title">
        <span class="dot" data-state="stopped"></span>
        <span class="label">OpenCode</span>
        <span class="header-sub"></span>
      </div>
      <span class="header-spacer"></span>
      <button class="icon-button" data-action="new-chat" title="New chat">
        <span class="codicon codicon-add"></span>
      </button>
      <button class="icon-button" data-action="history" title="Resume a previous chat">
        <span class="codicon codicon-history"></span>
      </button>
      <button class="icon-button" data-action="more" title="More" aria-haspopup="true">
        <span class="codicon codicon-ellipsis"></span>
      </button>
    </div>
    <div class="banner" hidden>
      <span class="codicon codicon-error"></span>
      <div class="banner-text">
        <div class="banner-message"></div>
        <div class="banner-actions">
          <button class="link" data-action="retry-agent">Restart agent</button>
          <button class="link" data-action="sign-in">Sign in</button>
          <button class="link" data-action="show-log">Show log</button>
        </div>
      </div>
    </div>
    <div class="plan" hidden></div>
    <div class="transcript" tabindex="0"></div>
    <div class="statusbar"></div>
    <div class="composer">
      <div class="picker" hidden></div>
      <div class="queue" hidden></div>
      <div class="composer-inner">
        <textarea rows="3" placeholder="Describe what to build…" spellcheck="true" title="Enter to send · Shift+Enter for a new line"></textarea>
        <div class="composer-toolbar">
          <button class="chip" data-menu="mode" title="Choose how OpenCode works">
            <span class="codicon codicon-robot"></span><span class="chip-label">Chat</span>
            <span class="codicon codicon-chevron-down"></span>
          </button>
          <button class="chip" data-menu="model" title="Choose the model">
            <span class="codicon codicon-sparkle"></span><span class="chip-label">Model</span>
            <span class="codicon codicon-chevron-down"></span>
          </button>
          <button class="chip" data-action="attach" title="Attach the active file">
            <span class="codicon codicon-attach"></span>
          </button>
          <button class="send-button" data-action="send" title="Send">
            <span class="codicon codicon-send"></span>
          </button>
        </div>
      </div>
    </div>
    <div class="menu" hidden role="menu"></div>
  `;

  for (const [key, selector] of Object.entries({
    dot: ".header-title .dot",
    sub: ".header-sub",
    banner: ".banner",
    bannerMessage: ".banner-message",
    plan: ".plan",
    transcript: ".transcript",
    statusbar: ".statusbar",
    composer: ".composer",
    textarea: ".composer textarea",
    picker: ".picker",
    queue: ".queue",
    menu: ".menu",
    modeChip: '[data-menu="mode"]',
    modelChip: '[data-menu="model"]',
    modeLabel: '[data-menu="mode"] .chip-label',
    modelLabel: '[data-menu="model"] .chip-label',
    send: ".send-button",
  })) {
    const element = root.querySelector(selector) as HTMLElement | null;
    if (element) {
      dom[key] = element;
    }
  }

  wireEvents();
  applyFontSize();
}

function wireEvents(): void {
  const textarea = dom.textarea as HTMLTextAreaElement;

  textarea.addEventListener("input", () => {
    state.draft = textarea.value;
    autosize(textarea);
    syncPicker(textarea);
  });

  textarea.addEventListener("keydown", (event) => {
    if (state.picker.open && onPickerKey(event)) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(textarea.value);
    }
  });

  textarea.addEventListener("blur", () => {
    // A click on a row must still land, so the check is not "the textarea lost
    // focus" but "focus moved outside the picker entirely".
    window.setTimeout(() => {
      if (!document.activeElement?.closest(".picker")) {
        closePicker();
      }
    }, 0);
  });

  root.addEventListener("click", (event) => onClick(event));
  root.addEventListener("submit", (event) => event.preventDefault());
  root.addEventListener("keydown", (event) => onPromptKey(event));

  // The picker is re-rendered wholesale on every keystroke, so its input is
  // wired once on the menu itself rather than on a node that keeps being
  // replaced. Focus has to be restored after each render or typing would stop
  // at the first character.
  const menu = dom.menu;
  menu.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.classList.contains("menu-filter")) {
      return;
    }
    state.modelFilter = event.target.value;
    renderMenu();
  });
  menu.addEventListener("keydown", (event) => {
    if (state.menu !== "model" || !(event.target instanceof HTMLInputElement)) {
      return;
    }
    onModelFilterKey(event);
  });

  document.addEventListener("click", (event) => {
    if (state.menu === "none") {
      return;
    }
    // The same click that opened the menu bubbles on to `document`; closing on
    // it would make every dropdown flash and vanish.
    if (event === state.menuOpenedBy) {
      state.menuOpenedBy = undefined;
      return;
    }
    const menu = dom.menu;
    if (menu && !menu.contains(event.target as Node)) {
      closeMenu();
    }
  });

  window.addEventListener("resize", () => {
    if (state.menu !== "none") {
      positionMenu();
    }
  });
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;

  const actionEl = target.closest<HTMLElement>("[data-action]");
  const action = actionEl?.dataset.action;

  if (action) {
    switch (action) {
      case "send":
      case "stop":
        if (state.chat.busy) {
          const queued = (dom.textarea as HTMLTextAreaElement).value.trim();
          if (queued) {
            submit(queued);
          } else {
            post({ type: "cancel" });
          }
        } else {
          submit((dom.textarea as HTMLTextAreaElement).value);
        }
        return;
      case "new-chat":
        post({ type: "newSession" });
        focusInput();
        return;
      case "history":
        post({ type: "runCommand", command: "opencode.chat.pickSession" });
        return;
      case "attach":
        post({ type: "runCommand", command: "opencode.chat.askAboutFile" });
        return;
      case "more":
        toggleMenu("more", event);
        return;
      case "retry-agent":
        post({ type: "retryAgent" });
        return;
      case "sign-in":
        post({ type: "signIn" });
        return;
      case "show-log":
        post({ type: "showLog" });
        return;
      case "copy-code": {
        const block = target.closest(".code-block")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard.writeText(block);
        post({ type: "copyText", text: block });
        flashLabel(target.closest<HTMLElement>(".code-copy")!, "Copied");
        return;
      }
      case "toggle-tool": {
        const id = actionEl.dataset.id ?? "";
        toggleSet(state.openTools, id);
        rerenderItem(actionEl.closest<HTMLElement>(".item")!);
        return;
      }
      case "toggle-thought": {
        const id = actionEl.dataset.id ?? "";
        toggleSet(state.openThoughts, id);
        rerenderItem(actionEl.closest<HTMLElement>(".item")!);
        return;
      }
      case "toggle-plan":
        state.planOpen = !state.planOpen;
        renderPlan();
        return;
      case "open-diff":
        post({
          type: "openDiff",
          path: actionEl.dataset.path ?? "",
          oldText: actionEl.dataset.old ?? "",
          newText: actionEl.dataset.new ?? "",
        });
        return;
      case "open-file":
        post({ type: "openFile", path: actionEl.dataset.path ?? "", line: Number(actionEl.dataset.line ?? "0") || undefined });
        return;
      case "reply-diff":
        post({
          type: "openDiff",
          path: actionEl.dataset.path ?? "",
          oldText: "",
          newText: actionEl.dataset.new ?? "",
        });
        return;
      case "permission": {
        const optionId = actionEl.dataset.option ?? "";
        post({ type: "respondPermission", requestId: actionEl.dataset.id ?? "", optionId, outcome: "selected" });
        return;
      }
      case "permission-cancel":
        post({ type: "respondPermission", requestId: actionEl.dataset.id ?? "", outcome: "cancelled" });
        return;
      case "question-accept":
      case "question-decline":
      case "question-cancel": {
        const requestId = actionEl.dataset.id ?? "";
        const answers = state.questionDrafts[requestId] ?? {};
        post({
          type: "respondQuestion",
          requestId,
          action: action === "question-accept" ? "accept" : action === "question-decline" ? "decline" : "cancel",
          values: action === "question-accept" ? answers : undefined,
        });
        return;
      }
      case "menu-pick":
        applyMenuPick(actionEl.dataset.kind ?? "", actionEl.dataset.value ?? "");
        return;
      case "menu-cmd":
        closeMenu();
        if (actionEl.dataset.value === "log") {
          post({ type: "showLog" });
        } else {
          post({ type: "runCommand", command: menuCommand(actionEl.dataset.value ?? "") });
        }
        return;
      default:
        return;
    }
  }

  const menuTrigger = target.closest<HTMLElement>("[data-menu]");
  if (menuTrigger) {
    const kind = menuTrigger.dataset.menu as "model" | "mode";
    toggleMenu(kind, event);
    return;
  }

  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    post({ type: "openLink", href: link.href });
    return;
  }

  const fileLink = target.closest<HTMLElement>("[data-file]");
  if (fileLink) {
    post({ type: "openFile", path: fileLink.dataset.file ?? "" });
    return;
  }

  const pick = target.closest<HTMLElement>("[data-pick]");
  if (pick) {
    event.preventDefault();
    acceptPicker(pick.dataset.pick ?? "");
    return;
  }

  const expandOutput = target.closest<HTMLElement>(".tool-more");
  if (expandOutput) {
    const pre = expandOutput.previousElementSibling as HTMLElement | null;
    if (pre) {
      pre.classList.toggle("is-clipped");
      pre.style.maxHeight = pre.classList.contains("is-clipped") ? "none" : "";
    }
    expandOutput.textContent = pre?.classList.contains("is-clipped") ? "Show less" : "Show more";
    return;
  }

  const choice = target.closest<HTMLElement>("[data-choice]");
  if (choice) {
    onFieldChoice(choice);
    return;
  }

  if (state.menu !== "none" && !target.closest(".menu")) {
    closeMenu();
  }
}

/* ------------------------------------------------------------------ */
/* Composer actions                                                    */
/* ------------------------------------------------------------------ */

function submit(text: string): void {
  const value = text.trim();
  if (!value) {
    return;
  }
  if (state.chat.busy) {
    if (state.chat.connection === "error") {
      flashStatus("OpenCode isn't connected. Restart the agent from the toolbar.");
      return;
    }
    state.draft = "";
    const toolbarTextarea = dom.textarea as HTMLTextAreaElement;
    toolbarTextarea.value = "";
    closePicker();
    autosize(toolbarTextarea);
    post({ type: "send", text: value });
    scrollToEnd(true);
    // The queue in state is still the pre-send one: the extension has not answered
// yet, so the row this send just added is counted here rather than read back.
flashStatus(`Queued (${(state.chat.queue?.length ?? 0) + 1}) — runs when OpenCode finishes.`);
    return;
  }
  if (state.chat.connection === "error") {
    flashStatus("OpenCode isn't connected. Restart the agent from the toolbar.");
    return;
  }
  state.draft = "";
  const textarea = dom.textarea as HTMLTextAreaElement;
  textarea.value = "";
  closePicker();
  autosize(textarea);
  post({ type: "send", text: value });
  scrollToEnd(true);
}

function insertDraft(text: string): void {
  const textarea = dom.textarea as HTMLTextAreaElement;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  state.draft = textarea.value;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  autosize(textarea);
  focusInput();
  // A pasted or injected `@token` is a mention too, so the picker has to open.
  syncPicker(textarea);
}

function focusInput(): void {
  const textarea = dom.textarea as HTMLTextAreaElement;
  textarea?.focus();
}

/* ------------------------------------------------------------------ */
/* File picker                                                         */
/* ------------------------------------------------------------------ */

/**
 * An `@` at the start of the draft or after a space.
 *
 * Requiring that boundary is what keeps `someone@example.com` from opening a
 * file picker mid-word: the `@` has to be something you typed on purpose.
 */
const MENTION = /(^|\s)(@[^\s@]*)$/;

function syncPicker(textarea: HTMLTextAreaElement): void {
  const caret = textarea.selectionStart ?? textarea.value.length;
  const match = MENTION.exec(textarea.value.slice(0, caret));
  if (!match) {
    closePicker();
    return;
  }

  const query = match[2].slice(1);
  const from = (match.index ?? 0) + match[1].length;
  const picker = state.picker;
  if (picker.open && picker.from === from && picker.query === query) {
    return;
  }

  state.picker = {
    open: true,
    query,
    from,
    files: [],
    index: 0,
    requestId: picker.requestId + 1,
    waiting: true,
  };
  post({ type: "searchFiles", query, requestId: state.picker.requestId });
  renderPicker();
}

function closePicker(): void {
  if (!state.picker.open) {
    return;
  }
  state.picker = { ...state.picker, open: false, files: [], index: 0, waiting: false };
  renderPicker();
}

function movePicker(step: number): void {
  const { files, index } = state.picker;
  if (!files.length) {
    return;
  }
  // Wraps, so holding the arrow key walks the list instead of stopping dead.
  const next = (index + step + files.length) % files.length;
  state.picker = { ...state.picker, index: next };
  renderPicker();
  dom.picker?.querySelector(".picker-row.active")?.scrollIntoView({ block: "nearest" });
}

/** Puts the chosen file where the `@` was and resumes writing. */
function acceptPicker(path: string): void {
  if (!path) {
    closePicker();
    return;
  }
  const textarea = dom.textarea as HTMLTextAreaElement;
  const caret = textarea.selectionStart ?? state.picker.from;
  const insertion = `@${path} `;

  textarea.value = textarea.value.slice(0, state.picker.from) + insertion + textarea.value.slice(caret);
  state.draft = textarea.value;

  const position = state.picker.from + insertion.length;
  textarea.selectionStart = textarea.selectionEnd = position;
  closePicker();
  autosize(textarea);
  textarea.focus();
}

/**
 * Handles a key while the picker is open.
 *
 * Returns whether it consumed the key, so Enter on an empty result falls
 * through and sends the message as usual.
 */
function onPickerKey(event: KeyboardEvent): boolean {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      movePicker(1);
      return true;
    case "ArrowUp":
      event.preventDefault();
      movePicker(-1);
      return true;
    case "Enter":
    case "Tab": {
      const path = state.picker.files[state.picker.index];
      if (!path) {
        closePicker();
        return event.key === "Tab";
      }
      event.preventDefault();
      acceptPicker(path);
      return true;
    }
    case "Escape":
      event.preventDefault();
      closePicker();
      return true;
    default:
      return false;
  }
}

function renderPicker(): void {
  const picker = dom.picker;
  if (!picker) {
    return;
  }
  if (!state.picker.open) {
    picker.hidden = true;
    picker.innerHTML = "";
    return;
  }

  const { files, index, waiting, query } = state.picker;
  const rows = files
    .map((path, i) => {
      const slash = path.lastIndexOf("/");
      const dir = slash === -1 ? "" : path.slice(0, slash + 1);
      const name = slash === -1 ? path : path.slice(slash + 1);
      return `<button class="picker-row${i === index ? " active" : ""}" role="option" aria-selected="${i === index}" data-pick="${escapeHtml(path)}">
        <span class="codicon codicon-file"></span>
        <span class="picker-path">${escapeHtml(dir)}<span class="picker-name">${escapeHtml(name)}</span></span>
      </button>`;
    })
    .join("");

  picker.innerHTML = waiting
    ? `<div class="picker-empty">Searching…</div>`
    : rows || `<div class="picker-empty">No file matches “${escapeHtml(query)}”</div>`;
  picker.hidden = false;
}

/**
 * Grows the composer to fit what was typed, then scrolls.
 *
 * `height: auto` first: the box only shrinks back down if the height it is
 * measuring is not the one it is using.
 */
function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}

function applyFontSize(): void {
  const size = state.chat.fonts?.size ?? 0;
  document.documentElement.style.setProperty("--oc-size", size > 0 ? `${size}px` : "13px");
  // The cached height was measured in the old type size, so it has to be
  // measured again in the new one.
  const textarea = dom.textarea as HTMLTextAreaElement | undefined;
  if (textarea) {
    autosize(textarea);
  }
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

function toggleMenu(kind: Exclude<UiState["menu"], "none">, event?: Event): void {
  state.menu = state.menu === kind ? "none" : kind;
  state.menuOpenedBy = state.menu === "none" ? undefined : event;
  // A fresh opening starts unfiltered, on the model already in use, so Enter
  // re-picks what is selected rather than something arbitrary.
  if (state.menu === "model") {
    state.modelFilter = "";
    state.modelIndex = selectOption("model")?.current;
  }
  renderMenu();
}

function closeMenu(): void {
  state.menu = "none";
  state.menuOpenedBy = undefined;
  state.modelFilter = "";
  state.modelIndex = undefined;
  renderMenu();
}

function positionMenu(): void {
  const menu = dom.menu;
  if (!menu || menu.hidden) {
    return;
  }
  const anchor =
    state.menu === "model" ? dom.modelChip : state.menu === "mode" ? dom.modeChip : findMoreAnchor();
  if (!anchor) {
    return;
  }

  // Reset first so the measurements below are of the menu itself rather than
  // of wherever it happened to be.
  menu.style.top = "auto";
  menu.style.bottom = "auto";
  menu.style.left = "0px";

  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - menu.offsetWidth - margin))}px`;

  // The composer chips sit at the foot of the panel, so their menu opens
  // upward; the toolbar's "more" menu has no room that way and opens downward.
  const above = window.innerHeight - rect.top + gap;
  if (menu.offsetHeight <= above || rect.top <= menu.offsetHeight + gap) {
    menu.style.top = `${Math.round(rect.bottom + gap)}px`;
  } else {
    menu.style.bottom = `${Math.round(above)}px`;
  }
}

function findMoreAnchor(): HTMLElement | undefined {
  return root.querySelector<HTMLElement>('[data-action="more"]') ?? undefined;
}

function renderMenu(): void {
  const menu = dom.menu;
  if (!menu) {
    return;
  }

  dom.modeChip?.setAttribute("aria-expanded", String(state.menu === "mode"));
  dom.modelChip?.setAttribute("aria-expanded", String(state.menu === "model"));
  findMoreAnchor()?.setAttribute("aria-expanded", String(state.menu === "more"));

  if (state.menu === "none") {
    menu.hidden = true;
    menu.innerHTML = "";
    return;
  }

  menu.hidden = false;
  // The model picker is the only menu that scrolls its list rather than itself,
  // so the filter and the count stay put; the class is what the CSS keys off.
  menu.classList.toggle("menu-model", state.menu === "model");
  menu.innerHTML = menuContent(state.menu);
  positionMenu();
  if (state.menu === "model") {
    focusModelFilter();
    scrollModelHighlightIntoView();
  }
}

/**
 * Puts the caret back in the filter after a re-render.
 *
 * The menu is rebuilt wholesale on every keystroke and every arrow press, which
 * would otherwise drop focus to the body after the first character — so the
 * filter is refocused and the caret put back where the user left it.
 */
function focusModelFilter(): void {
  const filter = menuElement()?.querySelector<HTMLInputElement>(".menu-filter");
  if (!filter || document.activeElement === filter) {
    return;
  }
  const caret = state.modelFilter.length;
  filter.focus({ preventScroll: true });
  filter.setSelectionRange(caret, caret);
}

/** Keeps the highlighted row visible as the arrows walk a long list. */
function scrollModelHighlightIntoView(): void {
  const menu = menuElement();
  const row = menu?.querySelector<HTMLElement>(".menu-item.active");
  // `block: "nearest"` scrolls only when the row is actually off screen, so a
  // walk through a short list does not jolt the menu.
  row?.scrollIntoView({ block: "nearest" });
}

/**
 * Handles a key in the model picker's filter.
 *
 * Typing belongs to the input, so only the keys that cannot mean anything else
 * are taken: the arrows walk the choices without leaving the field, Enter picks
 * the highlighted one, and Escape closes. Everything else falls through to the
 * input, so `c` filters and `/` types a slash rather than being swallowed.
 */
function onModelFilterKey(event: KeyboardEvent): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveModelHighlight(1);
      return;
    case "ArrowUp":
      event.preventDefault();
      moveModelHighlight(-1);
      return;
    case "Enter": {
      event.preventDefault();
      const choice = state.modelIndex;
      if (choice) {
        applyMenuPick("model", choice);
      } else {
        closeMenu();
      }
      return;
    }
    case "Escape":
      event.preventDefault();
      closeMenu();
      return;
    default:
      return;
  }
}

/**
 * Moves the highlight through the choices currently on screen.
 *
 * The walk is over what the filter left visible, and it wraps: a list long
 * enough to need a filter is long enough that holding `↓` should not dead-end.
 */
function moveModelHighlight(step: number): void {
  const visible = visibleModelValues();
  if (!visible.length) {
    return;
  }
  const at = visible.indexOf(state.modelIndex ?? "");
  const next = at === -1 ? (step > 0 ? 0 : visible.length - 1) : (at + step + visible.length) % visible.length;
  state.modelIndex = visible[next];
  renderMenu();
}

/** The model ids on screen right now, in the order they are drawn. */
function visibleModelValues(): string[] {
  return Array.from(menuElement()?.querySelectorAll<HTMLElement>(".menu-item[data-kind='model']") ?? []).map(
    (element) => element.dataset.value ?? "",
  );
}

function menuElement(): HTMLElement | undefined {
  return dom.menu as HTMLElement | undefined;
}

function menuContent(kind: Exclude<UiState["menu"], "none">): string {
  if (kind === "model") {
    return modelMenu();
  }

  if (kind === "mode") {
    // ACP session modes are preferred, but agents (including OpenCode) may
    // expose the same choice as a `mode` configuration option instead.
    const modes = state.chat.modes;
    const modeOption = selectOption("mode");
    const sections: string[] = [];

    if (modes && modes.availableModes.length) {
      sections.push(
        `<div class="menu-label">Mode</div>` +
          modes.availableModes
            .map(
              (mode) =>
                `<button class="menu-item" role="menuitemradio" data-action="menu-pick" data-kind="mode" data-value="${escapeHtml(
                  mode.id,
                )}" aria-checked="${mode.id === modes.currentModeId}">${escapeHtml(mode.name)}${
                  mode.description ? `<span class="desc">${escapeHtml(mode.description)}</span>` : ""
                }</button>`,
            )
            .join(""),
      );
    } else if (modeOption?.options?.length) {
      sections.push(`<div class="menu-label">Mode</div>${renderChoices("mode", modeOption)}`);
    }

    const extras = (state.chat.configOptions ?? []).filter(
      (option) => option.id !== "model" && option.id !== "mode" && option.category !== "mode",
    );
    if (extras.length) {
      sections.push(
        `<div class="menu-sep"></div>` +
          extras
            .map((option) =>
              option.type === "select"
                ? `<div class="menu-label">${escapeHtml(option.name)}</div>${renderChoices(option.id, option)}`
                : `<button class="menu-item" role="menuitemcheckbox" data-action="menu-pick" data-kind="config" data-value="${escapeHtml(
                    option.id,
                  )}|${option.current === "true" ? "false" : "true"}" aria-checked="${option.current === "true"}">${escapeHtml(
                    option.name,
                  )}</button>`,
            )
            .join(""),
      );
    }

    return sections.join("") || `<div class="menu-item" aria-disabled="true">Agent did not offer any modes</div>`;
  }

  // "more" menu
  return [
    hostNote(),
    modelGapNote(),
    `<div class="menu-label">OpenCode</div>`,
    `<button class="menu-item" data-action="menu-cmd" data-value="new">${icon("add")} New chat</button>`,
    `<button class="menu-item" data-action="menu-cmd" data-value="history">${icon("history")} Resume chat…</button>`,
    `<button class="menu-item" data-action="menu-cmd" data-value="open-editor">${icon("open-preview")} Open in editor</button>`,
    `<div class="menu-sep"></div>`,
    `<button class="menu-item" data-action="retry-agent">${icon("debug-restart")} Restart agent</button>`,
    `<button class="menu-item" data-action="sign-in">${icon("sign-in")} Sign in…</button>`,
    `<button class="menu-item" data-action="menu-cmd" data-value="log">${icon("output")} Show log</button>`,
  ].join("");
}

/**
 * Which machine the models and settings on screen came from.
 *
 * Under Remote-SSH the answer is never "this machine the window is on", so the
 * menu says it outright instead of leaving the user to wonder whether a model
 * list is theirs or their server's. The binary path is included because it is
 * the other half of the question — *which* install answered.
 */
function hostNote(): string {
  const host = state.chat.host;
  if (!host) {
    return "";
  }
  const where = host.remoteName ? `${host.host} (${host.remoteName})` : host.host;
  const version = host.version ? `opencode ${host.version}` : "opencode";
  const detail = [
    host.binary,
    host.configDir ? `config ${host.configDir}` : undefined,
    host.modelCount !== undefined ? plural(host.modelCount, "model") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    `<div class="menu-note"><strong>${escapeHtml(where)}</strong>` +
    `${escapeHtml(`${version} · ${plural(host.sources?.length ?? 0, "config source")}`)}<br />` +
    `<code>${escapeHtml(detail)}</code></div>`
  );
}

/** `1 model` / `2 models`, so a count never reads as `1 model(s)`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What this machine has configured that the picker deliberately leaves out.
 *
 * These models cannot be selected — `set_config_option` resolves against the
 * agent's own catalog — so the picker does not offer them. Saying nothing would
 * leave the only symptom being "my OmniRouter models are gone", which reads as
 * a bug in the extension rather than a config the agent has not loaded. The
 * file is named because the file is what someone can go and look at.
 */
function modelGapNote(): string {
  const gap = state.chat.modelGap;
  if (!gap?.length) {
    return "";
  }
  return gap
    .map((entry) => {
      const provider = escapeHtml(entry.provider);
      const count = escapeHtml(plural(entry.count, "model"));
      return entry.path
        ? `<div class="menu-note"><strong>${provider}</strong> is not offered by this session. ${count} are configured in <code>${escapeHtml(entry.path)}</code>, which the agent has not loaded.</div>`
        : `<div class="menu-note"><strong>${provider}</strong> is not offered by this session. ${count} are configured, in no file this OpenCode reports.</div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* The model picker                                                    */
/* ------------------------------------------------------------------ */

/**
 * One group of models under a heading.
 *
 * `kind` decides how the heading reads: the remembered groups say where they
 * came from, a provider group says which provider serves those models and how
 * many of them there are, so a long catalog is countable rather than one
 * undifferentiated wall of rows.
 */
interface ModelGroup {
  kind: "recent" | "favorite" | "provider";
  heading: string;
  note?: string;
  models: ModelChoice[];
}

interface ModelChoice {
  value: string;
  label: string;
}

/**
 * Builds the model picker.
 *
 * A flat list is not usable once a machine carries a few hundred models — which
 * is exactly the state a provider like OmniRouter creates — so the list is cut
 * three ways: the models this person actually works with first, then one section
 * per provider under the name that provider's config gives it, then a filter
 * over all of it so nothing is out of reach.
 *
 * Every row here is one the agent offered. Nothing is added from the machine's
 * own catalog: `session/set_config_option` resolves a model against the agent's
 * catalog and refuses anything missing from it, so an added row would look
 * selectable and do nothing when picked.
 */
function modelMenu(): string {
  const option = selectOption("model");
  const all: ModelChoice[] = option?.options ?? [];
  if (!all.length) {
    return `<div class="menu-label">Model</div><div class="menu-item" aria-disabled="true">Agent did not offer any models</div>`;
  }

  const query = state.modelFilter.trim().toLowerCase();
  const shown = query ? all.filter((choice) => matchesFilter(choice, query)) : all;
  const groups = groupModels(shown, Boolean(query));
  // The highlighted row has to be one that is actually on screen: a filter can
  // hide the row that was highlighted when the menu opened.
  const highlighted = shown.some((choice) => choice.value === state.modelIndex)
    ? state.modelIndex
    : shown[0]?.value;

  const body = groups.length
    ? groups.map(renderModelGroup).join("")
    : `<div class="menu-item" aria-disabled="true">No model matches “${escapeHtml(state.modelFilter.trim())}”</div>`;

  return (
    `<div class="menu-label">Model</div>` +
    // `combobox` + `listbox` is the pattern a filterable dropdown is meant to
    // use: focus stays in the field, and `aria-activedescendant` names the row
    // the arrow keys are on, so it is announced without focus ever leaving it.
    `<input class="menu-filter" type="text" role="combobox" aria-expanded="true"` +
    ` aria-controls="model-listbox" aria-autocomplete="list"` +
    ` aria-activedescendant="${highlighted ? `model-choice-${escapeHtml(highlighted)}` : ""}"` +
    ` placeholder="Filter ${all.length} models…" aria-label="Filter models"` +
    ` value="${escapeHtml(state.modelFilter)}" />` +
    `<div class="menu-filter-count">${escapeHtml(filterCount(shown.length, all.length))}</div>` +
    `<div class="menu-body" role="listbox" id="model-listbox">` +
    body +
    `</div>` +
    modelCountNote(shown.length, all.length)
  );
}

/** What the counter under the filter reads. */
function filterCount(shown: number, total: number): string {
  const models = `${total} model${total === 1 ? "" : "s"}`;
  return shown === total ? models : `${shown} of ${models}`;
}

/**
 * Whether a model matches what the user typed.
 *
 * Both the readable label and the raw id are searched, so `opus` finds
 * `Claude Opus 5.5` and `corphub` finds everything OmniRouter serves, even
 * where the label the agent supplies says neither.
 */
function matchesFilter(choice: ModelChoice, query: string): boolean {
  return `${choice.label} ${choice.value}`.toLowerCase().includes(query);
}

/** A one-line tally under the list, so a filter that hid things says so. */
function modelCountNote(shown: number, total: number): string {
  if (shown === total) {
    return "";
  }
  return `<div class="menu-note">${shown} of ${total} models shown</div>`;
}

/**
 * Cuts the models into the sections the picker draws.
 *
 * While a filter is active the remembered groups are left out: every result is
 * already on screen, and re-listing the recents on top would duplicate rows the
 * user is trying to read between.
 */
function groupModels(models: ModelChoice[], filtering: boolean): ModelGroup[] {
  const groups: ModelGroup[] = [];

  if (!filtering) {
    for (const [kind, ids] of [
      ["recent", state.chat.modelRecent ?? []],
      ["favorite", state.chat.modelFavorite ?? []],
    ] as const) {
      const chosen = ids
        .map((id) => models.find((choice) => choice.value === id))
        .filter((choice): choice is ModelChoice => Boolean(choice));
      if (chosen.length) {
        groups.push({
          kind,
          heading: kind === "recent" ? "Recent" : "Favourites",
          note: kind === "recent" ? "from the OpenCode TUI" : "starred in the OpenCode TUI",
          models: chosen,
        });
      }
    }
  }

  const remembered = new Set(groups.flatMap((group) => group.models.map((choice) => choice.value)));
  const byProvider = new Map<string, ModelChoice[]>();
  for (const choice of models) {
    if (remembered.has(choice.value)) {
      continue;
    }
    const provider = providerOf(choice.value);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), choice]);
  }

  // Providers keep the order the agent sent them in — already grouped and sorted
  // upstream — rather than being re-sorted here, so the picker and the TUI agree
  // on what comes first.
  for (const [provider, choices] of byProvider) {
    groups.push({
      kind: "provider",
      heading: providerName(provider),
      note: `${choices.length} model${choices.length === 1 ? "" : "s"}`,
      models: choices,
    });
  }

  return groups;
}

/** The provider part of a model id, or the whole id when it has no prefix. */
function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash <= 0 ? id : id.slice(0, slash);
}

/**
 * The name to head a provider's section with.
 *
 * The config knows a provider by a name a person would use — `corphub` is
 * OmniRouter — so that is what the heading says. The id goes beside it in the
 * note, because it is what the model ids are built from and someone reading an
 * error message will be looking for it.
 */
function providerName(id: string): string {
  const configured = state.chat.host?.providers?.find((provider) => provider.id === id)?.name;
  return configured && configured !== id ? configured : id;
}

/**
 * One section of the model picker.
 *
 * The heading is a plain element rather than a listbox option: `aria-label` on
 * the group is what names the section, and putting the heading inside the
 * group would make it selectable.
 */
function renderModelGroup(group: ModelGroup): string {
  const note = group.note ? `<span class="menu-group-note">${escapeHtml(group.note)}</span>` : "";
  return (
    `<div class="menu-group-label">${escapeHtml(group.heading)}${note}</div>` +
    `<div class="menu-group" role="group" aria-label="${escapeHtml(group.heading)}">` +
    group.models.map((choice) => renderModelChoice(choice, group.kind === "provider")).join("") +
    `</div>`
  );
}

/**
 * One model row.
 *
 * A `role="option"` inside the listbox rather than a menu item: the highlighted
 * row is the combobox's `aria-activedescendant`, and `aria-selected` is what
 * carries the tick, so assistive tech reads "selected" off the row it is on
 * rather than off a separate menu.
 *
 * `named` says the section heading already names the provider, which is the
 * case inside a provider group — repeating `corphub` under a heading that says
 * OmniRouter is noise on every row.
 */
function renderModelChoice(choice: ModelChoice, named: boolean): string {
  const label = modelLabel(choice.value, choice.label);
  const selected = choice.value === currentModelId();
  const provider = named ? "" : label.provider ?? "";
  return (
    `<button class="menu-item${choice.value === state.modelIndex ? " active" : ""}"` +
    ` id="model-choice-${escapeHtml(choice.value)}" role="option"` +
    ` data-action="menu-pick" data-kind="model" data-value="${escapeHtml(choice.value)}"` +
    ` aria-selected="${selected}">` +
    `${escapeHtml(label.name)}` +
    (provider ? `<span class="desc">${escapeHtml(provider)}</span>` : "") +
    `</button>`
  );
}

/** The model the session is on, for the row that carries the tick. */
function currentModelId(): string | undefined {
  return selectOption("model")?.current;
}

/** Finds a configuration option by id, falling back to its category. */
function selectOption(id: string): ConfigOptionView | undefined {
  const options = state.chat.configOptions ?? [];
  return options.find((option) => option.id === id) ?? options.find((option) => option.category === id);
}

function renderChoices(configId: string, option: ConfigOptionView): string {
  return (option.options ?? [])
    .map((choice) => {
      const shown = choiceDisplay(configId, choice);
      return `<button class="menu-item" role="menuitemradio" data-action="menu-pick" data-kind="config" data-value="${escapeHtml(
        configId,
      )}|${escapeHtml(choice.value)}" aria-checked="${choice.value === option.current}">${escapeHtml(shown.name)}${
        shown.description ? `<span class="desc">${escapeHtml(shown.description)}</span>` : ""
      }</button>`;
    })
    .join("");
}

/**
 * What a choice reads as in the menu.
 *
 * Model ids are provider-prefixed slugs, so they are shown as a readable name
 * with the provider alongside rather than as `opencode/cat-jam-free`.
 */
function choiceDisplay(
  configId: string,
  choice: { value: string; label: string; description?: string },
): { name: string; description?: string } {
  if (configId !== "model") {
    return { name: choice.label, description: choice.description };
  }
  const label = modelLabel(choice.value, choice.label);
  return { name: label.name, description: choice.description ?? label.provider };
}

function menuCommand(value: string): string {
  switch (value) {
    case "new":
      return "opencode.chat.newSession";
    case "history":
      return "opencode.chat.pickSession";
    case "open-editor":
      return "opencode.chat.openInEditor";
    default:
      return "opencode.chat.open";
  }
}

function applyMenuPick(kind: string, value: string): void {
  closeMenu();
  if (kind === "mode") {
    post({ type: "setMode", modeId: value });
    return;
  }
  if (kind === "model") {
    post({ type: "setConfigOption", configId: "model", value });
    return;
  }
  const [configId, option] = value.split("|");
  post({ type: "setConfigOption", configId, value: option });
}

function onFieldChoice(element: HTMLElement): void {
  const requestId = element.dataset.id ?? "";
  const fieldKey = element.dataset.field ?? "";
  const value = element.dataset.choice ?? "";
  const multiple = element.dataset.multiple === "true";

  const answers = { ...(state.questionDrafts[requestId] ?? {}) };
  if (multiple) {
    const current = Array.isArray(answers[fieldKey]) ? (answers[fieldKey] as string[]) : [];
    answers[fieldKey] = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
  } else {
    answers[fieldKey] = value;
  }
  state.questionDrafts[requestId] = answers;

  const group = element.closest(".choice");
  group?.querySelectorAll<HTMLElement>("[data-choice]").forEach((node) => {
    const isSelected = multiple
      ? ((answers[fieldKey] as string[]) ?? []).includes(node.dataset.choice ?? "")
      : node.dataset.choice === value;
    node.setAttribute("aria-checked", String(isSelected));
    node.classList.toggle("active", isSelected);
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(): void {
  renderHeader();
  renderBanner();
  renderPlan();
  renderTranscript();
  renderQueue();
  renderStatusBar();
  renderComposer();
  renderMenu();
}

function renderHeader(): void {
  const { connection, cwd, session, busy } = state.chat;
  dom.dot.dataset.state = connection;
  const sub = dom.sub;
  if (session?.title) {
    sub.textContent = session.title;
  } else if (cwd) {
    sub.textContent = shortPath(cwd);
  } else {
    sub.textContent = "";
  }
  dom.dot.title =
    connection === "ready"
      ? [`OpenCode connected${session ? ` — session ${session.sessionId}` : ""}`, hostLine()].filter(Boolean).join("\n")
      : [state.chat.connectionMessage ?? "OpenCode is not running", hostLine()].filter(Boolean).join("\n");

  const send = dom.send;
  send.classList.toggle("stop", busy);
  send.innerHTML = busy
    ? `<span class="codicon codicon-debug-stop"></span>`
    : `<span class="codicon codicon-send"></span>`;
  send.title = busy ? "Stop generating" : "Send";
}

/** One line naming the machine the agent, models and settings come from. */
function hostLine(): string | undefined {
  const host = state.chat.host;
  if (!host) {
    return undefined;
  }
  const version = host.version ? host.version : "version unknown";
  return `Running on ${host.host}${host.remoteName ? ` (${host.remoteName})` : ""} — opencode ${version} at ${host.binary}`;
}

function renderBanner(): void {
  const banner = dom.banner;
  const chat = state.chat;
  if (chat.connection === "error") {
    banner.hidden = false;
    dom.bannerMessage.textContent =
      chat.connectionMessage ?? "OpenCode stopped responding. Restart it to continue.";
    const needsAuth = /sign in|auth/i.test(chat.connectionMessage ?? "");
    const actions = banner.querySelector<HTMLElement>(".banner-actions");
    if (actions) {
      actions.hidden = !needsAuth && chat.connection === "error";
      actions.querySelector<HTMLElement>('[data-action="sign-in"]')!.hidden = !needsAuth;
      actions.querySelector<HTMLElement>('[data-action="retry-agent"]')!.hidden = needsAuth;
    }
  } else {
    banner.hidden = true;
  }
}

function renderPlan(): void {
  const plan = dom.plan;
  const entries = state.chat.plan;
  if (!entries || !entries.length || !state.chat.options.showPlan) {
    plan.hidden = true;
    plan.innerHTML = "";
    return;
  }

  const done = entries.filter((entry) => entry.status === "completed").length;
  plan.hidden = false;
  plan.innerHTML = `
    <button class="plan-title" data-action="toggle-plan" aria-expanded="${state.planOpen}">
      <span class="codicon codicon-list-ordered"></span>
      Plan ${done}/${entries.length}
      <span class="codicon ${state.planOpen ? "codicon-chevron-down" : "codicon-chevron-right"}"></span>
    </button>
    ${
      state.planOpen
        ? `<ul class="plan-list">${entries
            .map(
              (entry) => `
          <li class="plan-item" data-status="${entry.status}">
            <span class="codicon ${planIcon(entry.status)}"></span>
            <span>${escapeHtml(entry.content)}</span>
          </li>`,
            )
            .join("")}</ul>`
        : ""
    }
  `;
}

function planIcon(status: string): string {
  if (status === "completed") {
    return "codicon-pass";
  }
  if (status === "in_progress") {
    return "codicon-loading codicon-modifier-spin";
  }
  return "codicon-circle-outline";
}

/** One top-level element of the transcript. */
interface TranscriptUnit {
  /** Cache key; also written to `data-id` on the element. */
  key: string;
  /** Changes whenever the HTML below it changes, so a stale element is rebuilt. */
  signature: string;
  className: string;
  html: string;
}

/**
 * What the transcript is made of, top to bottom.
 *
 * The greeting counts as a unit like any other, so the first message tears it
 * down instead of leaving it stranded below the conversation.
 */
function transcriptUnits(): TranscriptUnit[] {
  const items = visibleItems();
  if (items.length) {
    return itemUnits(items);
  }
  // Hidden thoughts leave nothing to draw, but the user has already spoken, so
  // the greeting must not come back at them.
  return state.chat.items.length ? [] : [welcomeUnit()];
}

/**
 * Keyboard handling for a focused permission prompt.
 *
 * The agent is blocked until this is answered, so the prompt takes focus when
 * it arrives and owns the keyboard while it holds it: Enter approves once,
 * Escape declines, and the arrow keys walk the options. Scoping this to the
 * focused prompt is what keeps it from swallowing keystrokes destined for the
 * composer — the composer's own Enter handler is on a different element.
 */
function onPromptKey(event: KeyboardEvent): void {
  const prompt = (event.target as HTMLElement | null)?.closest<HTMLElement>(".prompt[data-prompt]");
  if (!prompt || event.defaultPrevented) {
    return;
  }

  const buttons = Array.from(prompt.querySelectorAll<HTMLButtonElement>(".prompt-actions .btn"));
  const pick = (selector: string) => prompt.querySelector<HTMLButtonElement>(selector);

  switch (event.key) {
    case "Enter": {
      const target = pick(".btn.allow") ?? buttons[0];
      if (!target) {
        return;
      }
      event.preventDefault();
      target.click();
      return;
    }
    case "Escape": {
      // Declining is always available and is the safe way out of a prompt the
      // user did not want in the first place.
      const target = pick(".btn.deny") ?? buttons[buttons.length - 1];
      if (target) {
        event.preventDefault();
        target.click();
      } else {
        post({ type: "respondPermission", requestId: prompt.dataset.request ?? "", outcome: "cancelled" });
      }
      return;
    }
    case "ArrowLeft":
    case "ArrowRight": {
      if (!buttons.length) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const current = buttons.findIndex((button) => button === document.activeElement);
      const next = buttons[(Math.max(current, 0) + step + buttons.length) % buttons.length];
      next.focus();
      return;
    }
    default:
      return;
  }
}

/**
 * Brings a newly arrived prompt on screen and puts the keyboard on it.
 *
 * The transcript only auto-scrolls when the reader is already at the bottom,
 * which leaves a prompt to arrive silently off-screen while the agent waits —
 * the single most confusing way this dialog can behave. Focus is skipped when
 * the user is part-way through typing, because yanking the caret mid-sentence
 * to ask about a command is worse than making them click.
 */
let lastPromptRequest: string | undefined;

function focusNewPrompt(): void {
  const prompts = dom.transcript?.querySelectorAll<HTMLElement>(".prompt[data-prompt]");
  // The newest prompt is the one the agent is waiting on; anything before it
  // is history.
  const prompt = prompts?.[prompts.length - 1];
  if (!prompt) {
    lastPromptRequest = undefined;
    return;
  }
  const request = prompt.dataset.request ?? "";
  if (request === lastPromptRequest) {
    return;
  }
  lastPromptRequest = request;
  prompt.scrollIntoView({ block: "nearest", behavior: "smooth" });

  const typing =
    document.activeElement === dom.textarea && Boolean((dom.textarea as HTMLTextAreaElement | null)?.value.trim());
  if (!typing) {
    prompt.focus({ preventScroll: true });
  }
}

function renderTranscript(): void {
  const transcript = dom.transcript;
  const wasAtBottom = isAtBottom(transcript);

  const seen = new Set<string>();
  let previous: HTMLElement | null = null;

  for (const unit of transcriptUnits()) {
    seen.add(unit.key);
    const cached = rendered.get(unit.key);

    let element: HTMLElement;
    if (cached && cached.signature === unit.signature) {
      element = cached.element;
    } else {
      element = document.createElement("div");
      element.className = unit.className;
      element.dataset.id = unit.key;
      element.innerHTML = unit.html;
      rendered.set(unit.key, { signature: unit.signature, element });
      if (cached) {
        // A rebuilt element has to take the old one's place in the DOM. Adding
        // it by the walk below instead would leave the old one behind with
        // nothing left pointing at it, and it would stay on screen for good —
        // the greeting outliving the connection state that drew it.
        cached.element.replaceWith(element);
      }
    }

    const expected: Element | null = previous ? previous.nextElementSibling : transcript.firstElementChild;
    if (expected !== element) {
      if (previous) {
        previous.after(element);
      } else {
        transcript.prepend(element);
      }
    }
    previous = element;
  }

  for (const [id, entry] of rendered) {
    if (!seen.has(id)) {
      entry.element.remove();
      rendered.delete(id);
    }
  }

  if (wasAtBottom) {
    scrollToEnd(false);
  }
  focusNewPrompt();
}

function rerenderItem(itemElement: HTMLElement): void {
  const key = itemElement.dataset.id;
  if (!key) {
    return;
  }
  const unit = transcriptUnits().find((entry) => entry.key === key);
  if (!unit) {
    return;
  }
  itemElement.innerHTML = unit.html;
  rendered.set(key, { signature: unit.signature, element: itemElement });
}

function visibleItems(): ChatItem[] {
  const showThoughts = state.chat.options.showThoughts;
  return state.chat.items.filter((item) => {
    if (item.kind === "thought" && !showThoughts) {
      return false;
    }
    return true;
  });
}

/**
 * Folds the items into what is actually drawn.
 *
 * Consecutive finished tool calls collapse into a single summary row: a turn
 * can run dozens of them, and a card each buries the answer the user came
 * for. Calls that are running or failed keep their own row, because that is
 * exactly when they are worth watching.
 */
function itemUnits(items: ChatItem[]): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  let finished: ToolCall[] = [];

  const flush = (): void => {
    if (!finished.length) {
      return;
    }
    units.push(toolUnit(finished));
    finished = [];
  };

  for (const item of items) {
    if (item.kind === "tool" && item.call.status === "completed") {
      finished.push(item.call);
      continue;
    }
    flush();
    units.push({
      key: item.id,
      signature: itemSignature(item),
      className: `item item-${item.kind}`,
      html: itemHtml(item),
    });
  }
  flush();
  return units;
}

/**
 * One tool call on its own, or a run of them behind a single summary row.
 *
 * A lone call keeps its own card: its title carries the detail ("Read
 * src/rate-limit.ts") that a summary would throw away.
 */
function toolUnit(calls: ToolCall[]): TranscriptUnit {
  if (calls.length === 1) {
    const call = calls[0];
    return {
      key: `tool:${call.toolCallId}`,
      signature: toolSignature(call),
      className: "item item-tool",
      html: toolHtml(call),
    };
  }

  // The run is keyed by its first call, which never changes once finished, so
  // the row survives the rest of the run filling in around it.
  const key = `tools:${calls[0].toolCallId}`;
  return {
    key,
    signature: JSON.stringify([
      calls.map((call) => [call.toolCallId, call.title, call.content, call.locations, call.childSession]),
      state.openTools.has(key),
      state.chat.options.maxToolOutputLines,
      state.chat.options.diffView,
    ]),
    className: "item item-tool",
    html: toolRunHtml(calls, key),
  };
}

function itemSignature(item: ChatItem): string {
  switch (item.kind) {
    case "agent":
      // The dots are part of the HTML, so `streaming` and `busy` have to be
      // part of the signature or the animation is never taken back down.
      return JSON.stringify([item.kind, item.blocks, item.streaming, state.chat.busy]);
    case "thought":
      return JSON.stringify([item.kind, item.blocks, item.streaming, state.openThoughts.has(item.id)]);
    case "tool":
      return toolSignature(item.call);
    case "user":
      // `status` is part of the signature or a message the queue threw away
      // keeps its badge forever.
      return JSON.stringify([item.kind, item.blocks, item.status]);
    case "permission":
      return JSON.stringify([item.request, item.resolved]);
    case "question":
      return JSON.stringify([item.question, item.resolved, state.questionDrafts[item.question.requestId] ?? {}]);
    default:
      return JSON.stringify(item);
  }
}

function toolSignature(call: ToolCall): string {
  return JSON.stringify([
    call.status,
    call.title,
    call.content,
    call.locations,
    call.childSession,
    state.openTools.has(call.toolCallId),
    state.chat.options.maxToolOutputLines,
    state.chat.options.diffView,
  ]);
}

function itemHtml(item: ChatItem): string {
  switch (item.kind) {
    case "user":
      return userHtml(item);
    case "agent":
      return `${renderBlocks(item.blocks)}${isWriting(item) ? typingDots() : ""}`;
    case "thought":
      return thoughtHtml(item.id, item.blocks);
    case "tool":
      return toolHtml(item.call);
    case "permission":
      return permissionHtml(item.request, item.resolved);
    case "question":
      return questionHtml(item.question, item.resolved);
    case "compaction":
      return compactionHtml(item);
    case "notice":
      return noticeHtml(item.severity, item.title, item.description);
    case "error":
      return noticeHtml("error", item.message, item.detail);
    default:
      return "";
  }
}

/**
 * A user message the agent is working on, or one the queue threw away.
 *
 * A message waiting its turn is not here at all — it sits in the queue above
 * the composer until it actually starts, so a transcript bubble always means
 * the agent has it.
 */
function userHtml(item: Extract<ChatItem, { kind: "user" }>): string {
  const badge =
    item.status === "dropped"
      ? `<span class="bubble-flag dropped"><span class="codicon codicon-circle-slash"></span>Not sent</span>`
      : "";
  return `<div class="bubble-user${item.status ? ` is-${item.status}` : ""}">
    ${renderBlocks(item.blocks)}${badge}
  </div>`;
}

/**
 * The waiting queue, stacked directly above the composer.
 *
 * Shown in send order with a position number, because the last row is the one
 * that runs next — the list is a schedule, not a log.
 */
function renderQueue(): void {
  const queue = dom.queue;
  if (!queue) {
    return;
  }
  const entries = state.chat.queue ?? [];
  queue.hidden = entries.length === 0;
  queue.innerHTML = entries
    .map(
      (entry, index) => `<div class="queue-row">
        <span class="queue-pos" aria-hidden="true">${index + 1}</span>
        <span class="queue-text" title="${escapeHtml(entry.preview)}">${escapeHtml(entry.preview)}</span>
      </div>`,
    )
    .join("");
}

/**
 * Whether the "agent is writing" dots belong on screen.
 *
 * Both halves have to hold: the message is still open *and* a turn is running.
 * Trusting the message alone leaves the animation spinning forever whenever a
 * turn settles some other way than by finishing its last message.
 */
function isWriting(item: Extract<ChatItem, { kind: "agent" | "thought" }>): boolean {
  return item.streaming === true && state.chat.busy;
}

function thoughtHtml(id: string, blocks: Block[]): string {
  const open = state.openThoughts.has(id);
  const text = blocksToText(blocks);
  return `
    <button class="thought-toggle" data-action="toggle-thought" data-id="${escapeHtml(id)}" aria-expanded="${open}">
      <span class="codicon codicon-chevron-${open ? "down" : "right"}"></span>
      Thinking
    </button>
    ${open ? `<div class="markdown">${renderMarkdown(text)}</div>` : ""}
  `;
}

/**
 * A run of finished tool calls as one row.
 *
 * Collapsed it only says what happened ("Read 3 files · Edited 1 file");
 * opened it lists every call in the run with its diff and output. The
 * alternative — leaving each call on screen — buries the agent's answer under
 * a column of cards the user cannot do anything with.
 */
function toolRunHtml(calls: ToolCall[], key: string): string {
  const open = state.openTools.has(key);
  return `
    <div class="tool tool-run" data-open="${open}">
      <button class="tool-head" data-action="toggle-tool" data-id="${escapeHtml(key)}" aria-expanded="${open}">
        <span class="tool-icon codicon codicon-check"></span>
        <span class="tool-title">${escapeHtml(summariseTools(calls))}</span>
        <span class="tool-badge">${calls.length} tools</span>
        <span class="tool-chevron codicon codicon-chevron-right"></span>
      </button>
      ${open ? `<div class="tool-body tool-run-body">${calls.map((call) => toolHtml(call, true)).join("")}</div>` : ""}
    </div>
  `;
}

/** Buckets a call is summarised into, most specific first. */
const TOOL_GROUPS: Array<{ verb: string; noun: string; match: RegExp }> = [
  { verb: "Read", noun: "file", match: /(read|view|open|cat)/ },
  { verb: "Searched", noun: "match", match: /(grep|glob|search|list|find|query)/ },
  { verb: "Edited", noun: "file", match: /(edit|write|patch|apply|create|update)/ },
  { verb: "Changed", noun: "file", match: /(delete|remove|move|rename)/ },
  { verb: "Ran", noun: "command", match: /(bash|shell|exec|command|terminal|task|run)/ },
];

/**
 * Says what a run of tool calls amounted to.
 *
 * The per-call titles are the detail a summary is standing in for — repeating
 * them would be as noisy as the cards it replaces — so calls are bucketed by
 * what they do instead.
 */
function summariseTools(calls: ToolCall[]): string {
  const buckets: Array<{ verb: string; noun: string; count: number }> = [];

  for (const call of calls) {
    const haystack = `${call.name ?? ""} ${call.kind ?? ""}`.toLowerCase();
    const group = TOOL_GROUPS.find((entry) => entry.match.test(haystack));
    const verb = group?.verb ?? "Used";
    const noun = group?.noun ?? "tool";
    const existing = buckets.find((bucket) => bucket.verb === verb);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.push({ verb, noun, count: 1 });
    }
  }

  return buckets
    .map(({ verb, noun, count }) => (count > 1 ? `${verb} ${count} ${noun}s` : `${verb} ${noun}`))
    .join(" · ");
}

/**
 * One tool call.
 *
 * `nested` marks a call drawn inside an opened run: its body is always shown
 * and its head is a label rather than a second toggle to discover.
 */
function toolHtml(call: ToolCall, nested = false): string {
  const open = nested || state.openTools.has(call.toolCallId);
  const status = call.status ?? "pending";
  const outputs = call.content.filter((entry) => entry.type === "text") as Array<{ type: "text"; text: string }>;
  const diffs = call.content.filter((entry) => entry.type === "diff") as Array<{
    type: "diff";
    path: string;
    oldText?: string;
    newText: string;
  }>;
  const showDiffs = state.chat.options.diffView !== "off";

  const statusIcon =
    status === "completed"
      ? "codicon-check"
      : status === "failed"
        ? "codicon-error"
        : status === "in_progress"
          ? "codicon-loading codicon-modifier-spin"
          : "codicon-circle-outline";

  const rawText = outputs.map((entry) => entry.text).join("");
  const truncated = needsExpand(rawText);
  const textOutputs = clipText(rawText, state.chat.options.maxToolOutputLines);

  const body = [
    showDiffs ? diffs.map(diffHtml).join("") : "",
    textOutputs
      ? `<pre class="tool-output${truncated ? " is-clipped" : ""}">${escapeHtml(textOutputs)}</pre>`
      : "",
    truncated ? `<button class="tool-more" data-action="noop">Show more</button>` : "",
    call.locations.length
      ? `<div class="tool-actions">${call.locations
          .map(
            (location) =>
              `<button class="btn ghost" data-action="open-file" data-path="${escapeHtml(location.path)}" data-line="${location.line ?? 0}">${icon(
                "go-to-file",
              )} ${escapeHtml(basename(location.path))}${location.line ? `:${location.line}` : ""}</button>`,
          )
          .join("")}</div>`
      : "",
  ].join("");

  const head = `
        <span class="tool-icon codicon ${statusIcon}"></span>
        <span class="tool-title">${escapeHtml(call.title)}</span>
        ${
          call.childSession
            ? `<span class="tool-child">${escapeHtml(call.childSession.title ?? `subagent · depth ${call.childSession.depth}`)}</span>`
            : ""
        }
        ${open && body && !nested ? `<span class="tool-badge">${escapeHtml(call.name ?? call.kind ?? "")}</span>` : ""}
        ${nested ? "" : `<span class="tool-chevron codicon codicon-chevron-right"></span>`}`;

  return `
    <div class="tool${nested ? " tool-nested" : ""}" data-status="${status}" data-open="${open}">
      ${
        nested
          ? `<div class="tool-head">${head}</div>`
          : `<button class="tool-head" data-action="toggle-tool" data-id="${escapeHtml(call.toolCallId)}" aria-expanded="${open}">${head}</button>`
      }
      ${open && body ? `<div class="tool-body">${body}</div>` : ""}
    </div>
  `;
}

function diffHtml(diff: { type: "diff"; path: string; oldText?: string; newText: string }): string {
  if (state.chat.options.diffView !== "inline") {
    return `<div class="diff">
      <div class="diff-head">
        <span class="codicon codicon-file"></span>
        <button class="diff-path" data-action="open-file" data-path="${escapeHtml(diff.path)}">${escapeHtml(basename(diff.path))}</button>
        <button class="btn ghost" data-action="open-diff" data-path="${escapeHtml(diff.path)}" data-old="${escapeHtml(
          diff.oldText ?? "",
        )}" data-new="${escapeHtml(diff.newText)}">${icon("diff")} Open diff</button>
      </div>
    </div>`;
  }

  const result = diffLines(diff.oldText ?? "", diff.newText);
  const rows: string[] = [];
  for (const row of result.rows as DiffRow[]) {
    rows.push(diffRowHtml(row));
  }

  return `<div class="diff">
    <div class="diff-head">
      <span class="codicon codicon-file"></span>
      <button class="diff-path" data-action="open-file" data-path="${escapeHtml(diff.path)}">${escapeHtml(basename(diff.path))}</button>
      <span class="diff-stat"><span class="diff-add">+${result.additions}</span> <span class="diff-del">−${result.deletions}</span></span>
      <button class="icon-button" data-action="open-diff" data-path="${escapeHtml(diff.path)}" data-old="${escapeHtml(
        diff.oldText ?? "",
      )}" data-new="${escapeHtml(diff.newText)}" title="Open in diff editor">
        <span class="codicon codicon-diff"></span>
      </button>
    </div>
    <div class="diff-body">${rows.join("")}</div>
  </div>`;
}

function diffRowHtml(row: DiffRow): string {
  if (row.type === "hunk") {
    return `<div class="diff-line hunk"><span class="diff-text">@@ -${row.oldStart},${row.oldCount} +${row.newStart},${row.newCount} @@</span></div>`;
  }
  if (row.type === "same") {
    return `<div class="diff-line"><span class="diff-num">${row.oldLine}</span><span class="diff-text">${escapeHtml(row.text)}</span></div>`;
  }
  if (row.type === "add") {
    return `<div class="diff-line add"><span class="diff-num"></span><span class="diff-num">${row.newLine}</span><span class="diff-text">${escapeHtml(row.text)}</span></div>`;
  }
  return `<div class="diff-line del"><span class="diff-num">${row.oldLine}</span><span class="diff-num"></span><span class="diff-text">${escapeHtml(row.text)}</span></div>`;
}

function permissionHtml(
  request: PermissionRequest,
  resolved?: { outcome: "selected" | "cancelled"; optionId?: string; label?: string },
): string {
  if (resolved) {
    const approved = resolved.outcome === "selected";
    return `<div class="resolved ${approved ? "approved" : "rejected"}">
      <span class="codicon codicon-${approved ? "check" : "close"}"></span>
      ${approved ? `Approved: ${escapeHtml(resolved.label ?? "yes")}` : "Declined"}
    </div>`;
  }

  const command = request.content.find((entry) => entry.type === "text") as { type: "text"; text: string } | undefined;
  const diffs = request.content.filter((entry) => entry.type === "diff") as Array<{
    type: "diff";
    path: string;
    oldText?: string;
    newText: string;
  }>;

  // The agent names its own options ("Allow once", "Always allow", …), but the
  // risk they carry differs a lot: a single approval is routine, a persistent
  // grant is not, and rejecting once is the safest way to say no. Styling all
  // four the same made the dialog unreadable, so each option is mapped to a
  // role the stylesheet can weight differently.
  const allows = request.options.filter((option) => !option.kind.startsWith("reject"));
  const denies = request.options.filter((option) => option.kind.startsWith("reject"));

  const optionButton = (option: PermissionOption) => {
    const allow = !option.kind.startsWith("reject");
    // Only a one-off approval gets the solid "just do it" treatment; the
    // persistent variants stay outlined so a stray click cannot quietly widen
    // the agent's permissions for the rest of the session.
    const variant = allow
      ? option.kind === "allow_always"
        ? "allow-persist"
        : "allow"
      : option.kind === "reject_always"
        ? "deny-persist"
        : "deny";
    return `<button class="btn ${variant}" data-action="permission" data-id="${escapeHtml(
      request.requestId,
    )}" data-option="${escapeHtml(option.optionId)}">${escapeHtml(option.name)}</button>`;
  };

  // The single safest approval, which is what Enter and the initial focus pick.
  const enterOption = allows.find((option) => option.kind === "allow_once") ?? allows[0];
  const escapeOption = denies.find((option) => option.kind === "reject_once") ?? denies[0];

  return `<div class="prompt${request.warning ? " has-warning" : ""}" data-prompt data-request="${escapeHtml(
    request.requestId,
  )}" tabindex="-1" role="group" aria-label="${escapeHtml(request.title)}">
    <div class="prompt-head">
      <span class="codicon codicon-shield"></span>
      <span class="prompt-title">${escapeHtml(request.title)}</span>
      <span class="prompt-state">Waiting for you</span>
    </div>
    <div class="prompt-body">
      ${request.warning ? `<div class="prompt-warning"><span class="codicon codicon-warning"></span><span>${escapeHtml(request.warning)}</span></div>` : ""}
      ${command ? `<div class="prompt-command">${escapeHtml(clipText(command.text, 20).trim())}</div>` : ""}
      ${diffs.map(diffHtml).join("")}
      <div class="prompt-actions">
        <div class="prompt-group">
          ${allows.map(optionButton).join("")}
        </div>
        ${
          denies.length
            ? `<div class="prompt-divider" role="separator"></div><div class="prompt-group">${denies.map(optionButton).join("")}</div>`
            : ""
        }
      </div>
      <div class="prompt-hint">
        ${
          enterOption
            ? `<span><kbd>Enter</kbd> ${escapeHtml(enterOption.name)}</span>`
            : `<span><kbd>Enter</kbd> confirm</span>`
        }
        ${escapeOption ? `<span><kbd>Esc</kbd> ${escapeHtml(escapeOption.name)}</span>` : ""}
      </div>
    </div>
  </div>`;
}

function questionHtml(
  question: Question,
  resolved?: { action: "accept" | "decline" | "cancel"; summary?: string },
): string {
  if (resolved) {
    const iconName = resolved.action === "accept" ? "check" : resolved.action === "decline" ? "close" : "debug-stop";
    const label = resolved.action === "accept" ? "Answered" : resolved.action === "decline" ? "Declined" : "Cancelled";
    return `<div class="resolved ${resolved.action === "accept" ? "approved" : "rejected"}">
      <span class="codicon codicon-${iconName}"></span>
      ${label}${resolved.summary ? ` — ${escapeHtml(resolved.summary)}` : ""}
    </div>`;
  }

  const answers = state.questionDrafts[question.requestId] ?? {};
  const fields = question.fields.map((field) => fieldHtml(field, question.requestId, answers)).join("");
  return `<div class="prompt${question.fields.some((field) => field.required) ? " has-warning" : ""}" data-prompt data-question data-request="${escapeHtml(
    question.requestId,
  )}" tabindex="-1" role="group" aria-label="${escapeHtml(question.message)}">
    <div class="prompt-head">
      <span class="codicon codicon-question"></span>
      <span class="prompt-title">${escapeHtml(question.message)}</span>
      <span class="prompt-state">Waiting for you</span>
    </div>
    <div class="prompt-body">
      ${fields}
      <div class="prompt-actions">
        <div class="prompt-group">
          <button class="btn allow" data-action="question-accept" data-id="${escapeHtml(
            question.requestId,
          )}">Submit</button>
        </div>
        <div class="prompt-divider" role="separator"></div>
        <div class="prompt-group">
          <button class="btn" data-action="question-decline" data-id="${escapeHtml(question.requestId)}">Skip</button>
          <button class="btn deny" data-action="question-cancel" data-id="${escapeHtml(
            question.requestId,
          )}">Cancel</button>
        </div>
      </div>
      <div class="prompt-hint">
        <span><kbd>Enter</kbd> Submit</span>
        <span><kbd>Esc</kbd> Cancel</span>
      </div>
    </div>
  </div>`;
}

function fieldHtml(field: FormField, requestId: string, answers: Record<string, unknown>): string {
  const id = escapeHtml(requestId);
  const label = escapeHtml(field.label + (field.required ? " *" : ""));

  switch (field.control) {
    case "boolean": {
      const checked = answers[field.key] === true;
      return `<div class="field">
        <label class="field-label"><input type="checkbox" data-field-input="${escapeHtml(field.key)}" data-id="${id}" ${
          checked ? "checked" : ""
        }> ${label}</label>
      </div>`;
    }
    case "textarea":
      return `<div class="field">
        <span class="field-label">${label}</span>
        <textarea rows="3" data-field-input="${escapeHtml(field.key)}" data-id="${id}">${escapeHtml(
          String(answers[field.key] ?? ""),
        )}</textarea>
      </div>`;
    case "select": {
      const current = answers[field.key];
      const selected = new Set(Array.isArray(current) ? current : current ? [current] : []);
      const options = field.options
        .map(
          (option) =>
            `<button class="chip ${selected.has(option.value) ? "active" : ""}" data-choice="${escapeHtml(
              option.value,
            )}" data-field="${escapeHtml(field.key)}" data-id="${id}" data-multiple="${field.multiple}" aria-checked="${selected.has(
              option.value,
            )}">${escapeHtml(option.label)}</button>`,
        )
        .join("");
      const custom =
        field.customKey && field.control === "select"
          ? `<input type="text" placeholder="Other…" data-field-input="${escapeHtml(field.customKey)}" data-id="${id}" value="${escapeHtml(
              String(answers[field.customKey] ?? ""),
            )}">`
          : "";
      return `<div class="field">
        <span class="field-label">${label}</span>
        <div class="choice">${options}</div>
        ${custom}
      </div>`;
    }
    default:
      return `<div class="field">
        <span class="field-label">${label}</span>
        <input type="text" placeholder="${escapeHtml(field.placeholder ?? "")}" data-field-input="${escapeHtml(
          field.key,
        )}" data-id="${id}" value="${escapeHtml(String(answers[field.key] ?? ""))}">
      </div>`;
  }
}

function compactionHtml(item: Extract<ChatItem, { kind: "compaction" }>): string {
  const summary = item.summary.map((block) => (block.type === "text" ? block.text : "")).join("");
  const failed = item.status === "failed";
  return `<div class="notice" data-severity="${failed ? "error" : "info"}">
    <span class="codicon codicon-${failed ? "error" : "history"}"></span>
    <div>
      <div class="notice-title">Context compacted${failed ? " (failed)" : ""}</div>
      ${summary ? `<div class="notice-desc">${escapeHtml(clipText(summary, 4).trim())}</div>` : ""}
    </div>
  </div>`;
}

function noticeHtml(severity: string, title: string, description?: string): string {
  const iconName = severity === "error" ? "error" : severity === "warning" ? "warning" : "info";
  return `<div class="notice" data-severity="${escapeHtml(severity)}">
    <span class="codicon codicon-${iconName}"></span>
    <div>
      <div class="notice-title">${escapeHtml(title)}</div>
      ${description ? `<div class="notice-desc">${escapeHtml(description)}</div>` : ""}
    </div>
  </div>`;
}

function welcomeUnit(): TranscriptUnit {
  const { connection, connectionMessage, cwd } = state.chat;
  return {
    key: "welcome",
    signature: JSON.stringify([connection, connectionMessage, cwd]),
    className: "welcome",
    html: welcomeHtml(),
  };
}

function welcomeHtml(): string {
  const { connection, connectionMessage, cwd } = state.chat;

  if (connection === "error") {
    return `<h1>OpenCode isn't running</h1>
      <p>${escapeHtml(connectionMessage ?? "The agent process is not responding.")}</p>`;
  }

  // The dots belong to an agent that is on its way in. Everywhere else they
  // would outlive the thing they were waiting for.
  if (connection === "starting") {
    return `<h1>Starting OpenCode…</h1>
      <p>${
        cwd
          ? `Connecting to the agent in <code>${escapeHtml(basename(cwd))}</code>.`
          : "Connecting to the agent."
      } ${typingDots()}</p>`;
  }

  return `<h1>What should we build?</h1>
    <p>Ask anything about <code>${escapeHtml(
      basename(cwd ?? "this folder"),
    )}</code>. OpenCode reads and edits your files, so it asks before running anything.</p>`;
}

/* ------------------------------------------------------------------ */
/* Status bar & composer                                               */
/* ------------------------------------------------------------------ */

function renderStatusBar(): void {
  const { usage, retry, busy, connection } = state.chat;
  const parts: string[] = [];

  if (retry) {
    parts.push(
      `<span class="usage retry"><span class="spinner"></span>Retrying (${escapeHtml(retry.error.message)})</span>`,
    );
  } else if (busy) {
    // A static "Working…" cannot tell a live turn from a stalled one. The
    // spinner keeps moving for as long as the agent is actually working.
    parts.push(`<span class="usage working"><span class="spinner"></span>Working…</span>`);
  }

  if (usage) {
    const ratio = contextRatio(usage);
    const meter =
      ratio === undefined
        ? `<span class="usage" title="${usage.used} tokens used this session">${compactNumber(usage.used)} tokens</span>`
        : `<span class="usage context" title="${usage.used} of ${usage.size} context tokens used (${formatPercent(ratio)})">
            <span class="usage-figure">${compactNumber(usage.used)}</span>
            <span class="usage-of">/ ${compactNumber(usage.size)}</span>
            <span class="context-meter ${meterLevel(ratio)}"><span style="width:${Math.round(ratio * 100)}%"></span></span>
            <span class="usage-pct">${formatPercent(ratio)}</span>
          </span>`;
    parts.push(meter);
    if (usage.cost) {
      parts.push(
        `<span class="usage cost" title="Session cost">${
          usage.cost.currency === "USD" ? "$" : `${usage.cost.currency} `
        }${usage.cost.amount.toFixed(3)}</span>`,
      );
    }
  }

  if (state.chat.authInProgress) {
    parts.push(`<span class="usage">Waiting for sign-in…</span>`);
  }

  // The folder name used to sit here. It was the only thing between the
  // counters and the composer, it repeated what the window title already says,
  // and it pushed the context meter off the left edge on narrow panels.
  parts.push(`<span class="spacer"></span>`);
  if (connection === "starting") {
    parts.push(`<span class="usage working"><span class="spinner"></span>Starting OpenCode…</span>`);
  }

  dom.statusbar.innerHTML = parts.join("");
}

function renderComposer(): void {
  const textarea = dom.textarea as HTMLTextAreaElement;
  if (textarea.value !== state.draft) {
    textarea.value = state.draft;
    autosize(textarea);
  }

  const mode = currentModeLabel();
  dom.modeLabel.textContent = mode;
  dom.modelLabel.textContent = currentModelLabel();

  const canSend = !state.chat.busy && state.chat.connection !== "error";
  (dom.send as HTMLButtonElement).disabled = !canSend && !state.chat.busy;
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return `<div class="markdown">${renderMarkdown(block.text)}</div>`;
        case "image":
          return `<img src="data:${escapeHtml(block.mimeType)};base64,${block.data}" alt="attachment" />`;
        case "resource":
          return `<div class="notice" data-severity="info"><span class="codicon codicon-link"></span><div><div class="notice-title">${escapeHtml(
            block.name,
          )}</div></div></div>`;
        default:
          return "";
      }
    })
    .join("");
}

function blocksToText(blocks: Block[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.type === "resource" ? block.name : "[image]"))
    .join("");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function currentModeLabel(): string {
  const modes = state.chat.modes;
  if (modes) {
    return modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name ?? "Chat";
  }
  // Agents that expose the mode as a configuration option still deserve a
  // readable label on the chip.
  const option = selectOption("mode");
  const label = option?.options?.find((choice) => choice.value === option.current)?.label;
  return label ?? "Chat";
}

function currentModelLabel(): string {
  const option = selectOption("model");
  const choice = option?.options?.find((entry) => entry.value === option.current);
  if (option?.current) {
    return modelName(option.current, choice?.label);
  }
  if (state.chat.model?.name) {
    return state.chat.model.name;
  }
  return "Model";
}

function typingDots(): string {
  return `<span class="typing"><span></span><span></span><span></span></span>`;
}

function icon(name: string): string {
  return `<span class="codicon codicon-${name}"></span>`;
}

function clipText(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) {
    return text;
  }
  return `${split.slice(0, lines).join("\n")}\n… ${split.length - lines} more lines`;
}

function needsExpand(text: string): boolean {
  return text.split("\n").length > state.chat.options.maxToolOutputLines;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function toggleSet(set: Set<string>, value: string): void {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
}

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function scrollToEnd(smooth: boolean): void {
  const transcript = dom.transcript;
  if (!transcript) {
    return;
  }
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function flashLabel(element: HTMLElement | undefined, text: string): void {
  if (!element) {
    return;
  }
  const original = element.innerHTML;
  element.textContent = text;
  window.setTimeout(() => {
    element.innerHTML = original;
  }, 1200);
}

function showToast(level: "info" | "warn" | "error", message: string): void {
  warn(level === "info" ? "info" : level, message);
  flashStatus(message);
}

/** Shows a transient hint in the status strip at the bottom of the panel. */
function flashStatus(message: string): void {
  const bar = dom.statusbar;
  if (!bar) {
    return;
  }
  const previous = bar.innerHTML;
  bar.innerHTML = `<span class="usage">${escapeHtml(message)}</span><span class="spacer"></span>`;
  window.setTimeout(() => {
    if (bar.innerHTML !== previous) {
      renderStatusBar();
    }
  }, 3200);
}

export type { SessionSummary, ToolCallContent };