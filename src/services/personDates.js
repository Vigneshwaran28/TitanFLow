// Validation for dates about people: date of birth (age 14 to 100) and joining date.
import { z } from "zod";
import { yearsSince } from "./celebrations.js";

const realDate = value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const today = () => new Date().toISOString().slice(0, 10);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 1994-08-21.").refine(realDate, "That date doesn't exist.");

export const dateOfBirthSchema = day
  .refine(value => value <= today(), "The date of birth can't be in the future.")
  .refine(value => {
    const age = yearsSince(value, today());
    return age >= 14 && age <= 100;
  }, "Age must be between 14 and 100.");

export const joinedOnSchema = day.refine(value => value >= "1950-01-01", "Check the year.").refine(value => {
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  return value <= limit.toISOString().slice(0, 10);
}, "Joining dates can be at most a year ahead.");

/** Age in completed years, or null without a date of birth. */
export const ageOf = dateOfBirth => (dateOfBirth ? yearsSince(dateOfBirth) : null);
