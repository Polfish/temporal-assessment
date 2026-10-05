import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  CandidateState,
  OfferReply,
  OfferReplyResult,
  OpeningInput,
  OpeningPhase,
  OpeningStatus,
  SmsKind,
} from "./types";

const { sendSms } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

// ---- Messages the outside world can send to one opening ----------------------

/** A client's (or staff-recorded) yes/no. An Update so a late reply gets an answer back. */
export const respondToOffer = defineUpdate<OfferReplyResult, [OfferReply]>("respondToOffer");
/** Staff: give up on whoever holds the offer and move to the next person. */
export const skipCurrentOffer = defineSignal("skipCurrentOffer");
/** Staff: the opening no longer exists (Square refilled it, stylist is out, etc). */
export const cancelOpening = defineSignal("cancelOpening");
/** Staff: the client who accepted changed their mind; offer the chair to the next person. */
export const releaseAcceptedClient = defineSignal("releaseAcceptedClient");
/** Staff: the accepted client is now booked in Square; the process is finished. */
export const markBookedInSquare = defineSignal("markBookedInSquare");
/** Dashboard: the full picture of this opening. */
export const getOpeningStatus = defineQuery<OpeningStatus>("getOpeningStatus");

// ---- Text templates -----------------------------------------------------------

const texts = {
  offer: (name: string, service: string, stylist: string, when: string, minutes: number) =>
    `Hi ${name}, this is Juniper Salon. A ${service} with ${stylist} just opened on ${when}. ` +
    `Reply YES to take it or NO to pass. We'll hold it for you for ${minutes} minutes.`,
  confirmation: (service: string, stylist: string, when: string) =>
    `You're booked! ${service} with ${stylist}, ${when}. See you at Juniper Salon.`,
  withdrawn: (name: string, when: string) =>
    `Hi ${name}, the ${when} opening at Juniper Salon is no longer available. You're still on our waitlist.`,
  tooLate: () =>
    `Sorry, that opening has already been taken. You're still on our waitlist for the next one.`,
};

// ---- The Workflow -------------------------------------------------------------

/**
 * One execution per opening. Offers the chair to one matching client at a time,
 * waits a bounded window for an answer, and never lets two people hold the same
 * offer. Stops the moment staff cancel or the appointment time arrives.
 */
