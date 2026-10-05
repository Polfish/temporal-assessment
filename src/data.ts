import type { Candidate, Service, Stylist, WaitlistClient } from "./types";

// In the prototype this stands in for Lena's Google Sheet. Read-only seed data.

export const stylists: Stylist[] = [
  { id: "lena", name: "Lena" },
  { id: "carla", name: "Carla" },
  { id: "marisol", name: "Marisol" },
];

export const services: Service[] = [
  { id: "haircut", name: "Haircut", durationMinutes: 45 },
  { id: "color", name: "Color", durationMinutes: 120 },
  { id: "highlights", name: "Highlights", durationMinutes: 150 },
  { id: "blowout", name: "Blowout", durationMinutes: 30 },
];

export const waitlist: WaitlistClient[] = [
  { id: "maya", name: "Maya Chen", phone: "555-0101", serviceId: "haircut", stylistId: "carla", stylistRequirement: "required", availability: "Weekday afternoons", signedUpAt: "2026-09-12" },
  { id: "priya", name: "Priya Nair", phone: "555-0102", serviceId: "haircut", stylistId: "carla", stylistRequirement: "preferred", availability: "Flexible", signedUpAt: "2026-09-15" },
  { id: "jordan", name: "Jordan Blake", phone: "555-0103", serviceId: "haircut", stylistRequirement: "any", availability: "Weekends, weekday evenings", signedUpAt: "2026-09-20" },
  { id: "sofia", name: "Sofia Reyes", phone: "555-0104", serviceId: "color", stylistId: "lena", stylistRequirement: "preferred", availability: "Mornings", signedUpAt: "2026-09-10" },
  { id: "tom", name: "Tom Okafor", phone: "555-0105", serviceId: "haircut", stylistId: "lena", stylistRequirement: "required", availability: "Lunchtimes", signedUpAt: "2026-09-25" },
  { id: "hannah", name: "Hannah Lee", phone: "555-0106", serviceId: "blowout", stylistRequirement: "any", availability: "Fridays", signedUpAt: "2026-09-18" },
  { id: "dev", name: "Dev Patel", phone: "555-0107", serviceId: "highlights", stylistId: "marisol", stylistRequirement: "required", availability: "Saturdays", signedUpAt: "2026-09-22" },
  { id: "grace", name: "Grace Kim", phone: "555-0108", serviceId: "color", stylistId: "carla", stylistRequirement: "preferred", availability: "Weekday afternoons", signedUpAt: "2026-09-28" },
];

export function stylistName(id: string | undefined): string | undefined {
  return stylists.find((s) => s.id === id)?.name;
}

/**
 * Lena has no reliable order today, so the prototype defines one:
 * 1. only clients waiting for this service;
 * 2. drop anyone whose required stylist is someone else;
 * 3. clients who asked for this stylist go first, then earliest signup.
 * General availability is shown to staff but not used for matching.
 */
export function rankCandidates(serviceId: string, stylistId: string): Candidate[] {
  return waitlist
    .filter((client) => client.serviceId === serviceId)
    .filter((client) => !(client.stylistRequirement === "required" && client.stylistId !== stylistId))
    .map((client) => ({ client, stylistMatch: client.stylistId === stylistId }))
    .sort(
      (a, b) =>
        Number(b.stylistMatch) - Number(a.stylistMatch) ||
        a.client.signedUpAt.localeCompare(b.client.signedUpAt),
    )
    .map(({ client, stylistMatch }) => ({
      clientId: client.id,
      name: client.name,
      phone: client.phone,
      matchNote: describeMatch(client, stylistMatch),
    }));
}

function describeMatch(client: WaitlistClient, stylistMatch: boolean): string {
  const stylist = stylistName(client.stylistId);
  const who =
    client.stylistRequirement === "any" || !stylist
      ? "Any stylist"
      : `${stylist} ${client.stylistRequirement}${stylistMatch ? "" : " (different stylist)"}`;
  return `${who} · ${client.availability} · waiting since ${client.signedUpAt}`;
}
