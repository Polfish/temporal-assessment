import { randomUUID } from "node:crypto";

export type SendSmsInput = { to: string; body: string };
export type SendSmsResult = { provider: "simulated"; providerMessageId: string };

/**
 * Simulated text message. In production this would call an SMS provider;
 * here it logs the message, and the Workflow keeps the full outbox so the
 * dashboard's "client phone" panel can show it.
 */
export async function sendSms({ to, body }: SendSmsInput): Promise<SendSmsResult> {
  const providerMessageId = randomUUID();
  console.log(`[sms -> ${to}] ${body}`);
  return { provider: "simulated", providerMessageId };
}
