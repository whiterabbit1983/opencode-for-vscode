import { diffLines, type DiffRow } from "./diff.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { modelLabel, modelName } from "../src/shared/model-name.js";
import type {
  Block,
  ChatItem,
  ChatState,
  ConfigOptionView,
  FormField,
  HostMessage,
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
}

const state: UiState = {
  chat: emptyState(),
  openTools: new Set(),
  planOpen: true,
  openThoughts: new Set(),
  menu: "none",
  draft: "",
  questionDrafts: {},
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
      <div class="composer-inner">
        <textarea rows="1" placeholder="Describe what to build…" spellcheck="true"></textarea>
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
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(textarea.value);
    }
  });

  root.addEventListener("click", (event) => onClick(event));
  root.addEventListener("submit", (event) => event.preventDefault());

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
          post({ type: "cancel" });
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
      case "suggestion":
        submit(actionEl.dataset.text ?? "");
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
    // The draft is kept so nothing is lost; the user can send it the moment
    // the current turn finishes.
    flashStatus("Still working — your message will send when OpenCode stops.");
    return;
  }
  if (state.chat.connection === "error") {
    flashStatus("OpenCode isn't connected. Restart the agent from the toolbar.");
    return;
  }
  state.draft = "";
  const textarea = dom.textarea as HTMLTextAreaElement;
  textarea.value = "";
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
}

function focusInput(): void {
  const textarea = dom.textarea as HTMLTextAreaElement;
  textarea?.focus();
}

