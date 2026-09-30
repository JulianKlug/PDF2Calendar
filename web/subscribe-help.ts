// Subscribe-help UI: floating info button + modal explaining how to subscribe
// to a feed URL in Google Calendar and Apple Calendar (macOS, iOS).
//
// Same factory style as admin-auth.ts: builds elements, wires its own
// listeners; the caller (web/main.ts) mounts the button once at boot.
//
//   ┌──────────── viewport ────────────┐
//   │                                  │
//   │                             (i) ─┼─ click → modal-backdrop (body)
//   └──────────────────────────────────┘

type HelpSection = { title: string; tip?: string; steps: string[] };

// Steps start from the "Copy URL" button every person row offers.
const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Google Calendar",
    tip: "Quickest: “Open in Google Calendar” next to your name → Add. Otherwise:",
    steps: [
      "Copy URL.",
      "On a computer, open calendar.google.com (the mobile app can't add feeds).",
      "Other calendars → “+” → From URL → paste → Add calendar.",
      "It appears on your phone automatically. Google refreshes every few hours.",
    ],
  },
  {
    title: "Apple Calendar — Mac",
    steps: [
      "Copy URL.",
      "Open Calendar → File → New Calendar Subscription…",
      "Paste → Subscribe.",
      "Set Location to iCloud (syncs to iPhone) and Auto-refresh to Every hour → OK.",
    ],
  },
  {
    title: "Apple Calendar — iPhone / iPad",
    steps: [
      "Copy URL.",
      "Settings → Apps → Calendar → Calendar Accounts (iOS 17 and older: Settings → Calendar → Accounts).",
      "Add Account → Other → Add Subscribed Calendar.",
      "Paste → Next → Save.",
    ],
  },
];

const HEADING_ID = "subscribe-help-heading";

export function renderSubscribeHelpButton(): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-fab";
  btn.setAttribute("aria-label", "How to subscribe to a calendar");
  btn.textContent = "i";
  btn.addEventListener("click", () => openSubscribeHelp(btn));
  return btn;
}

function openSubscribeHelp(opener: HTMLElement): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", HEADING_ID);

  const card = document.createElement("div");
  card.className = "modal-card help-card";
  backdrop.appendChild(card);

  const heading = document.createElement("h2");
  heading.id = HEADING_ID;
  heading.textContent = "Subscribe to your calendar";
  card.appendChild(heading);

  const intro = document.createElement("p");
  intro.className = "modal-body";
  intro.textContent =
    "Subscribe once; new plans show up automatically. Use “Copy URL” next to your name.";
  card.appendChild(intro);

  for (const section of HELP_SECTIONS) {
    card.appendChild(renderSection(section));
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  card.appendChild(actions);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-primary";
  closeBtn.textContent = "Close";
  actions.appendChild(closeBtn);

  // Close on button, backdrop click, or Escape; restore focus to the opener.
  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    opener.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(backdrop);
  closeBtn.focus();
}

function renderSection(section: HelpSection): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "help-section";

  const title = document.createElement("h3");
  title.textContent = section.title;
  wrap.appendChild(title);

  if (section.tip) {
    const tip = document.createElement("p");
    tip.textContent = section.tip;
    wrap.appendChild(tip);
  }

  const list = document.createElement("ol");
  for (const step of section.steps) {
    const li = document.createElement("li");
    li.textContent = step;
    list.appendChild(li);
  }
  wrap.appendChild(list);

  return wrap;
}
