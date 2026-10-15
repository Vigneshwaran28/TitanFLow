// Logistics rules shared by the signed-in API and public tracking: statuses, the transition map, and codes.
import crypto from "node:crypto";

export const SHIPMENT_STATUSES = ["pending", "picked_up", "in_transit", "out_for_delivery", "delivered", "failed", "returned", "cancelled"];
export const DIRECTIONS = ["outbound", "inbound", "transfer"];
export const SERVICES = ["standard", "express", "same_day"];
export const VEHICLE_TYPES = ["bike", "car", "van", "truck", "other"];
export const VEHICLE_STATUSES = ["available", "in_use", "maintenance", "retired"];

/** Finished shipments: no more edits or status changes. */
export const TERMINAL_STATUSES = ["delivered", "cancelled", "returned"];
/** Shipments that are on the road and keep their vehicle busy. */
export const MOVING_STATUSES = ["picked_up", "in_transit", "out_for_delivery", "failed"];
/** The statuses a driver (logistics.deliver without logistics.dispatch) may set on their own shipments. */
export const DRIVER_STATUSES = ["picked_up", "in_transit", "out_for_delivery", "delivered", "failed"];

export const TRANSITIONS = Object.freeze({
  pending: ["picked_up", "cancelled"],
  picked_up: ["in_transit", "failed", "cancelled"],
  in_transit: ["out_for_delivery", "failed", "returned"],
  out_for_delivery: ["delivered", "failed"],
  failed: ["out_for_delivery", "returned", "in_transit"],
  delivered: [],
  cancelled: [],
  returned: [],
});

export const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

// No 0/O, 1/I/L: codes get read out over the phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TRACKING_CODE_LENGTH = 10;
export const TRACKING_CODE_PATTERN = /^[A-Z0-9]{6,24}$/;

export function generateTrackingCode(length = TRACKING_CODE_LENGTH) {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

/** The carrier's own tracking page, when it has a template and the shipment has the carrier's number. */
export function carrierTrackingUrl(template, reference) {
  if (!template || !reference) return null;
  return template.replaceAll("{code}", encodeURIComponent(reference));
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
