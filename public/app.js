// Front-desk dashboard for Juniper Salon. Plain browser JS, polls the API once a second.

const $ = (selector) => document.querySelector(selector);

const state = {
  reference: null, // { stylists, services, waitlist }
  openings: [], // OpeningStatus[] from Temporal, newest first
  selectedId: null,
  selected: null, // OpeningStatus
  phoneClientId: null, // which client's phone is showing
  phonePinned: false, // true once the user picked a phone manually
};

// ---- helpers --------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const whenFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function clock(iso) {
  return iso ? timeFormat.format(new Date(iso)) : "";
}

function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "0:00";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

const phaseLabel = {
  searching: "Searching",
  filled: "Filled",
  unfilled: "Unfilled",
  cancelled: "Cancelled",
  expired: "Expired",
};

const outcomeLabel = {
  queued: "Up next",
  offered: "Holds the offer",
  accepted: "Accepted",
  declined: "Said no",
  timed_out: "No reply in time",
  skipped: "Skipped by staff",
  released: "Offer withdrawn",
  not_reached: "Not contacted",
};

function badge(kind, text) {
  return `<span class="badge badge-${kind}">${escapeHtml(text)}</span>`;
}

// ---- reference data and the new-opening form -----------------------------------------

function fillSelect(select, items, label) {
  select.innerHTML = items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(label(item))}</option>`).join("");
}

async function loadReference() {
  state.reference = await api("/api/reference");
  fillSelect($("#service"), state.reference.services, (s) => `${s.name} (${s.durationMinutes} min)`);
  fillSelect($("#stylist"), state.reference.stylists, (s) => s.name);

  // Default the opening to two hours from now, rounded to the next quarter hour.
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("#starts-at").value = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;

  renderWaitlist();
  await previewCandidates();
}

function renderWaitlist() {
  const rows = state.reference.waitlist
    .map(
      (c) => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong><br /><span class="muted">${escapeHtml(c.phone)}</span></td>
        <td>${escapeHtml(c.serviceName)}</td>
        <td>${c.stylistRequirement === "any" ? "Any stylist" : `${escapeHtml(c.stylistName)} <span class="muted">${escapeHtml(c.stylistRequirement)}</span>`}</td>
        <td class="muted">${escapeHtml(c.availability)}</td>
      </tr>`,
    )
    .join("");
  $("#waitlist").innerHTML = `
    <thead><tr><th>Client</th><th>Wants</th><th>Stylist</th><th>Availability</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

async function previewCandidates() {
  const serviceId = $("#service").value;
  const stylistId = $("#stylist").value;
  const { candidates } = await api(`/api/candidates?serviceId=${encodeURIComponent(serviceId)}&stylistId=${encodeURIComponent(stylistId)}`);
  const preview = $("#candidate-preview");
  if (candidates.length === 0) {
    preview.innerHTML = `<p class="muted">Nobody on the waitlist matches this service and stylist.</p>`;
    return;
  }
  preview.innerHTML = `
    <p class="muted">Will be offered to, in order:</p>
    <ol>${candidates.map((c) => `<li><strong>${escapeHtml(c.name)}</strong> <span class="muted">${escapeHtml(c.matchNote)}</span></li>`).join("")}</ol>`;
}

$("#service").addEventListener("change", () => previewCandidates().catch(console.error));
$("#stylist").addEventListener("change", () => previewCandidates().catch(console.error));

$("#opening-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#form-error");
  error.textContent = "";
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const startsAt = new Date($("#starts-at").value).toISOString();
    const window = $("#offer-window").value;
    const { openingId } = await api("/api/openings", {
      method: "POST",
      body: { serviceId: $("#service").value, stylistId: $("#stylist").value, startsAt, offerWindowMinutes: window === "" ? undefined : Number(window) },
    });
    select(openingId);
    await refresh();
  } catch (e) {
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

// ---- polling -----------------------------------------------------------------------

function select(openingId) {
  state.selectedId = openingId;
  state.phonePinned = false;
  state.phoneClientId = null;
  $("#phone-result").textContent = "";
}

async function refresh() {
  const [list, selected] = await Promise.all([
    api("/api/openings").then((b) => b.openings),
    state.selectedId ? api(`/api/openings/${state.selectedId}`).catch(() => null) : Promise.resolve(null),
  ]);
  state.openings = list;
  // A brand-new opening can take a second to show up in Temporal's list; keep it visible meanwhile.
  if (selected && !list.some((o) => o.openingId === selected.openingId)) state.openings = [selected, ...list];
  state.selected = selected;
  if (!state.phonePinned && selected) {
    state.phoneClientId = selected.currentOffer?.clientId ?? selected.acceptedClientId ?? state.phoneClientId ?? selected.candidates[0]?.clientId ?? null;
  }
  render();
}

// ---- rendering ----------------------------------------------------------------------

function render() {
  renderOpenings();
  renderDetail();
  renderPhone();
}

function renderOpenings() {
  const list = $("#openings");
  if (state.openings.length === 0) {
    list.innerHTML = `<li class="muted">No openings yet.</li>`;
    return;
  }
  list.innerHTML = state.openings
    .map(
      (o) => `
      <li>
        <button class="opening-row ${o.openingId === state.selectedId ? "selected" : ""}" data-id="${escapeHtml(o.openingId)}">
          <span class="opening-title">${escapeHtml(o.service)} with ${escapeHtml(o.stylist)}</span>
          <span class="muted">${escapeHtml(o.startsAtLabel)}</span>
          ${badge(o.phase, phaseLabel[o.phase] ?? o.phase)}
        </button>
      </li>`,
    )
    .join("");
  list.querySelectorAll(".opening-row").forEach((button) =>
    button.addEventListener("click", () => {
      select(button.dataset.id);
      refresh().catch(console.error);
    }),
  );
}

function renderDetail() {
  const o = state.selected;
  const detail = $("#detail");
  if (!o) {
    if (state.selectedId) {
      detail.innerHTML = `<div class="card empty-state"><h2>Starting…</h2><p class="muted">Temporal has the opening and a Worker is picking it up.</p></div>`;
    }
    return;
  }

  const offer = o.currentOffer;
  const accepted = o.candidates.find((c) => c.clientId === o.acceptedClientId);
  const terminal = ["unfilled", "cancelled", "expired"].includes(o.phase) || (o.phase === "filled" && o.bookedInSquare);

  const controls = terminal
    ? `<p class="muted">This opening is finished. Nothing more will be sent.</p>`
    : o.phase === "searching"
      ? `
        <button data-action="reply-yes-staff" class="primary" ${offer ? "" : "disabled"}>Record YES for ${escapeHtml(offer?.name ?? "…")}</button>
        <button data-action="reply-no-staff" ${offer ? "" : "disabled"}>Record NO</button>
        <button data-action="skip" ${offer ? "" : "disabled"}>Skip ${escapeHtml(offer?.name ?? "")}</button>
        <button data-action="cancel" class="danger">Cancel opening</button>`
      : `
        <button data-action="booked" class="primary">Mark booked in Square</button>
        <button data-action="release">${escapeHtml(accepted?.name ?? "Client")} changed their mind</button>
        <button data-action="cancel" class="danger">Cancel opening</button>`;

  const offerPanel =
    o.phase === "searching" && offer
      ? `
        <div class="offer-panel">
          <div>
            <p class="eyebrow">Holds the offer</p>
            <h3>${escapeHtml(offer.name)}</h3>
            <p class="muted">Texted at ${clock(offer.offeredAt)} · window closes at ${clock(offer.expiresAt)}</p>
          </div>
          <div class="countdown" data-expires="${escapeHtml(offer.expiresAt)}">${countdown(offer.expiresAt)}</div>
        </div>`
      : o.phase === "filled"
        ? `
        <div class="offer-panel filled">
          <div>
            <p class="eyebrow">Chair filled</p>
            <h3>${escapeHtml(accepted?.name ?? "")}</h3>
            <p class="muted">${o.bookedInSquare ? "Booked in Square." : "Confirmation sent. Book them in Square to finish."}</p>
          </div>
        </div>`
        : "";

  const rows = o.candidates
    .map(
      (c, i) => `
      <tr class="outcome-${c.outcome}">
        <td class="muted">${i + 1}</td>
        <td><strong>${escapeHtml(c.name)}</strong><br /><span class="muted">${escapeHtml(c.matchNote)}</span></td>
        <td>${badge(c.outcome, outcomeLabel[c.outcome] ?? c.outcome)}</td>
        <td class="muted">${c.offeredAt ? `texted ${clock(c.offeredAt)}` : ""}${c.respondedAt ? `<br />replied ${clock(c.respondedAt)}${c.respondedBy === "staff" ? " (by staff)" : ""}` : ""}</td>
      </tr>`,
    )
    .join("");

  const log = o.messages.length
    ? o.messages
        .slice()
        .reverse()
        .map((m) => `<li><span class="muted">${clock(m.sentAt)} · to ${escapeHtml(m.toName)} (${escapeHtml(m.to)})</span><br />${escapeHtml(m.body)}</li>`)
        .join("")
    : `<li class="muted">No texts sent yet.</li>`;

  detail.innerHTML = `
    <div class="card">
      <div class="detail-head">
        <div>
          <p class="eyebrow">${escapeHtml(o.openingId)}</p>
          <h2>${escapeHtml(o.service)} with ${escapeHtml(o.stylist)}</h2>
          <p class="muted">${escapeHtml(o.startsAtLabel)} · ${o.offerWindowMinutes} min per offer</p>
        </div>
        ${badge(o.phase, phaseLabel[o.phase] ?? o.phase)}
      </div>
      <p class="summary">${escapeHtml(o.summary)}</p>
      ${offerPanel}
      <div class="controls">${controls}</div>
      <p id="action-result" class="muted"></p>
    </div>

    <div class="card">
      <h2>Who gets offered the chair</h2>
      <table class="candidates">
        <thead><tr><th>#</th><th>Client</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">Nobody on the waitlist matched.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Texts sent <span class="tag">simulated</span></h2>
      <ul class="log">${log}</ul>
    </div>`;

  detail.querySelectorAll("button[data-action]").forEach((button) =>
    button.addEventListener("click", () => staffAction(button.dataset.action, button).catch(console.error)),
  );
}

async function staffAction(action, button) {
  const o = state.selected;
  const result = $("#action-result");
  button.disabled = true;
  try {
    if (action === "reply-yes-staff" || action === "reply-no-staff") {
      const reply = await api(`/api/openings/${o.openingId}/reply`, {
        method: "POST",
        body: { clientId: o.currentOffer.clientId, answer: action === "reply-yes-staff" ? "yes" : "no", actor: "staff" },
      });
      result.textContent = reply.message;
    } else {
      await api(`/api/openings/${o.openingId}/${action}`, { method: "POST" });
      result.textContent = { skip: "Skipping…", cancel: "Cancelling…", release: "Releasing the chair…", booked: "Marking as booked…" }[action];
    }
    await refresh();
  } catch (e) {
    result.textContent = e.message;
    button.disabled = false;
  }
}

function renderPhone() {
  const o = state.selected;
  const picker = $("#phone-client");
  const screen = $("#phone-screen");
  const yes = $("#reply-yes");
  const no = $("#reply-no");

  if (!o) {
    picker.innerHTML = `<option>Select an opening first</option>`;
    picker.disabled = true;
    screen.innerHTML = `<p class="muted">No messages yet.</p>`;
    yes.disabled = no.disabled = true;
    return;
  }

  picker.disabled = false;
  picker.innerHTML = o.candidates
    .map((c) => `<option value="${escapeHtml(c.clientId)}" ${c.clientId === state.phoneClientId ? "selected" : ""}>${escapeHtml(c.name)} · ${escapeHtml(c.phone)}${c.clientId === o.currentOffer?.clientId ? " (holds the offer)" : ""}</option>`)
    .join("");

  const messages = o.messages.filter((m) => m.clientId === state.phoneClientId);
  screen.innerHTML = messages.length
    ? messages.map((m) => `<div class="bubble bubble-${m.kind}"><p>${escapeHtml(m.body)}</p><span class="muted">${clock(m.sentAt)}</span></div>`).join("")
    : `<p class="muted">No texts to this client yet.</p>`;
  screen.scrollTop = screen.scrollHeight;

  const client = o.candidates.find((c) => c.clientId === state.phoneClientId);
  const canReply = Boolean(client) && !["unfilled", "cancelled", "expired"].includes(o.phase) && !(o.phase === "filled" && o.bookedInSquare);
  yes.disabled = no.disabled = !canReply;
}

$("#phone-client").addEventListener("change", (event) => {
  state.phoneClientId = event.target.value;
  state.phonePinned = true;
  renderPhone();
});

async function clientReply(answer) {
  const o = state.selected;
  const result = $("#phone-result");
  result.textContent = "Sending…";
  try {
    const reply = await api(`/api/openings/${o.openingId}/reply`, {
      method: "POST",
      body: { clientId: state.phoneClientId, answer, actor: "client" },
    });
    result.textContent = reply.message;
    await refresh();
  } catch (e) {
    result.textContent = e.message;
  }
}

$("#reply-yes").addEventListener("click", () => clientReply("yes"));
$("#reply-no").addEventListener("click", () => clientReply("no"));

// Keep the countdown ticking between polls.
setInterval(() => {
  document.querySelectorAll(".countdown[data-expires]").forEach((el) => {
    el.textContent = countdown(el.dataset.expires);
  });
}, 250);

// ---- boot -----------------------------------------------------------------------

loadReference()
  .then(refresh)
  .catch((e) => {
    $("#form-error").textContent = `Could not reach the API: ${e.message}`;
  });
setInterval(() => refresh().catch(console.error), 1000);
