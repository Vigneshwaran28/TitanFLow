// Creating accounts. Only tenant user managers and the provider console create users; there is no public sign-up.
import bcrypt from "bcryptjs";
import { insertAndGetId } from "../db/connection.js";
import { HttpError, nowIso } from "../utils/http.js";
import { assertSeatAvailable } from "./tenants.js";

/** Built-in role keys accepted wherever a single legacy `role` is given. */
export const ROLES = Object.freeze(["admin", "agent", "member"]);

/**
 * Resolves the roles to give a new or edited user: explicit role ids (must belong to the tenant), or a
 * built-in role key. Falls back to Member.
 * @returns {Promise<number[]>}
 */
export async function resolveRoleIds(db, tenantId, { roleIds, role } = {}) {
  if (roleIds?.length) {
    const unique = [...new Set(roleIds)];
    const found = await db("roles").where("tenant_id", tenantId).whereIn("id", unique).select("id");
    if (found.length !== unique.length) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { roleIds: "Pick roles from your workspace." } });
    return unique;
  }
  const builtIn = await db("roles").where({ tenant_id: tenantId, key: role ?? "member" }).first();
  if (!builtIn) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { role: "Unknown role." } });
  return [builtIn.id];
}

/**
 * Ids of every account with this email (case-insensitive), oldest first. Emails are unique per workspace,
 * so the same address can match one account in each of several workspaces; `workspace` (a tenant slug)
 * narrows it to that workspace.
 * @param {import("knex").Knex} db
 * @param {string} email
 * @param {{ workspace?: string }} [options]
 * @returns {Promise<number[]>}
 */
export async function findAccountIdsByEmail(db, email, { workspace } = {}) {
  const query = db("users as u").join("tenants as t", "t.id", "u.tenant_id").whereRaw("lower(u.email) = ?", [String(email).trim().toLowerCase()]);
  if (workspace) query.where("t.slug", workspace);
  return (await query.orderBy("u.id").select("u.id")).map(row => row.id);
}

/**
 * Creates a user inside a tenant with roles and a starter task list. Emails are unique within a tenant (the same address may exist in other workspaces) and stored lowercased.
 * People given a temporary password by someone else must choose their own at first sign-in.
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {{ tenantId: number, name: string, email: string, password: string, role?: string, roleIds?: number[], jobTitle?: string | null, dateOfBirth?: string | null, joinedOn?: string | null, mustChangePassword?: boolean }} input
 * @returns {Promise<number>} the new user's id
 */
export async function createUser(db, { tenantId, name, email, password, role, roleIds, jobTitle = null, dateOfBirth = null, joinedOn = null, mustChangePassword = true }) {
  const normalized = email.trim().toLowerCase();
  if (await db("users").where("tenant_id", tenantId).whereRaw("lower(email) = ?", [normalized]).first()) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { email: "Someone in this workspace already uses this email." } });
  }
  await assertSeatAvailable(db, tenantId);
  const ids = await resolveRoleIds(db, tenantId, { roleIds, role });

  const createdAt = nowIso();
  const id = await insertAndGetId(db, "users", {
    tenant_id: tenantId,
    name: name.trim(),
    email: normalized,
    password_hash: await bcrypt.hash(password, 10),
    role: ROLES.includes(role) ? role : "member", // legacy column, no longer used for access
    job_title: jobTitle || null,
    date_of_birth: dateOfBirth || null,
    joined_on: joinedOn || null,
    is_active: true,
    must_change_password: mustChangePassword,
    created_at: createdAt,
  });
  await db("user_roles").insert(ids.map(roleId => ({ user_id: id, role_id: roleId })));
  await db("lists").insert({ user_id: id, name: "Personal", color: "indigo", created_at: createdAt });
  return id;
}