export async function fillOpeningWorkflow(input: OpeningInput): Promise<OpeningStatus> {
  const now = (): string => new Date().toISOString();

  const state: OpeningStatus = {
    openingId: input.openingId,
    service: input.service,
    stylist: input.stylist,
    startsAt: input.startsAt,
    startsAtLabel: input.startsAtLabel,
    offerWindowMinutes: input.offerWindowMinutes,
    phase: "searching",
    summary: "Starting the search.",
    candidates: input.candidates.map((candidate) => ({ ...candidate, outcome: "queued" })),
    bookedInSquare: false,
    messages: [],
    updatedAt: now(),
  };

  let pendingReply: OfferReply | undefined;
  let skipRequested = false;
  let cancelRequested = false;
  let releaseRequested = false;
  let bookedRequested = false;

  function touch(summary: string): void {
    state.summary = summary;
    state.updatedAt = now();
  }

  async function text(candidate: CandidateState, kind: SmsKind, body: string): Promise<void> {
    await sendSms({ to: candidate.phone, body });
    state.messages.push({
      id: state.messages.length + 1,
      clientId: candidate.clientId,
      toName: candidate.name,
      to: candidate.phone,
      kind,
      body,
      sentAt: now(),
    });
  }

  function finish(phase: OpeningPhase, summary: string): void {
    for (const candidate of state.candidates) {
      if (candidate.outcome === "queued") candidate.outcome = "not_reached";
    }
    state.currentOffer = undefined;
    state.phase = phase;
    touch(summary);
  }

  setHandler(getOpeningStatus, () => state);
  setHandler(skipCurrentOffer, () => {
    skipRequested = true;
  });
  setHandler(cancelOpening, () => {
    cancelRequested = true;
  });
  setHandler(releaseAcceptedClient, () => {
    releaseRequested = true;
  });
  setHandler(markBookedInSquare, () => {
    bookedRequested = true;
  });

  setHandler(respondToOffer, async (reply): Promise<OfferReplyResult> => {
    const candidate = state.candidates.find((c) => c.clientId === reply.clientId);
    if (!candidate) {
      return { accepted: false, outcome: "ignored", message: "Unknown client for this opening." };
    }
    const holdsOffer =
      state.phase === "searching" &&
      state.currentOffer?.clientId === reply.clientId &&
      pendingReply === undefined;

    if (holdsOffer) {
      pendingReply = reply;
      candidate.respondedAt = now();
      candidate.respondedBy = reply.actor;
      return reply.answer === "yes"
        ? { accepted: true, outcome: "accepted", message: `${candidate.name} accepted the opening.` }
        : { accepted: false, outcome: "declined", message: `${candidate.name} passed on the opening.` };
    }

    // Not their turn. A "yes" from someone whose window closed (or after the chair
    // was filled) is exactly how double bookings happened before; answer it politely.
    if (reply.answer === "yes" && candidate.outcome !== "queued") {
      await text(candidate, "too_late", texts.tooLate());
      return {
        accepted: false,
        outcome: "too_late",
        message: `${candidate.name} replied too late and was told the opening is taken.`,
      };
    }
    return {
      accepted: false,
      outcome: "ignored",
      message: `${candidate.name} does not hold the current offer; nothing changed.`,
    };
  });

  const startsAtMs = Date.parse(input.startsAt);

  search: while (true) {
    if (cancelRequested) {
      finish("cancelled", "Cancelled by staff before anyone was offered the chair.");
      break;
    }
    const msUntilStart = startsAtMs - Date.now();
    if (msUntilStart <= 0) {
      finish("expired", "The appointment time arrived before the chair was filled.");
      break;
    }
    const next = state.candidates.find((c) => c.outcome === "queued");
    if (!next) {
      finish("unfilled", "Everyone on the waitlist was tried. The chair is still open.");
      break;
    }

    // Never let an offer outlive the opening itself.
    const windowMs = Math.min(input.offerWindowMinutes * 60_000, msUntilStart);
    const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));
    next.outcome = "offered";
    next.offeredAt = now();
    state.currentOffer = {
      clientId: next.clientId,
      name: next.name,
      offeredAt: next.offeredAt,
      expiresAt: new Date(Date.now() + windowMs).toISOString(),
    };
    pendingReply = undefined;
    skipRequested = false;
    touch(`Offered to ${next.name}. Waiting up to ${windowMinutes} min for a reply.`);
    await text(
      next,
      "offer",
      texts.offer(next.name, input.service, input.stylist, input.startsAtLabel, windowMinutes),
    );

    const answered = await condition(
      () => pendingReply !== undefined || skipRequested || cancelRequested,
      windowMs,
    );

    if (cancelRequested) {
      next.outcome = "released";
      await text(next, "withdrawn", texts.withdrawn(next.name, input.startsAtLabel));
      finish("cancelled", `Cancelled by staff while ${next.name} held the offer.`);
      break;
    }
    if (!answered) {
      next.outcome = "timed_out";
      touch(`${next.name} did not reply in time. Moving on.`);
      continue;
    }
    if (skipRequested) {
      next.outcome = "skipped";
      touch(`Staff skipped ${next.name}. Moving on.`);
      continue;
    }
    if ((pendingReply as OfferReply | undefined)?.answer === "no") {
      next.outcome = "declined";
      touch(`${next.name} passed. Moving on.`);
      continue;
    }

    // Accepted. Hold the chair until it is booked in Square, released, or the time arrives.
    next.outcome = "accepted";
    state.acceptedClientId = next.clientId;
    state.currentOffer = undefined;
    state.phase = "filled";
    touch(`${next.name} accepted. Book them in Square to finish.`);
    await text(next, "confirmation", texts.confirmation(input.service, input.stylist, input.startsAtLabel));

    releaseRequested = false;
    const holdMs = Math.max(1, startsAtMs - Date.now());
    await condition(() => releaseRequested || bookedRequested || cancelRequested, holdMs);

    if (bookedRequested) {
      state.bookedInSquare = true;
      finish("filled", `${next.name} is booked in Square. Done.`);
      break;
    }
    if (cancelRequested) {
      next.outcome = "released";
      state.acceptedClientId = undefined;
      await text(next, "withdrawn", texts.withdrawn(next.name, input.startsAtLabel));
      finish("cancelled", `Cancelled by staff after ${next.name} had accepted.`);
      break;
    }
    if (releaseRequested) {
      next.outcome = "released";
      state.acceptedClientId = undefined;
      state.phase = "searching";
      await text(next, "withdrawn", texts.withdrawn(next.name, input.startsAtLabel));
      touch(`${next.name} released the chair. Offering it to the next person.`);
      continue search;
    }
    finish("filled", `${next.name} accepted and the appointment time has arrived.`);
    break;
  }

  // Let any in-flight reply Update finish (it may be texting a late replier).
  await condition(allHandlersFinished);
  return state;
}
