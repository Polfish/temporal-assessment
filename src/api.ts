import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { TASK_QUEUE } from "./config";
import { rankCandidates, services, stylists, waitlist } from "./data";
import type { OfferReply, OfferReplyResult, OpeningInput, OpeningStatus } from "./types";
import {
  cancelOpening,
  fillOpeningWorkflow,
  getOpeningStatus,
  markBookedInSquare,
  releaseAcceptedClient,
  respondToOffer,
  skipCurrentOffer,
} from "./workflows";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- Reference data (stands in for Square's catalogue and Lena's Google Sheet) ----

app.get("/api/reference", (_request, response) => {
  response.json({
    stylists,
    services,
    waitlist: waitlist.map((client) => ({
      ...client,
      stylistName: stylists.find((s) => s.id === client.stylistId)?.name,
      serviceName: services.find((s) => s.id === client.serviceId)?.name,
    })),
  });
});

/** Who would be contacted, in order, for this service and stylist. */
app.get("/api/candidates", (request, response) => {
  const serviceId = String(request.query.serviceId ?? "");
  const stylistId = String(request.query.stylistId ?? "");
  response.json({ candidates: rankCandidates(serviceId, stylistId) });
});

// ---- Openings: one Workflow each --------------------------------------------------

const dateLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function defaultOfferWindowMinutes(startsAt: Date): number {
  // Lena: about 15 minutes for a same-day opening, longer for later ones.
  const sameDay = startsAt.toDateString() === new Date().toDateString();
  return sameDay ? 15 : 60;
}

app.post("/api/openings", async (request, response) => {
  const { serviceId, stylistId, startsAt, offerWindowMinutes } = request.body ?? {};
  const service = services.find((s) => s.id === serviceId);
  const stylist = stylists.find((s) => s.id === stylistId);
  const start = new Date(String(startsAt));
  if (!service || !stylist) throw new HttpError(400, "Pick a service and a stylist.");
  if (Number.isNaN(start.getTime())) throw new HttpError(400, "Pick a valid start time.");
  if (start.getTime() <= Date.now()) throw new HttpError(400, "The opening must be in the future.");

  const windowMinutes =
    offerWindowMinutes === undefined || offerWindowMinutes === null || offerWindowMinutes === ""
      ? defaultOfferWindowMinutes(start)
      : Number(offerWindowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new HttpError(400, "The offer window must be a positive number of minutes.");
  }

  const openingId = `opening-${randomUUID().slice(0, 8)}`;
  const input: OpeningInput = {
    openingId,
    service: service.name,
    stylist: stylist.name,
    startsAt: start.toISOString(),
    startsAtLabel: dateLabel.format(start),
    offerWindowMinutes: windowMinutes,
    candidates: rankCandidates(service.id, stylist.id),
  };

  const client = await getClient();
  // The Workflow ID is the opening ID, so the same opening can never run twice at once.
  await client.workflow.start(fillOpeningWorkflow, {
    workflowId: openingId,
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdConflictPolicy: "FAIL",
  });
  response.status(201).json({ openingId });
});

async function readStatus(client: Client, openingId: string): Promise<OpeningStatus> {
  return client.workflow.getHandle(openingId).query(getOpeningStatus);
}

/** Temporal is the source of truth: list executions, then ask each one for its status. */
app.get("/api/openings", async (_request, response) => {
  const client = await getClient();
  const executions = [];
  for await (const execution of client.workflow.list({
    query: `WorkflowType = 'fillOpeningWorkflow'`,
  })) {
    executions.push(execution);
    if (executions.length >= 30) break;
  }
  executions.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  const statuses = await Promise.all(
    executions.map((execution) => readStatus(client, execution.workflowId).catch(() => undefined)),
  );
  response.json({ openings: statuses.filter((status): status is OpeningStatus => status !== undefined) });
});

app.get("/api/openings/:openingId", async (request, response) => {
  const client = await getClient();
  response.json(await readStatus(client, request.params.openingId));
});

/** A yes/no from the client's phone, or recorded by staff on their behalf. */
app.post("/api/openings/:openingId/reply", async (request, response) => {
  const { clientId, answer, actor } = request.body ?? {};
  if (typeof clientId !== "string" || (answer !== "yes" && answer !== "no")) {
    throw new HttpError(400, "A reply needs a clientId and an answer of yes or no.");
  }
  const reply: OfferReply = { clientId, answer, actor: actor === "staff" ? "staff" : "client" };
  const client = await getClient();
  const result: OfferReplyResult = await client.workflow
    .getHandle(request.params.openingId)
    .executeUpdate(respondToOffer, { args: [reply] });
  response.json(result);
});

const staffSignals = {
  skip: skipCurrentOffer,
  cancel: cancelOpening,
  release: releaseAcceptedClient,
  booked: markBookedInSquare,
} as const;

app.post("/api/openings/:openingId/:action", async (request, response) => {
  const action = request.params.action as keyof typeof staffSignals;
  const signal = staffSignals[action];
  if (!signal) throw new HttpError(404, `Unknown action "${request.params.action}".`);
  const client = await getClient();
  await client.workflow.getHandle(request.params.openingId).signal(signal);
  response.status(202).json({ accepted: true });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof WorkflowNotFoundError) {
    response.status(404).json({ error: "That opening does not exist." });
    return;
  }
  console.error(error);
  response.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected error",
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon dashboard is available at http://localhost:${port}`));
