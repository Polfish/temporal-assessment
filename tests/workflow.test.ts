import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { SendSmsInput, SendSmsResult } from "../src/activities";
import type { OpeningInput, OpeningStatus } from "../src/types";
import {
  cancelOpening,
  fillOpeningWorkflow,
  getOpeningStatus,
  markBookedInSquare,
  releaseAcceptedClient,
  respondToOffer,
} from "../src/workflows";

const TASK_QUEUE = "fill-opening-test";

let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
const sent: SendSmsInput[] = [];

before(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
        sent.push(input);
        return { provider: "simulated", providerMessageId: `test-${sent.length}` };
      },
    },
  });
  workerRun = worker.run();
});

after(async () => {
  worker.shutdown();
  await workerRun;
  await environment.teardown();
});

/** A week out on the test server's clock. The clock jumps forward whenever a test awaits a result. */
async function opening(openingId: string): Promise<OpeningInput> {
  const startsAt = new Date((await environment.currentTimeMs()) + 7 * 24 * 60 * 60 * 1000);
  return {
    openingId,
    service: "Haircut",
    stylist: "Carla",
    startsAt: startsAt.toISOString(),
    startsAtLabel: "Tue, Oct 13, 2:00 PM",
    offerWindowMinutes: 15,
    candidates: [
      { clientId: "maya", name: "Maya Chen", phone: "555-0101", matchNote: "Carla required" },
      { clientId: "priya", name: "Priya Nair", phone: "555-0102", matchNote: "Carla preferred" },
      { clientId: "jordan", name: "Jordan Blake", phone: "555-0103", matchNote: "Any stylist" },
    ],
  };
}

async function start(openingId: string) {
  return environment.client.workflow.start(fillOpeningWorkflow, {
    workflowId: openingId,
    taskQueue: TASK_QUEUE,
    args: [await opening(openingId)],
  });
}

type Handle = Awaited<ReturnType<typeof start>>;

async function status(handle: Handle): Promise<OpeningStatus> {
  return handle.query(getOpeningStatus);
}

/** Activities finish a moment after the Workflow task, so poll briefly for the expected state. */
async function waitFor(check: (s: OpeningStatus) => boolean, handle: Handle, what: string): Promise<OpeningStatus> {
  const deadline = Date.now() + 10_000;
  let latest = await status(handle);
  while (!check(latest)) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what}\n${JSON.stringify(latest, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await status(handle);
  }
  return latest;
}

const kinds = (s: OpeningStatus) => s.messages.map((m) => `${m.kind}:${m.clientId}`);

test("the first client accepts, gets a confirmation, and the chair is booked", async () => {
  const handle = await start("accept");
  await waitFor((s) => s.currentOffer?.clientId === "maya", handle, "offer to Maya");

  const result = await handle.executeUpdate(respondToOffer, {
    args: [{ clientId: "maya", answer: "yes", actor: "client" }],
  });
  assert.equal(result.outcome, "accepted");

  const filled = await waitFor((s) => s.phase === "filled" && s.messages.length === 2, handle, "filled");
  assert.equal(filled.acceptedClientId, "maya");
  assert.equal(filled.candidates[0].outcome, "accepted");
  assert.deepEqual(kinds(filled), ["offer:maya", "confirmation:maya"]);
  assert.match(filled.messages[1].body, /^You're booked! Haircut with Carla, Tue, Oct 13, 2:00 PM/);

  await handle.signal(markBookedInSquare);
  const final = await handle.result();
  assert.equal(final.phase, "filled");
  assert.equal(final.bookedInSquare, true);
  assert.equal(final.candidates[1].outcome, "not_reached");
  assert.equal(final.candidates[2].outcome, "not_reached");
});

test("a client who does not reply in time is passed over and the next one is offered the chair", async () => {
  const handle = await start("timeout");
  await waitFor((s) => s.currentOffer?.clientId === "maya", handle, "offer to Maya");

  await environment.sleep("16 minutes");
  const moved = await waitFor((s) => s.currentOffer?.clientId === "priya", handle, "offer to Priya");
  assert.equal(moved.candidates[0].outcome, "timed_out");
  assert.equal(moved.phase, "searching");
  assert.deepEqual(kinds(moved), ["offer:maya", "offer:priya"]);

  const result = await handle.executeUpdate(respondToOffer, {
    args: [{ clientId: "priya", answer: "yes", actor: "client" }],
  });
  assert.equal(result.outcome, "accepted");
  const filled = await waitFor((s) => s.phase === "filled", handle, "filled by Priya");
  assert.equal(filled.acceptedClientId, "priya");
});

test("a late YES from someone whose window closed is refused and they are told the chair is taken", async () => {
  const handle = await start("stale-yes");
  await waitFor((s) => s.currentOffer?.clientId === "maya", handle, "offer to Maya");
  await environment.sleep("16 minutes");
  await waitFor((s) => s.currentOffer?.clientId === "priya", handle, "offer to Priya");

  const late = await handle.executeUpdate(respondToOffer, {
    args: [{ clientId: "maya", answer: "yes", actor: "client" }],
  });
  assert.equal(late.outcome, "too_late");
  assert.equal(late.accepted, false);

  const after = await waitFor((s) => kinds(s).includes("too_late:maya"), handle, "too-late text to Maya");
  assert.equal(after.phase, "searching");
  assert.equal(after.currentOffer?.clientId, "priya", "Priya still holds the only offer");
  assert.equal(after.candidates[0].outcome, "timed_out");
  assert.match(after.messages.at(-1)!.body, /already been taken/);
});

test("releasing a client who changed their mind withdraws their booking and resumes with the next person", async () => {
  const handle = await start("release");
  await waitFor((s) => s.currentOffer?.clientId === "maya", handle, "offer to Maya");
  await handle.executeUpdate(respondToOffer, { args: [{ clientId: "maya", answer: "yes", actor: "client" }] });
  await waitFor((s) => s.phase === "filled", handle, "filled by Maya");

  await handle.signal(releaseAcceptedClient);
  const resumed = await waitFor((s) => s.currentOffer?.clientId === "priya", handle, "offer to Priya");
  assert.equal(resumed.phase, "searching");
  assert.equal(resumed.acceptedClientId, undefined);
  assert.equal(resumed.candidates[0].outcome, "released");
  assert.deepEqual(kinds(resumed), ["offer:maya", "confirmation:maya", "withdrawn:maya", "offer:priya"]);
});

test("cancelling the opening stops everything and tells whoever held the offer", async () => {
  const handle = await start("cancel");
  await waitFor((s) => s.currentOffer?.clientId === "maya", handle, "offer to Maya");

  await handle.signal(cancelOpening);
  const final = await handle.result();
  assert.equal(final.phase, "cancelled");
  assert.equal(final.currentOffer, undefined);
  assert.equal(final.candidates[0].outcome, "released");
  assert.equal(final.candidates[1].outcome, "not_reached");
  assert.deepEqual(kinds(final), ["offer:maya", "withdrawn:maya"]);
});
