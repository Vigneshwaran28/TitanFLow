import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

export const LIST_COLORS = ["slate", "red", "orange", "amber", "emerald", "teal", "sky", "indigo", "violet", "pink"];

const listSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80, "Keep it under 80 characters."),
  color: z.enum(LIST_COLORS, { error: "Pick a color." }).default("indigo"),
});

function toList(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    openCount: Number(row.open_count ?? 0),
    createdAt: row.created_at,
  };
}

async function findOwnedList(db, userId, id) {
  const list = await db("lists").where({ id, user_id: userId }).first();
  if (!list) throw new HttpError(404, "List not found.");
  return list;
}

router.get("/", async (req, res) => {
  const db = getDb();
  const rows = await db("lists as l")
    .leftJoin("tasks as t", function joinOpenTasks() {
      this.on("t.list_id", "l.id").andOnVal("t.status", "!=", "done");
    })
    .where("l.user_id", req.user.id)
    .groupBy("l.id", "l.name", "l.color", "l.created_at")
    .orderBy("l.created_at", "asc")
    .select("l.id", "l.name", "l.color", "l.created_at")
    .count({ open_count: "t.id" });
  res.json(rows.map(toList));
});

router.post("/", async (req, res) => {
  const input = validate(listSchema, req.body);
  const db = getDb();
  const id = await insertAndGetId(db, "lists", { ...input, user_id: req.user.id, created_at: nowIso() });
  res.status(201).json(toList(await db("lists").where({ id }).first()));
});

router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(listSchema.partial(), req.body);
  const db = getDb();
  await findOwnedList(db, req.user.id, id);
  if (Object.keys(input).length) await db("lists").where({ id }).update(input);
  res.json(toList(await db("lists").where({ id }).first()));
});

router.delete("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findOwnedList(db, req.user.id, id);
  await db("lists").where({ id }).delete(); // tasks keep existing with list_id = NULL
  res.status(204).end();
});

export default router;
