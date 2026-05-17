// Admin-auth UI: password modal + InvalidAdminPassword error copy. This module
// is intentionally narrow so the OAuth migration is a clean delete (paired
// with src/admin-auth.ts). See docs/v2-spec.md § Frontend changes / API
// client.
//
// The modal is a pure factory — it builds an HTMLElement, wires its own
// listeners, and calls onSubmit / onCancel. The caller (web/main.ts) decides
// where to mount and unmount it.

export type PasswordModalOpts = {
  // Called with a non-empty password. Empty submissions are rejected
  // modal-locally — see spec § Upload flow step 2 ("Empty-string submission
  // is rejected client-side").
  onSubmit: (password: string) => void;
  onCancel: () => void;
  // Optional inline error to show above the field (e.g., on a Retry after a
  // wrong-password 401). The field starts empty regardless.
  initialError?: string | null;
};

export function renderPasswordModal(opts: PasswordModalOpts): HTMLElement {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "admin-pw-heading");

  const card = document.createElement("div");
  card.className = "modal-card";
  backdrop.appendChild(card);

  const heading = document.createElement("h2");
  heading.id = "admin-pw-heading";
  heading.textContent = "Admin password required";
  card.appendChild(heading);

  const body = document.createElement("p");
  body.className = "modal-body";
  body.textContent = "Enter the admin password to upload a new plan.";
  card.appendChild(body);

  let errorEl: HTMLElement | null = null;
  function setError(msg: string | null) {
    if (msg) {
      if (!errorEl) {
        errorEl = document.createElement("div");
        errorEl.className = "modal-error";
        errorEl.setAttribute("role", "alert");
        card.insertBefore(errorEl, form);
      }
      errorEl.textContent = msg;
    } else if (errorEl) {
      errorEl.remove();
      errorEl = null;
    }
  }

  const form = document.createElement("form");
  form.className = "modal-form";
  card.appendChild(form);

  const label = document.createElement("label");
  label.className = "modal-label";
  label.htmlFor = "admin-password";
  label.textContent = "Password";
  form.appendChild(label);

  const input = document.createElement("input");
  input.id = "admin-password";
  input.type = "password";
  input.autocomplete = "current-password";
  input.className = "modal-input";
  input.required = true;
  form.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  form.appendChild(actions);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-quiet";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => opts.onCancel());
  actions.appendChild(cancel);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-primary";
  submit.textContent = "Submit";
  actions.appendChild(submit);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value;
    if (value.length === 0) {
      setError("Please enter the admin password.");
      return;
    }
    setError(null);
    opts.onSubmit(value);
  });

  // Initial error (e.g., "Wrong admin password — try again") is inserted
  // before the form; the input remains empty per spec § Upload flow step 6.
  if (opts.initialError) setError(opts.initialError);

  // Focus the input once mounted. Caller appends the backdrop to document.body
  // before reading focus — use a microtask so DOM is settled.
  queueMicrotask(() => input.focus());

  return backdrop;
}

// Copy for the invalid_admin_password ErrorCause. Used by the error screen
// to surface a clear "Wrong admin password" message + Retry button.
export const INVALID_ADMIN_PASSWORD_COPY = {
  detail: "Wrong admin password.",
  action: "Re-enter the password and try again.",
};