function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function applyFontSize(): void {
  const size = state.chat.fonts?.size ?? 0;
  document.documentElement.style.setProperty("--oc-size", size > 0 ? `${size}px` : "13px");
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

function toggleMenu(kind: Exclude<UiState["menu"], "none">, event?: Event): void {
  state.menu = state.menu === kind ? "none" : kind;
  state.menuOpenedBy = state.menu === "none" ? undefined : event;
  renderMenu();
}

function closeMenu(): void {
  state.menu = "none";
  state.menuOpenedBy = undefined;
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
  menu.innerHTML = menuContent(state.menu);
  positionMenu();
}

function menuContent(kind: Exclude<UiState["menu"], "none">): string {
  if (kind === "model") {
    const options = selectOption("model");
    if (!options?.options?.length) {
      return `<div class="menu-label">Model</div><div class="menu-item" aria-disabled="true">Agent did not offer any models</div>`;
    }
    return `<div class="menu-label">Model</div>${renderChoices("model", options)}`;
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
      ? `OpenCode connected${session ? ` — session ${session.sessionId}` : ""}`
      : state.chat.connectionMessage ?? "OpenCode is not running";

  const send = dom.send;
  send.classList.toggle("stop", busy);
  send.innerHTML = busy
    ? `<span class="codicon codicon-debug-stop"></span>`
    : `<span class="codicon codicon-send"></span>`;
  send.title = busy ? "Stop generating" : "Send";
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

function renderTranscript(): void {
  const transcript = dom.transcript;
  const wasAtBottom = isAtBottom(transcript);

  const items = visibleItems();
  if (!items.length) {
    transcript.innerHTML = welcomeHtml();
    rendered.clear();
    return;
  }

  const seen = new Set<string>();
  let previous: HTMLElement | null = null;

  for (const item of items) {
    seen.add(item.id);
    const signature = itemSignature(item);
    const cached = rendered.get(item.id);

    let element: HTMLElement;
    if (cached && cached.signature === signature) {
      element = cached.element;
    } else {
      element = document.createElement("div");
      element.className = `item item-${item.kind}`;
      element.dataset.id = item.id;
      element.innerHTML = itemHtml(item);
      rendered.set(item.id, { signature, element });
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
}

function rerenderItem(itemElement: HTMLElement): void {
  const id = itemElement.dataset.id;
  if (!id) {
    return;
  }
  const item = state.chat.items.find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  itemElement.innerHTML = itemHtml(item);
  rendered.set(id, { signature: itemSignature(item), element: itemElement });
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

function itemSignature(item: ChatItem): string {
  switch (item.kind) {
    case "agent":
    case "thought":
    case "user":
      return JSON.stringify([item.kind, item.blocks, state.chat.options.showThoughts, state.openThoughts.has(item.id)]);
    case "tool":
      return JSON.stringify([
        item.call.status,
        item.call.title,
        item.call.content,
        item.call.locations,
        item.call.childSession,
        state.openTools.has(item.call.toolCallId),
        state.chat.options.maxToolOutputLines,
        state.chat.options.diffView,
      ]);
    case "permission":
      return JSON.stringify([item.request, item.resolved]);
    case "question":
      return JSON.stringify([item.question, item.resolved, state.questionDrafts[item.question.requestId] ?? {}]);
    default:
      return JSON.stringify(item);
  }
}

function itemHtml(item: ChatItem): string {
  switch (item.kind) {
    case "user":
      return `<div class="bubble-user">${renderBlocks(item.blocks)}</div>`;
    case "agent":
      return `${renderBlocks(item.blocks)}${item.streaming ? typingDots() : ""}`;
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

function toolHtml(call: ToolCall): string {
  const open = state.openTools.has(call.toolCallId);
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

  return `
    <div class="tool" data-status="${status}" data-open="${open}">
      <button class="tool-head" data-action="toggle-tool" data-id="${escapeHtml(call.toolCallId)}" aria-expanded="${open}">
        <span class="tool-icon codicon ${statusIcon}"></span>
        <span class="tool-title">${escapeHtml(call.title)}</span>
        ${
          call.childSession
            ? `<span class="tool-child">${escapeHtml(call.childSession.title ?? `subagent · depth ${call.childSession.depth}`)}</span>`
            : ""
        }
        ${open && body ? `<span class="tool-badge">${escapeHtml(call.name ?? call.kind ?? "")}</span>` : ""}
        <span class="tool-chevron codicon codicon-chevron-right"></span>
      </button>
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

  const buttons = request.options
    .map((option) => {
      const primary = option.kind === "allow_once" || option.kind === "reject_once";
      const danger = option.kind.startsWith("reject");
      const cls = danger ? "btn ghost" : primary ? "btn primary" : "btn";
      return `<button class="${cls}" data-action="permission" data-id="${escapeHtml(
        request.requestId,
      )}" data-option="${escapeHtml(option.optionId)}">${escapeHtml(option.name)}</button>`;
    })
    .join("");

  return `<div class="prompt">
    <div class="prompt-head">
      <span class="codicon codicon-shield"></span>
      <span>${escapeHtml(request.title)}</span>
    </div>
    <div class="prompt-body">
      ${request.warning ? `<div class="prompt-warning"><span class="codicon codicon-warning"></span><span>${escapeHtml(request.warning)}</span></div>` : ""}
      ${command ? `<div class="prompt-command">${escapeHtml(clipText(command.text, 20).trim())}</div>` : ""}
      ${diffs.map(diffHtml).join("")}
      <div class="prompt-actions">${buttons}</div>
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
  return `<div class="prompt">
    <div class="prompt-head">
      <span class="codicon codicon-question"></span>
      <span>${escapeHtml(question.message)}</span>
    </div>
    <div class="prompt-body">
      ${fields}
      <div class="prompt-actions">
        <button class="btn primary" data-action="question-accept" data-id="${escapeHtml(question.requestId)}">Submit</button>
        <button class="btn ghost" data-action="question-decline" data-id="${escapeHtml(question.requestId)}">Skip</button>
        <button class="btn ghost" data-action="question-cancel" data-id="${escapeHtml(question.requestId)}">Cancel</button>
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

function welcomeHtml(): string {
  const cwd = state.chat.cwd;
  const connection = state.chat.connection;
  const connecting = connection === "starting" || connection === "stopped";
  const failed = connection === "error";

  if (failed) {
    return `<div class="welcome">
      <h1>OpenCode isn't running</h1>
      <p>${escapeHtml(state.chat.connectionMessage ?? "The agent process is not responding.")}</p>
    </div>`;
  }

  return `<div class="welcome">
    <h1>${connecting ? "Starting OpenCode…" : "What should we build?"}</h1>
    <p>${
      connecting
        ? `Connecting to the agent${cwd ? ` in <code>${escapeHtml(basename(cwd))}</code>` : ""}.`
        : `Ask anything about <code>${escapeHtml(basename(cwd ?? "this folder"))}</code>. OpenCode reads and edits your files, so it asks before running anything.`
    }</p>
    ${
      connecting
        ? `<div class="typing"><span></span><span></span><span></span></div>`
        : `<div class="suggestions">
            <button class="suggestion" data-action="suggestion" data-text="Explain the structure of this project and how the main pieces fit together.">Explain how this project is organised</button>
            <button class="suggestion" data-action="suggestion" data-text="Find and fix the most obvious bug in this codebase.">Find a bug worth fixing</button>
            <button class="suggestion" data-action="suggestion" data-text="Add tests for the code I have open in the editor.">Add tests for the current file</button>
          </div>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Status bar & composer                                               */
/* ------------------------------------------------------------------ */

function renderStatusBar(): void {
  const { usage, retry, busy, cwd } = state.chat;
  const parts: string[] = [];

  if (retry) {
    parts.push(
      `<span class="retry"><span class="codicon codicon-loading codicon-modifier-spin"></span> Retrying (${escapeHtml(
        retry.error.message,
      )})</span>`,
    );
  }

  if (usage && usage.size > 0) {
    const ratio = Math.min(1, usage.used / usage.size);
    const level = ratio > 0.8 ? "high" : "";
    parts.push(
      `<span class="usage" title="${usage.used} of ${usage.size} tokens">${compactNumber(usage.used)} tokens
        <span class="context-meter ${level}"><span style="width:${Math.round(ratio * 100)}%"></span></span>
      </span>`,
    );
    if (usage.cost) {
      parts.push(`<span class="usage">$${usage.cost.amount.toFixed(3)}</span>`);
    }
  }

  if (state.chat.authInProgress) {
    parts.push(`<span class="usage">Waiting for sign-in…</span>`);
  }

  parts.push(`<span class="spacer"></span>`);
  if (cwd) {
    parts.push(`<span class="usage" title="${escapeHtml(cwd)}">${escapeHtml(basename(cwd))}</span>`);
  }
  if (busy) {
    parts.push(`<span class="usage">Working…</span>`);
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

function compactNumber(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
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