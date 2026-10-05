// Shared domain types for the Juniper Salon "fill an opening" prototype.

export type Stylist = { id: string; name: string };

export type Service = { id: string; name: string; durationMinutes: number };

/** How strongly a waitlisted client cares about who does their hair. */
export type StylistRequirement = "required" | "preferred" | "any";

/** One row of Lena's Google Sheet waitlist (seeded in memory for the prototype). */
export type WaitlistClient = {
  id: string;
  name: string;
  phone: string;
  serviceId: string;
  stylistId?: string;
  stylistRequirement: StylistRequirement;
  availability: string;
  signedUpAt: string; // ISO date
};

/** A waitlisted client who matches an opening, in the order they should be offered it. */
export type Candidate = {
  clientId: string;
  name: string;
  phone: string;
  matchNote: string;
};

export type CandidateOutcome =
  | "queued"
  | "offered"
  | "accepted"
  | "declined"
  | "timed_out"
  | "skipped"
  | "released"
  | "not_reached";

export type CandidateState = Candidate & {
  outcome: CandidateOutcome;
  offeredAt?: string;
  respondedAt?: string;
  respondedBy?: "client" | "staff";
};

/** Everything the Workflow needs to run one opening. Computed by the API before start. */
export type OpeningInput = {
  openingId: string;
  service: string;
  stylist: string;
  startsAt: string; // ISO timestamp
  startsAtLabel: string; // human label, formatted by the API so the Workflow stays deterministic
  offerWindowMinutes: number;
  candidates: Candidate[];
};

export type OpeningPhase = "searching" | "filled" | "unfilled" | "cancelled" | "expired";

export type SmsKind = "offer" | "confirmation" | "withdrawn" | "too_late";

export type SmsMessage = {
  id: number;
  clientId: string;
  toName: string;
  to: string;
  kind: SmsKind;
  body: string;
  sentAt: string;
};

export type CurrentOffer = {
  clientId: string;
  name: string;
  offeredAt: string;
  expiresAt: string;
};

/** What the dashboard sees. Returned by the status Query and as the Workflow result. */
export type OpeningStatus = {
  openingId: string;
  service: string;
  stylist: string;
  startsAt: string;
  startsAtLabel: string;
  offerWindowMinutes: number;
  phase: OpeningPhase;
  summary: string;
  candidates: CandidateState[];
  currentOffer?: CurrentOffer;
  acceptedClientId?: string;
  bookedInSquare: boolean;
  messages: SmsMessage[];
  updatedAt: string;
};

/** A reply to an offer, from the client's phone or recorded by staff on their behalf. */
export type OfferReply = {
  clientId: string;
  answer: "yes" | "no";
  actor: "client" | "staff";
};

export type OfferReplyResult = {
  accepted: boolean;
  outcome: "accepted" | "declined" | "too_late" | "ignored";
  message: string;
};
