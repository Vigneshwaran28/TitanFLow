// Dialect-neutral schema, shared by SQLite and PostgreSQL.
// Datetimes are stored as ISO-8601 UTC strings (always 24 chars from Date#toISOString),
// so string comparison and ordering behave identically on both databases.

const migrations = {
  "001_initial": {
    async up(knex) {
      await knex.schema.createTable("users", table => {
        table.increments("id").primary();
        table.string("name", 120).notNullable();
        table.string("email", 255).notNullable().unique();
        table.string("password_hash", 255).notNullable();
        table.string("role", 20).notNullable().defaultTo("member");
        table.string("created_at", 30).notNullable();
      });

      await knex.schema.createTable("lists", table => {
        table.increments("id").primary();
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("name", 80).notNullable();
        table.string("color", 20).notNullable().defaultTo("indigo");
        table.string("created_at", 30).notNullable();
        table.index(["user_id"]);
      });

      await knex.schema.createTable("tasks", table => {
        table.increments("id").primary();
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.integer("list_id").unsigned().nullable().references("id").inTable("lists").onDelete("SET NULL");
        table.string("title", 200).notNullable();
        table.text("notes").nullable();
        table.string("status", 20).notNullable().defaultTo("todo");
        table.string("priority", 20).notNullable().defaultTo("medium");
        table.string("due_at", 30).nullable();
        table.string("remind_at", 30).nullable();
        table.boolean("reminder_sent").notNullable().defaultTo(false);
        table.string("repeat", 20).notNullable().defaultTo("none");
        table.string("completed_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["user_id", "due_at"]);
        table.index(["remind_at"]);
      });

      await knex.schema.createTable("notifications", table => {
        table.increments("id").primary();
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.integer("task_id").unsigned().nullable().references("id").inTable("tasks").onDelete("SET NULL");
        table.string("title", 255).notNullable();
        table.string("body", 500).nullable();
        table.boolean("is_read").notNullable().defaultTo(false);
        table.string("created_at", 30).notNullable();
        table.index(["user_id", "is_read"]);
      });
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("notifications");
      await knex.schema.dropTableIfExists("tasks");
      await knex.schema.dropTableIfExists("lists");
      await knex.schema.dropTableIfExists("users");
    },
  },

  "002_admin_audit": {
    async up(knex) {
      await knex.schema.createTable("admin_audit", table => {
        table.increments("id").primary();
        table.string("actor", 120).notNullable();
        table.string("action", 40).notNullable();
        table.string("target", 120).nullable();
        table.text("details").nullable();
        table.string("ip", 64).nullable();
        table.string("created_at", 30).notNullable();
        table.index(["created_at"]);
      });
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("admin_audit");
    },
  },

  // Workspace: roles (admin / agent / member), teams, people directory, and the help desk.
  "003_workspace_helpdesk": {
    async up(knex) {
      await knex.schema.alterTable("users", table => {
        table.string("job_title", 120).nullable();
      });

      await knex.schema.createTable("teams", table => {
        table.increments("id").primary();
        table.string("name", 80).notNullable().unique();
        table.string("description", 300).nullable();
        table.string("color", 20).notNullable().defaultTo("indigo");
        table.string("created_at", 30).notNullable();
      });

      await knex.schema.createTable("team_members", table => {
        table.integer("team_id").unsigned().notNullable().references("id").inTable("teams").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.boolean("is_lead").notNullable().defaultTo(false);
        table.string("created_at", 30).notNullable();
        table.primary(["team_id", "user_id"]);
        table.index(["user_id"]);
      });

      await knex.schema.createTable("tickets", table => {
        table.increments("id").primary();
        table.integer("requester_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.integer("assignee_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.integer("team_id").unsigned().nullable().references("id").inTable("teams").onDelete("SET NULL");
        table.string("subject", 200).notNullable();
        table.text("description").notNullable();
        table.string("category", 30).notNullable().defaultTo("other");
        table.string("priority", 20).notNullable().defaultTo("medium");
        table.string("status", 20).notNullable().defaultTo("open");
        table.string("response_due_at", 30).notNullable();
        table.string("resolution_due_at", 30).notNullable();
        table.string("first_response_at", 30).nullable();
        table.string("resolved_at", 30).nullable();
        table.string("closed_at", 30).nullable();
        table.integer("satisfaction").nullable();
        table.string("satisfaction_comment", 1000).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["requester_id"]);
        table.index(["assignee_id", "status"]);
        table.index(["team_id", "status"]);
        table.index(["status", "resolution_due_at"]);
      });

      await knex.schema.createTable("ticket_comments", table => {
        table.increments("id").primary();
        table.integer("ticket_id").unsigned().notNullable().references("id").inTable("tickets").onDelete("CASCADE");
        table.integer("author_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.text("body").notNullable();
        table.boolean("is_internal").notNullable().defaultTo(false);
        table.string("created_at", 30).notNullable();
        table.index(["ticket_id", "created_at"]);
      });

      await knex.schema.createTable("ticket_events", table => {
        table.increments("id").primary();
        table.integer("ticket_id").unsigned().notNullable().references("id").inTable("tickets").onDelete("CASCADE");
        table.integer("actor_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("type", 30).notNullable();
        table.string("from_value", 120).nullable();
        table.string("to_value", 120).nullable();
        table.string("created_at", 30).notNullable();
        table.index(["ticket_id", "created_at"]);
      });

      // Plain column (no foreign key) so SQLite can add it in place; a deleted ticket leaves a harmless dangling id.
      await knex.schema.alterTable("notifications", table => {
        table.integer("ticket_id").unsigned().nullable();
      });
    },

    async down(knex) {
      await knex.schema.alterTable("notifications", table => table.dropColumn("ticket_id"));
      await knex.schema.dropTableIfExists("ticket_events");
      await knex.schema.dropTableIfExists("ticket_comments");
      await knex.schema.dropTableIfExists("tickets");
      await knex.schema.dropTableIfExists("team_members");
      await knex.schema.dropTableIfExists("teams");
      await knex.schema.alterTable("users", table => table.dropColumn("job_title"));
    },
  },

  // Multi-tenancy (each company is a tenant with its own modules and users) and the
  // inventory, sales, and attendance modules. Existing data moves into a "Default workspace" tenant.
  "004_tenants_modules": {
    async up(knex) {
      await knex.schema.createTable("tenants", table => {
        table.increments("id").primary();
        table.string("name", 120).notNullable();
        table.string("slug", 60).notNullable().unique();
        table.string("status", 20).notNullable().defaultTo("active");
        table.text("features").notNullable(); // JSON array of module keys
        table.integer("max_users").nullable();
        table.string("contact_email", 255).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
      });

      const now = new Date().toISOString();
      await knex("tenants").insert({
        name: "Default workspace",
        slug: "default",
        status: "active",
        features: JSON.stringify(["tasks", "helpdesk", "directory", "inventory", "sales", "attendance"]),
        created_at: now,
        updated_at: now,
      });
      const { id: defaultTenant } = await knex("tenants").where({ slug: "default" }).first();

      // Plain integer columns (no foreign key) so SQLite can add them in place.
      await knex.schema.alterTable("users", table => {
        table.integer("tenant_id").unsigned().nullable().index();
        table.boolean("is_active").notNullable().defaultTo(true);
      });
      await knex.schema.alterTable("tickets", table => table.integer("tenant_id").unsigned().nullable().index());
      await knex.schema.alterTable("teams", table => table.integer("tenant_id").unsigned().nullable().index());
      await knex("users").update({ tenant_id: defaultTenant });
      await knex("tickets").update({ tenant_id: defaultTenant });
      await knex("teams").update({ tenant_id: defaultTenant });

      // Team names are unique per tenant, not globally.
      await knex.schema.alterTable("teams", table => {
        table.dropUnique(["name"]);
        table.unique(["tenant_id", "name"]);
      });

      // ---- Inventory ----
      await knex.schema.createTable("products", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("sku", 60).notNullable();
        table.string("name", 160).notNullable();
        table.string("category", 80).nullable();
        table.string("unit", 20).notNullable().defaultTo("pcs");
        table.decimal("cost_price", 14, 2).notNullable().defaultTo(0);
        table.decimal("sale_price", 14, 2).notNullable().defaultTo(0);
        table.integer("quantity").notNullable().defaultTo(0);
        table.integer("reorder_level").notNullable().defaultTo(0);
        table.text("description").nullable();
        table.boolean("is_active").notNullable().defaultTo(true);
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.unique(["tenant_id", "sku"]);
      });

      await knex.schema.createTable("stock_movements", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("product_id").unsigned().notNullable().references("id").inTable("products").onDelete("CASCADE");
        table.string("type", 20).notNullable(); // in, out, adjust, sale, return
        table.integer("change").notNullable(); // signed quantity
        table.integer("balance_after").notNullable();
        table.string("reason", 200).nullable();
        table.string("reference", 80).nullable();
        table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("created_at", 30).notNullable();
        table.index(["tenant_id", "created_at"]);
        table.index(["product_id", "created_at"]);
      });

      // ---- Sales ----
      await knex.schema.createTable("customers", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("name", 160).notNullable();
        table.string("company", 160).nullable();
        table.string("email", 255).nullable();
        table.string("phone", 40).nullable();
        table.string("address", 300).nullable();
        table.text("notes").nullable();
        table.integer("owner_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["tenant_id"]);
      });

      await knex.schema.createTable("deals", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("customer_id").unsigned().nullable().references("id").inTable("customers").onDelete("SET NULL");
        table.string("title", 200).notNullable();
        table.decimal("value", 14, 2).notNullable().defaultTo(0);
        table.string("stage", 20).notNullable().defaultTo("lead");
        table.string("expected_close", 10).nullable(); // YYYY-MM-DD
        table.integer("owner_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.text("notes").nullable();
        table.string("closed_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["tenant_id", "stage"]);
      });

      await knex.schema.createTable("orders", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("customer_id").unsigned().nullable().references("id").inTable("customers").onDelete("SET NULL");
        table.string("status", 20).notNullable().defaultTo("draft"); // draft, confirmed, fulfilled, cancelled
        table.decimal("total", 14, 2).notNullable().defaultTo(0);
        table.text("notes").nullable();
        table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("confirmed_at", 30).nullable();
        table.string("fulfilled_at", 30).nullable();
        table.string("cancelled_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["tenant_id", "status"]);
      });

      await knex.schema.createTable("order_items", table => {
        table.increments("id").primary();
        table.integer("order_id").unsigned().notNullable().references("id").inTable("orders").onDelete("CASCADE");
        table.integer("product_id").unsigned().nullable().references("id").inTable("products").onDelete("SET NULL");
        table.string("description", 200).notNullable();
        table.integer("quantity").notNullable();
        table.decimal("unit_price", 14, 2).notNullable();
        table.decimal("line_total", 14, 2).notNullable();
        table.index(["order_id"]);
      });

      // ---- Attendance ----
      await knex.schema.createTable("attendance_records", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("work_date", 10).notNullable(); // the employee's local calendar day
        table.string("check_in_at", 30).notNullable();
        table.string("check_out_at", 30).nullable();
        table.string("note", 300).nullable();
        table.unique(["user_id", "work_date"]);
        table.index(["tenant_id", "work_date"]);
      });

      await knex.schema.createTable("leave_requests", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("type", 20).notNullable();
        table.string("start_date", 10).notNullable();
        table.string("end_date", 10).notNullable();
        table.integer("days").notNullable();
        table.string("reason", 500).nullable();
        table.string("status", 20).notNullable().defaultTo("pending");
        table.integer("reviewer_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("review_note", 300).nullable();
        table.string("reviewed_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.index(["tenant_id", "status"]);
        table.index(["user_id", "start_date"]);
      });
    },

    async down(knex) {
      for (const name of ["leave_requests", "attendance_records", "order_items", "orders", "deals", "customers", "stock_movements", "products"]) {
        await knex.schema.dropTableIfExists(name);
      }
      await knex.schema.alterTable("teams", table => {
        table.dropUnique(["tenant_id", "name"]);
        table.unique(["name"]);
        table.dropColumn("tenant_id");
      });
      await knex.schema.alterTable("tickets", table => table.dropColumn("tenant_id"));
      await knex.schema.alterTable("users", table => {
        table.dropColumn("tenant_id");
        table.dropColumn("is_active");
      });
      await knex.schema.dropTableIfExists("tenants");
    },
  },

  // Per-tenant module settings, automatic attendance and half-day leave, and the messaging,
  // announcements, and expenses modules.
  "005_settings_messaging": {
    async up(knex) {
      await knex.schema.alterTable("tenants", table => table.text("settings").nullable()); // JSON, merged over defaults
      await knex.schema.alterTable("leave_requests", table => table.string("portion", 12).notNullable().defaultTo("full")); // full, first_half, second_half
      await knex.schema.alterTable("attendance_records", table => {
        table.string("source", 10).notNullable().defaultTo("manual"); // manual, auto
        table.string("check_in_local", 5).nullable(); // HH:MM on the employee's clock, for "late" checks
      });

      // ---- Messaging ----
      await knex.schema.createTable("conversations", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("type", 10).notNullable(); // direct, group
        table.string("name", 80).nullable();
        table.string("direct_key", 40).nullable(); // "lowId:highId" so two people share one direct chat
        table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("last_message_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.unique(["tenant_id", "direct_key"]);
        table.index(["tenant_id", "last_message_at"]);
      });

      await knex.schema.createTable("conversation_members", table => {
        table.integer("conversation_id").unsigned().notNullable().references("id").inTable("conversations").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("role", 10).notNullable().defaultTo("member"); // owner, member
        table.string("last_read_at", 30).nullable();
        table.string("joined_at", 30).notNullable();
        table.primary(["conversation_id", "user_id"]);
        table.index(["user_id"]);
      });

      await knex.schema.createTable("messages", table => {
        table.increments("id").primary();
        table.integer("conversation_id").unsigned().notNullable().references("id").inTable("conversations").onDelete("CASCADE");
        table.integer("sender_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.text("body").notNullable();
        table.string("kind", 10).notNullable().defaultTo("text"); // text, system (joined / left / renamed)
        table.string("created_at", 30).notNullable();
        table.string("deleted_at", 30).nullable();
        table.index(["conversation_id", "id"]);
      });

      // ---- Announcements ----
      await knex.schema.createTable("announcements", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("author_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("title", 160).notNullable();
        table.text("body").notNullable();
        table.boolean("pinned").notNullable().defaultTo(false);
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["tenant_id", "created_at"]);
      });

      await knex.schema.createTable("announcement_reads", table => {
        table.integer("announcement_id").unsigned().notNullable().references("id").inTable("announcements").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("read_at", 30).notNullable();
        table.primary(["announcement_id", "user_id"]);
      });

      // ---- Expenses ----
      await knex.schema.createTable("expenses", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("title", 160).notNullable();
        table.string("category", 60).notNullable();
        table.decimal("amount", 14, 2).notNullable();
        table.string("spent_on", 10).notNullable();
        table.string("notes", 1000).nullable();
        table.string("status", 20).notNullable().defaultTo("pending"); // pending, approved, rejected, paid, cancelled
        table.integer("reviewer_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("review_note", 300).nullable();
        table.string("reviewed_at", 30).nullable();
        table.string("paid_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.index(["tenant_id", "status"]);
        table.index(["user_id", "created_at"]);
      });

      // The default workspace gets the new modules; other tenants opt in through the console.
      const tenant = await knex("tenants").where({ slug: "default" }).first();
      if (tenant) {
        const features = new Set(JSON.parse(tenant.features || "[]"));
        ["messaging", "announcements", "expenses"].forEach(key => features.add(key));
        await knex("tenants").where({ id: tenant.id }).update({ features: JSON.stringify([...features]) });
      }
    },

    async down(knex) {
      for (const name of ["expenses", "announcement_reads", "announcements", "messages", "conversation_members", "conversations"]) {
        await knex.schema.dropTableIfExists(name);
      }
      await knex.schema.alterTable("attendance_records", table => {
        table.dropColumn("source");
        table.dropColumn("check_in_local");
      });
      await knex.schema.alterTable("leave_requests", table => table.dropColumn("portion"));
      await knex.schema.alterTable("tenants", table => table.dropColumn("settings"));
    },
  },

  // Access control (IAM): per-tenant roles with permissions, several roles per person, a tenant audit
  // log, and forced password change for accounts created with a temporary password.
  "006_access_control": {
    async up(knex) {
      await knex.schema.createTable("roles", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("key", 20).nullable(); // owner, admin, agent, member for built-in roles; null for custom
        table.string("name", 60).notNullable();
        table.string("description", 300).nullable();
        table.text("permissions").notNullable(); // JSON array of permission keys
        table.boolean("is_system").notNullable().defaultTo(false);
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.unique(["tenant_id", "name"]);
        table.index(["tenant_id", "key"]);
      });

      await knex.schema.createTable("user_roles", table => {
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.integer("role_id").unsigned().notNullable().references("id").inTable("roles").onDelete("CASCADE");
        table.primary(["user_id", "role_id"]);
        table.index(["role_id"]);
      });

      await knex.schema.createTable("tenant_audit", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("actor_id").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("action", 40).notNullable();
        table.string("target", 160).nullable();
        table.text("details").nullable();
        table.string("created_at", 30).notNullable();
        table.index(["tenant_id", "created_at"]);
      });

      await knex.schema.alterTable("users", table => table.boolean("must_change_password").notNullable().defaultTo(false));

      // Every tenant gets the built-in roles; people keep the access their old role gave them.
      const { seedTenantRoles } = await import("../services/permissions.js");
      const now = new Date().toISOString();
      for (const tenant of await knex("tenants").select("id")) {
        const ids = await seedTenantRoles(knex, tenant.id, now);
        const users = await knex("users").where({ tenant_id: tenant.id }).orderBy("id").select("id", "role");
        const firstAdmin = users.find(user => user.role === "admin");
        const links = users.map(user => ({ user_id: user.id, role_id: ids[user.role] ?? ids.member }));
        if (firstAdmin) links.push({ user_id: firstAdmin.id, role_id: ids.owner });
        if (links.length) await knex("user_roles").insert(links);
      }
    },

    async down(knex) {
      await knex.schema.alterTable("users", table => table.dropColumn("must_change_password"));
      await knex.schema.dropTableIfExists("tenant_audit");
      await knex.schema.dropTableIfExists("user_roles");
      await knex.schema.dropTableIfExists("roles");
    },
  },

  // Holiday calendar, birthdays and work anniversaries, personal preferences, and database integrity:
  // the tenant links added in place by earlier migrations become real foreign keys, plus missing indexes
  // and (on PostgreSQL) CHECK constraints on enumerated columns.
  "007_holidays_people_integrity": {
    // SQLite adds a foreign key by rebuilding the table. Foreign-key checks must be off while the old table
    // is dropped (or SQLite would cascade-delete dependent rows), and SQLite only allows that outside a
    // transaction, so this migration runs without one, after taking a backup copy of the database file.
    config: { transaction: false },

    async up(knex) {
      const sqlite = knex.client.dialect === "sqlite3";
      const now = new Date().toISOString();

      if (sqlite) {
        const file = knex.client.connectionSettings.filename;
        const backup = file.replace(/\.(db|sqlite3?)$/i, "") + `.before-007-${Date.now()}.db`;
        await knex.raw("VACUUM INTO ?", [backup]);
      }

      // ---- New columns and tables ----
      await knex.schema.alterTable("users", table => {
        table.string("date_of_birth", 10).nullable(); // YYYY-MM-DD
        table.string("joined_on", 10).nullable(); // YYYY-MM-DD, for work anniversaries
        table.boolean("show_birthday").notNullable().defaultTo(true); // colleagues may see day and month (never the year)
        table.text("preferences").nullable(); // JSON: appearance, home layout, avatar link, personal CSS (routes/auth.js preferencesSchema)
      });

      await knex.schema.createTable("holidays", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("holiday_date", 10).notNullable();
        table.string("name", 120).notNullable();
        table.string("type", 12).notNullable().defaultTo("public"); // public, company, optional
        table.string("description", 300).nullable();
        table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.unique(["tenant_id", "holiday_date", "name"]);
        table.index(["tenant_id", "holiday_date"]);
      });

      await knex.schema.createTable("holiday_selections", table => {
        table.integer("holiday_id").unsigned().notNullable().references("id").inTable("holidays").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("created_at", 30).notNullable();
        table.primary(["holiday_id", "user_id"]);
        table.index(["user_id"]);
      });

      await knex.schema.createTable("celebration_notices", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("kind", 20).notNullable(); // birthday, anniversary
        table.integer("year").notNullable();
        table.string("created_at", 30).notNullable();
        table.unique(["user_id", "kind", "year"]); // one greeting per person, kind, and year
      });

      // ---- Clean up anything a foreign key would reject ----
      const firstTenant = await knex("tenants").orderBy("id").first();
      if (firstTenant) await knex("users").whereNull("tenant_id").update({ tenant_id: firstTenant.id });
      await knex("users").whereNotIn("tenant_id", knex("tenants").select("id")).update({ tenant_id: firstTenant?.id ?? null });
      await knex("teams").whereNull("tenant_id").update({ tenant_id: firstTenant?.id ?? null });
      // A ticket belongs to its requester's tenant.
      await knex("tickets")
        .whereNull("tenant_id")
        .update({ tenant_id: knex("users").select("tenant_id").whereRaw("users.id = tickets.requester_id") });
      await knex("notifications").whereNotNull("ticket_id").whereNotIn("ticket_id", knex("tickets").select("id")).update({ ticket_id: null });

      // ---- Foreign keys (and NOT NULL) on the columns added in place earlier ----
      await knex.schema.alterTable("users", table => {
        table.integer("tenant_id").unsigned().notNullable().alter();
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
      });
      await knex.schema.alterTable("teams", table => {
        table.integer("tenant_id").unsigned().notNullable().alter();
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
      });
      await knex.schema.alterTable("tickets", table => {
        table.integer("tenant_id").unsigned().notNullable().alter();
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
      });
      await knex.schema.alterTable("notifications", table => {
        table.foreign("ticket_id").references("id").inTable("tickets").onDelete("SET NULL");
      });

      // ---- Indexes for the hottest queries ----
      await knex.schema.alterTable("users", table => table.index(["tenant_id", "is_active"]));
      await knex.schema.alterTable("notifications", table => table.index(["user_id", "created_at"]));
      await knex.schema.alterTable("tasks", table => table.index(["user_id", "status"]));
      await knex.schema.alterTable("tickets", table => table.index(["tenant_id", "updated_at"]));
      await knex.schema.alterTable("deals", table => table.index(["tenant_id", "updated_at"]));
      await knex.schema.alterTable("leave_requests", table => table.index(["tenant_id", "start_date"]));
      await knex.schema.alterTable("customers", table => table.index(["tenant_id", "name"]));
      await knex.schema.alterTable("products", table => table.index(["tenant_id", "is_active"]));

      // ---- CHECK constraints (PostgreSQL; SQLite can't add them to existing tables) ----
      if (!sqlite) {
        const checks = [
          ["tickets", "tickets_status_check", "status in ('open','in_progress','waiting','resolved','closed')"],
          ["tickets", "tickets_priority_check", "priority in ('low','medium','high','urgent')"],
          ["tickets", "tickets_satisfaction_check", "satisfaction is null or satisfaction between 1 and 5"],
          ["tasks", "tasks_status_check", "status in ('todo','in_progress','done')"],
          ["leave_requests", "leave_status_check", "status in ('pending','approved','rejected','cancelled')"],
          ["leave_requests", "leave_dates_check", "end_date >= start_date"],
          ["expenses", "expenses_amount_check", "amount > 0"],
          ["expenses", "expenses_status_check", "status in ('pending','approved','rejected','paid','cancelled')"],
          ["orders", "orders_status_check", "status in ('draft','confirmed','fulfilled','cancelled')"],
          ["order_items", "order_items_quantity_check", "quantity > 0"],
          ["products", "products_quantity_check", "quantity >= 0"],
          ["deals", "deals_value_check", "value >= 0"],
          ["holidays", "holidays_type_check", "type in ('public','company','optional')"],
          ["tenants", "tenants_status_check", "status in ('active','suspended')"],
        ];
        for (const [table, name, condition] of checks) await knex.raw(`alter table ?? add constraint ?? check (${condition})`, [table, name]);
      }

      // ---- The new permission goes to every tenant's Admin role ----
      for (const role of await knex("roles").where({ key: "admin" })) {
        const permissions = new Set(JSON.parse(role.permissions || "[]"));
        permissions.add("attendance.holidays.manage");
        await knex("roles").where({ id: role.id }).update({ permissions: JSON.stringify([...permissions]), updated_at: now });
      }
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("celebration_notices");
      await knex.schema.dropTableIfExists("holiday_selections");
      await knex.schema.dropTableIfExists("holidays");
      await knex.schema.alterTable("users", table => {
        table.dropColumn("date_of_birth");
        table.dropColumn("joined_on");
        table.dropColumn("show_birthday");
        table.dropColumn("preferences");
      });
    },
  },

  "008_billing_logistics_clinic": {
    // Three industry modules. Every table is tenant-owned (tenant FK, cascade) with the indexes its screens filter on.
    async up(knex) {
      const now = new Date().toISOString();
      const tenantFk = table => table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
      const userFk = (table, column, onDelete = "SET NULL") => {
        const col = table.integer(column).unsigned();
        (onDelete === "CASCADE" ? col.notNullable() : col.nullable()).references("id").inTable("users").onDelete(onDelete);
      };
      const timestamps = table => {
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
      };

      // ---- Billing: invoices and quotes, their lines, and payments ----
      await knex.schema.createTable("invoices", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.string("kind", 10).notNullable().defaultTo("invoice"); // invoice, quote
        table.string("number", 30).notNullable(); // INV-0001 / QT-0001, per tenant and kind
        table.integer("customer_id").unsigned().nullable().references("id").inTable("customers").onDelete("SET NULL");
        table.string("bill_to_name", 160).notNullable();
        table.string("bill_to_email", 255).nullable();
        table.string("bill_to_phone", 40).nullable();
        table.string("bill_to_address", 500).nullable();
        table.string("bill_to_tax_id", 40).nullable();
        table.string("issue_date", 10).notNullable();
        table.string("due_date", 10).nullable(); // quotes: valid until
        table.string("status", 20).notNullable().defaultTo("draft"); // invoice: draft, sent, partially_paid, paid, void; quote: draft, sent, accepted, declined, converted
        table.string("currency", 3).notNullable();
        table.float("subtotal").notNullable().defaultTo(0);
        table.float("discount_total").notNullable().defaultTo(0);
        table.float("tax_total").notNullable().defaultTo(0);
        table.float("total").notNullable().defaultTo(0);
        table.float("amount_paid").notNullable().defaultTo(0);
        table.text("notes").nullable();
        table.text("terms").nullable();
        table.integer("source_quote_id").unsigned().nullable().references("id").inTable("invoices").onDelete("SET NULL");
        table.integer("order_id").unsigned().nullable().references("id").inTable("orders").onDelete("SET NULL");
        userFk(table, "created_by");
        table.string("sent_at", 30).nullable();
        table.string("paid_at", 30).nullable();
        table.string("voided_at", 30).nullable();
        timestamps(table);
        table.unique(["tenant_id", "kind", "number"]);
        table.index(["tenant_id", "kind", "status"]);
        table.index(["tenant_id", "issue_date"]);
        table.index(["tenant_id", "due_date"]);
        table.index(["customer_id"]);
      });

      await knex.schema.createTable("invoice_items", table => {
        table.increments("id").primary();
        table.integer("invoice_id").unsigned().notNullable().references("id").inTable("invoices").onDelete("CASCADE");
        table.integer("product_id").unsigned().nullable().references("id").inTable("products").onDelete("SET NULL");
        table.integer("position").notNullable().defaultTo(0);
        table.string("description", 300).notNullable();
        table.float("quantity").notNullable();
        table.string("unit", 20).nullable();
        table.float("unit_price").notNullable();
        table.float("discount_pct").notNullable().defaultTo(0);
        table.float("tax_rate").notNullable().defaultTo(0);
        table.float("line_subtotal").notNullable(); // after discount, before tax
        table.float("line_tax").notNullable();
        table.float("line_total").notNullable();
        table.index(["invoice_id", "position"]);
      });

      await knex.schema.createTable("invoice_payments", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.integer("invoice_id").unsigned().notNullable().references("id").inTable("invoices").onDelete("CASCADE");
        table.float("amount").notNullable();
        table.string("method", 20).notNullable(); // cash, card, bank_transfer, upi, cheque, other
        table.string("paid_on", 10).notNullable();
        table.string("reference", 120).nullable();
        table.string("notes", 300).nullable();
        userFk(table, "recorded_by");
        table.string("created_at", 30).notNullable();
        table.index(["invoice_id"]);
        table.index(["tenant_id", "paid_on"]);
      });

      // ---- Logistics: carriers, fleet, shipments, and their tracking history ----
      await knex.schema.createTable("carriers", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.string("name", 120).notNullable();
        table.string("code", 30).nullable();
        table.string("tracking_url", 300).nullable(); // with {code} where the carrier's tracking number goes
        table.string("phone", 40).nullable();
        table.string("email", 255).nullable();
        table.boolean("is_active").notNullable().defaultTo(true);
        timestamps(table);
        table.unique(["tenant_id", "name"]);
      });

      await knex.schema.createTable("vehicles", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.string("registration", 30).notNullable();
        table.string("type", 20).notNullable().defaultTo("van"); // bike, car, van, truck, other
        table.float("capacity_kg").nullable();
        table.string("status", 20).notNullable().defaultTo("available"); // available, in_use, maintenance, retired
        userFk(table, "driver_id");
        table.string("notes", 300).nullable();
        timestamps(table);
        table.unique(["tenant_id", "registration"]);
        table.index(["tenant_id", "status"]);
      });

      await knex.schema.createTable("shipments", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.string("number", 30).notNullable(); // SHP-0001, per tenant
        table.string("tracking_code", 24).notNullable().unique(); // random; customers track with it
        table.string("direction", 10).notNullable().defaultTo("outbound"); // outbound, inbound, transfer
        table.string("status", 20).notNullable().defaultTo("pending"); // pending, picked_up, in_transit, out_for_delivery, delivered, failed, returned, cancelled
        table.string("service", 12).notNullable().defaultTo("standard"); // standard, express, same_day
        table.integer("carrier_id").unsigned().nullable().references("id").inTable("carriers").onDelete("SET NULL");
        table.string("carrier_reference", 60).nullable(); // the carrier's own tracking number
        table.integer("vehicle_id").unsigned().nullable().references("id").inTable("vehicles").onDelete("SET NULL");
        userFk(table, "driver_id");
        table.integer("order_id").unsigned().nullable().references("id").inTable("orders").onDelete("SET NULL");
        table.integer("customer_id").unsigned().nullable().references("id").inTable("customers").onDelete("SET NULL");
        table.string("sender_name", 160).nullable();
        table.string("sender_address", 500).nullable();
        table.string("recipient_name", 160).notNullable();
        table.string("recipient_phone", 40).nullable();
        table.string("recipient_address", 500).notNullable();
        table.string("origin_city", 80).nullable();
        table.string("destination_city", 80).nullable();
        table.integer("packages").notNullable().defaultTo(1);
        table.float("weight_kg").nullable();
        table.float("declared_value").nullable();
        table.float("shipping_cost").nullable();
        table.float("cod_amount").nullable(); // cash to collect on delivery
        table.string("ship_date", 10).nullable();
        table.string("expected_on", 10).nullable();
        table.string("delivered_at", 30).nullable();
        table.string("received_by", 120).nullable(); // proof of delivery
        table.text("notes").nullable();
        userFk(table, "created_by");
        timestamps(table);
        table.unique(["tenant_id", "number"]);
        table.index(["tenant_id", "status"]);
        table.index(["tenant_id", "expected_on"]);
        table.index(["driver_id", "status"]);
        table.index(["order_id"]);
      });

      await knex.schema.createTable("shipment_events", table => {
        table.increments("id").primary();
        table.integer("shipment_id").unsigned().notNullable().references("id").inTable("shipments").onDelete("CASCADE");
        table.string("status", 20).notNullable();
        table.string("location", 120).nullable();
        table.string("note", 300).nullable();
        userFk(table, "actor_id");
        table.string("occurred_at", 30).notNullable();
        table.index(["shipment_id", "occurred_at"]);
      });

      // ---- Clinic: practitioners, patients, appointments, visits, prescriptions ----
      await knex.schema.createTable("clinic_providers", table => {
        table.integer("user_id").unsigned().primary().references("id").inTable("users").onDelete("CASCADE");
        tenantFk(table);
        table.string("specialty", 80).notNullable();
        table.string("qualification", 120).nullable();
        table.string("registration_no", 60).nullable();
        table.integer("slot_minutes").notNullable().defaultTo(15);
        table.float("consultation_fee").nullable();
        table.string("room", 40).nullable();
        table.text("schedule").notNullable(); // JSON: { "1": [["09:00","13:00"],["14:00","18:00"]], ... } weekday -> ranges
        table.boolean("is_accepting").notNullable().defaultTo(true);
        table.string("color", 20).notNullable().defaultTo("teal");
        timestamps(table);
        table.index(["tenant_id"]);
      });

      await knex.schema.createTable("patients", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.string("mrn", 30).notNullable(); // medical record number, per tenant
        table.string("first_name", 80).notNullable();
        table.string("last_name", 80).nullable();
        table.string("date_of_birth", 10).nullable();
        table.string("gender", 12).nullable(); // female, male, other, unknown
        table.string("phone", 40).nullable();
        table.string("email", 255).nullable();
        table.string("address", 500).nullable();
        table.string("blood_group", 5).nullable();
        table.string("allergies", 500).nullable();
        table.string("chronic_conditions", 500).nullable();
        table.string("emergency_contact_name", 120).nullable();
        table.string("emergency_contact_phone", 40).nullable();
        table.string("insurance_provider", 120).nullable();
        table.string("insurance_number", 60).nullable();
        table.text("notes").nullable();
        table.boolean("is_active").notNullable().defaultTo(true);
        userFk(table, "created_by");
        timestamps(table);
        table.unique(["tenant_id", "mrn"]);
        table.index(["tenant_id", "first_name"]);
        table.index(["tenant_id", "phone"]);
      });

      await knex.schema.createTable("appointments", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.integer("patient_id").unsigned().notNullable().references("id").inTable("patients").onDelete("CASCADE");
        userFk(table, "provider_id", "CASCADE");
        table.string("start_at", 16).notNullable(); // clinic-local "YYYY-MM-DDTHH:MM"
        table.string("end_at", 16).notNullable();
        table.string("type", 20).notNullable().defaultTo("consultation");
        table.string("status", 20).notNullable().defaultTo("scheduled"); // scheduled, confirmed, checked_in, in_progress, completed, cancelled, no_show
        table.string("reason", 300).nullable();
        table.string("notes", 1000).nullable();
        table.string("cancel_reason", 300).nullable();
        table.string("checked_in_at", 30).nullable();
        table.string("completed_at", 30).nullable();
        userFk(table, "created_by");
        timestamps(table);
        table.index(["tenant_id", "start_at"]);
        table.index(["provider_id", "start_at"]);
        table.index(["patient_id", "start_at"]);
        table.index(["tenant_id", "status"]);
      });

      await knex.schema.createTable("clinic_visits", table => {
        table.increments("id").primary();
        tenantFk(table);
        table.integer("appointment_id").unsigned().nullable().unique().references("id").inTable("appointments").onDelete("SET NULL");
        table.integer("patient_id").unsigned().notNullable().references("id").inTable("patients").onDelete("CASCADE");
        userFk(table, "provider_id");
        table.string("visit_date", 10).notNullable();
        table.string("chief_complaint", 500).nullable();
        table.text("vitals").nullable(); // JSON: bp, pulse, temperature, weight, height, spo2, respiratoryRate
        table.text("examination").nullable();
        table.string("diagnosis", 500).nullable();
        table.text("plan").nullable();
        table.string("follow_up_on", 10).nullable();
        timestamps(table);
        table.index(["patient_id", "visit_date"]);
        table.index(["tenant_id", "visit_date"]);
      });

      await knex.schema.createTable("prescriptions", table => {
        table.increments("id").primary();
        table.integer("visit_id").unsigned().notNullable().references("id").inTable("clinic_visits").onDelete("CASCADE");
        table.integer("position").notNullable().defaultTo(0);
        table.string("medicine", 160).notNullable();
        table.string("dosage", 60).nullable(); // 500 mg
        table.string("frequency", 60).nullable(); // 1-0-1, twice a day
        table.string("duration", 60).nullable(); // 5 days
        table.string("route", 30).nullable(); // oral, topical, ...
        table.string("instructions", 300).nullable(); // after food
        table.index(["visit_id", "position"]);
      });

      if (knex.client.dialect !== "sqlite3") {
        const checks = [
          ["invoices", "invoices_kind_check", "kind in ('invoice','quote')"],
          ["invoices", "invoices_status_check", "status in ('draft','sent','partially_paid','paid','void','accepted','declined','converted')"],
          ["invoice_payments", "invoice_payments_amount_check", "amount > 0"],
          ["shipments", "shipments_status_check", "status in ('pending','picked_up','in_transit','out_for_delivery','delivered','failed','returned','cancelled')"],
          ["appointments", "appointments_status_check", "status in ('scheduled','confirmed','checked_in','in_progress','completed','cancelled','no_show')"],
          ["appointments", "appointments_time_check", "end_at > start_at"],
        ];
        for (const [table, name, condition] of checks) await knex.raw(`alter table ?? add constraint ?? check (${condition})`, [table, name]);
      }

      // ---- New permissions go to every tenant's Admin role ----
      const added = [
        "billing.view", "billing.edit", "billing.issue", "billing.payments.record", "billing.delete",
        "logistics.view", "logistics.edit", "logistics.dispatch", "logistics.deliver", "logistics.fleet.manage",
        "clinic.schedule.view", "clinic.appointments.manage", "clinic.patients.manage", "clinic.practitioner", "clinic.records.view", "clinic.providers.manage",
      ];
      for (const role of await knex("roles").where({ key: "admin" })) {
        const permissions = new Set([...JSON.parse(role.permissions || "[]"), ...added]);
        await knex("roles").where({ id: role.id }).update({ permissions: JSON.stringify([...permissions]), updated_at: now });
      }
      const forMembers = ["billing.view", "logistics.view", "logistics.deliver", "clinic.schedule.view"];
      for (const role of await knex("roles").whereIn("key", ["member", "agent"])) {
        const permissions = new Set([...JSON.parse(role.permissions || "[]"), ...forMembers]);
        await knex("roles").where({ id: role.id }).update({ permissions: JSON.stringify([...permissions]), updated_at: now });
      }
    },

    async down(knex) {
      for (const table of ["prescriptions", "clinic_visits", "appointments", "patients", "clinic_providers", "shipment_events", "shipments", "vehicles", "carriers", "invoice_payments", "invoice_items", "invoices"]) {
        await knex.schema.dropTableIfExists(table);
      }
    },
  },

  "009_password_resets_clinic_tokens": {
    async up(knex) {
      // ---- Password resets: people ask from the sign-in page; an admin issues a one-time link ----
      await knex.schema.createTable("password_resets", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("status", 12).notNullable().defaultTo("requested"); // requested, issued, used, dismissed, expired
        table.string("token_hash", 64).nullable().unique(); // sha256 of the link token; the token itself is never stored
        table.string("requested_ip", 64).nullable();
        table.string("requested_at", 30).nullable(); // null when an admin created the link without a request
        table.integer("issued_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("issued_at", 30).nullable();
        table.string("expires_at", 30).nullable();
        table.string("used_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.index(["tenant_id", "status"]);
        table.index(["user_id", "status"]);
      });

      // ---- Clinic tokens: a queue number per practitioner per day, given at check-in ----
      await knex.schema.alterTable("appointments", table => {
        table.string("token_date", 10).nullable(); // the clinic day the token belongs to
        table.integer("token_number").nullable();
        table.string("called_at", 30).nullable(); // last time the doctor called this token
        table.integer("call_count").notNullable().defaultTo(0);
        table.string("public_code", 16).nullable(); // lets the patient follow their token without signing in
      });
      await knex.schema.alterTable("appointments", table => {
        table.unique(["provider_id", "token_date", "token_number"]);
        table.unique(["public_code"]);
        table.index(["tenant_id", "token_date"]);
      });
    },

    async down(knex) {
      await knex.schema.alterTable("appointments", table => {
        table.dropUnique(["provider_id", "token_date", "token_number"]);
        table.dropUnique(["public_code"]);
        table.dropIndex(["tenant_id", "token_date"]);
      });
      await knex.schema.alterTable("appointments", table => {
        for (const column of ["token_date", "token_number", "called_at", "call_count", "public_code"]) table.dropColumn(column);
      });
      await knex.schema.dropTableIfExists("password_resets");
    },
  },

  "010_password_changed_at": {
    // Sign-in sessions issued before a password change stop working (see requireAuth).
    async up(knex) {
      await knex.schema.alterTable("users", table => {
        table.string("password_changed_at", 30).nullable();
      });
    },
    async down(knex) {
      await knex.schema.alterTable("users", table => table.dropColumn("password_changed_at"));
    },
  },

  "011_notes_announcement_audience": {
    async up(knex) {
      const now = new Date().toISOString();
      // ---- Notes: sticky notes, private by default, shared with people or the whole workspace ----
      await knex.schema.createTable("notes", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("owner_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("title", 160).notNullable().defaultTo("");
        table.text("body").notNullable().defaultTo("");
        table.string("color", 20).notNullable().defaultTo("yellow");
        table.boolean("pinned").notNullable().defaultTo(false);
        table.string("share_all", 10).notNullable().defaultTo("none"); // none, view, edit: access for everyone in the workspace
        table.integer("version").notNullable().defaultTo(1); // bumps on every edit; saves send the version they started from
        table.integer("last_edited_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
        table.string("archived_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["tenant_id", "owner_id"]);
        table.index(["tenant_id", "updated_at"]);
      });
      await knex.schema.createTable("note_shares", table => {
        table.integer("note_id").unsigned().notNullable().references("id").inTable("notes").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("access", 10).notNullable().defaultTo("view"); // view, edit
        table.string("created_at", 30).notNullable();
        table.primary(["note_id", "user_id"]);
        table.index(["user_id"]);
      });

      // ---- Announcements: everyone, or only people holding chosen roles ----
      await knex.schema.alterTable("announcements", table => {
        table.string("audience", 10).notNullable().defaultTo("all"); // all, roles
      });
      await knex.schema.createTable("announcement_roles", table => {
        table.integer("announcement_id").unsigned().notNullable().references("id").inTable("announcements").onDelete("CASCADE");
        table.integer("role_id").unsigned().notNullable().references("id").inTable("roles").onDelete("CASCADE");
        table.primary(["announcement_id", "role_id"]);
        table.index(["role_id"]);
      });

      // ---- New permissions: admins get all, members can use notes ----
      for (const role of await knex("roles").whereIn("key", ["admin", "agent", "member"])) {
        const permissions = new Set(JSON.parse(role.permissions || "[]"));
        permissions.add("notes.use");
        if (role.key === "admin") permissions.add("notes.manage");
        await knex("roles").where({ id: role.id }).update({ permissions: JSON.stringify([...permissions]), updated_at: now });
      }
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("announcement_roles");
      await knex.schema.alterTable("announcements", table => table.dropColumn("audience"));
      await knex.schema.dropTableIfExists("note_shares");
      await knex.schema.dropTableIfExists("notes");
    },
  },

  "012_lifecycle_broadcasts_tenant_emails_boards": {
    async up(knex) {
      // ---- Tenant lifecycle: soft delete (restorable until the provider deletes it for good) and subscriptions ----
      await knex.schema.alterTable("tenants", table => {
        table.string("deleted_at", 30).nullable(); // set = in the recycle bin: nobody can sign in, data kept
        table.string("deleted_by", 120).nullable(); // console username
        table.string("plan", 40).notNullable().defaultTo("standard");
        table.string("subscription_starts_on", 10).nullable();
        table.string("subscription_ends_on", 10).nullable(); // null = no end date
        table.integer("grace_days").notNullable().defaultTo(7); // after the end date, before access stops
        table.index(["status"]);
        table.index(["deleted_at"]);
        table.index(["subscription_ends_on"]);
      });

      // ---- Provider broadcasts: console announcements to every tenant, chosen tenants, or individual admins ----
      await knex.schema.createTable("provider_broadcasts", table => {
        table.increments("id").primary();
        table.string("kind", 20).notNullable().defaultTo("announcement"); // announcement, maintenance, subscription
        table.string("severity", 10).notNullable().defaultTo("info"); // info, warning, critical
        table.string("title", 160).notNullable();
        table.text("body").notNullable();
        table.string("audience", 10).notNullable().defaultTo("all"); // all (every tenant), tenants, users
        table.string("recipients", 10).notNullable().defaultTo("admins"); // within a tenant: admins, everyone
        table.string("created_by", 120).nullable();
        table.string("publish_at", 30).notNullable();
        table.string("expires_at", 30).nullable();
        table.string("retracted_at", 30).nullable();
        table.string("created_at", 30).notNullable();
        table.string("updated_at", 30).notNullable();
        table.index(["publish_at"]);
      });
      await knex.schema.createTable("provider_broadcast_targets", table => {
        table.increments("id").primary();
        table.integer("broadcast_id").unsigned().notNullable().references("id").inTable("provider_broadcasts").onDelete("CASCADE");
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.integer("user_id").unsigned().nullable().references("id").inTable("users").onDelete("CASCADE"); // null = the whole tenant (per `recipients`)
        table.index(["broadcast_id"]);
        table.index(["tenant_id"]);
        table.index(["user_id"]);
      });
      await knex.schema.createTable("provider_broadcast_reads", table => {
        table.integer("broadcast_id").unsigned().notNullable().references("id").inTable("provider_broadcasts").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.string("read_at", 30).notNullable();
        table.boolean("dismissed").notNullable().defaultTo(false);
        table.primary(["broadcast_id", "user_id"]);
      });
      // Automatic "your subscription ends in N days" notices: one per tenant, threshold, and end date.
      await knex.schema.createTable("subscription_notices", table => {
        table.increments("id").primary();
        table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
        table.string("ends_on", 10).notNullable();
        table.string("threshold", 10).notNullable(); // d30, d14, d7, d3, d1, d0, expired
        table.integer("broadcast_id").unsigned().nullable().references("id").inTable("provider_broadcasts").onDelete("SET NULL");
        table.string("created_at", 30).notNullable();
        table.unique(["tenant_id", "ends_on", "threshold"]);
      });

      // ---- Email addresses are unique per workspace, not across all workspaces ----
      await knex.schema.alterTable("users", table => {
        table.dropUnique(["email"]);
      });
      await knex.schema.alterTable("users", table => {
        table.unique(["tenant_id", "email"]);
        table.index(["email"]);
      });

      // ---- Sticky-note boards: each person arranges notes on their own board ----
      await knex.schema.alterTable("notes", table => {
        table.string("font", 20).notNullable().defaultTo("caveat"); // caveat, patrick, kalam, marker, sans
        table.string("text_size", 4).notNullable().defaultTo("md"); // sm, md, lg, xl
      });
      await knex.schema.createTable("note_positions", table => {
        table.integer("note_id").unsigned().notNullable().references("id").inTable("notes").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
        table.integer("x").notNullable().defaultTo(0);
        table.integer("y").notNullable().defaultTo(0);
        table.integer("width").notNullable().defaultTo(240);
        table.integer("height").notNullable().defaultTo(220);
        table.integer("z").notNullable().defaultTo(0);
        table.float("rotation").notNullable().defaultTo(0); // degrees, small tilt for the paper look
        table.string("updated_at", 30).notNullable();
        table.primary(["note_id", "user_id"]);
        table.index(["user_id"]);
      });
      await knex.schema.createTable("note_boards", table => {
        table.integer("user_id").unsigned().primary().references("id").inTable("users").onDelete("CASCADE");
        table.string("background", 20).notNullable().defaultTo("cork"); // cork, whiteboard, chalkboard, grid, dots, plain
        table.boolean("snap_to_grid").notNullable().defaultTo(false);
        table.float("zoom").notNullable().defaultTo(1);
        table.string("updated_at", 30).notNullable();
      });
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("note_boards");
      await knex.schema.dropTableIfExists("note_positions");
      await knex.schema.alterTable("notes", table => {
        table.dropColumn("font");
        table.dropColumn("text_size");
      });
      await knex.schema.alterTable("users", table => {
        table.dropUnique(["tenant_id", "email"]);
        table.dropIndex(["email"]);
        table.unique(["email"]);
      });
      for (const name of ["subscription_notices", "provider_broadcast_reads", "provider_broadcast_targets", "provider_broadcasts"]) await knex.schema.dropTableIfExists(name);
      await knex.schema.alterTable("tenants", table => {
        for (const column of ["deleted_at", "deleted_by", "plan", "subscription_starts_on", "subscription_ends_on", "grace_days"]) table.dropColumn(column);
      });
    },
  },

  // Per-workspace sign-ins: when each person last signed in, and "sign out everywhere" by an admin. Fresh installs
  // no longer start with a workspace: the provider creates every tenant in the console, so the "Default workspace"
  // that 004 seeds is removed when nobody uses it (existing installs keep theirs: it has accounts).
  "013_sessions_fresh_install": {
    async up(knex) {
      await knex.schema.alterTable("users", table => {
        table.string("last_login_at", 30).nullable();
        table.string("sessions_revoked_at", 30).nullable();
      });
      const fallback = await knex("tenants").where({ slug: "default" }).first();
      if (fallback && !(await knex("users").where({ tenant_id: fallback.id }).first("id"))) {
        await knex("tenants").where({ id: fallback.id }).del(); // roles and other tenant rows cascade
      }
    },

    async down(knex) {
      await knex.schema.alterTable("users", table => {
        table.dropColumn("last_login_at");
        table.dropColumn("sessions_revoked_at");
      });
    },
  },

  // Maintenance windows set by the provider: one platform-wide (platform_settings, key "maintenance") and one per
  // tenant (tenants.maintenance). Both are JSON; see services/maintenance.js.
  "014_maintenance": {
    async up(knex) {
      await knex.schema.createTable("platform_settings", table => {
        table.string("key", 60).primary();
        table.text("value").notNullable();
        table.string("updated_at", 30).notNullable();
      });
      await knex.schema.alterTable("tenants", table => table.text("maintenance").nullable());
    },

    async down(knex) {
      await knex.schema.alterTable("tenants", table => table.dropColumn("maintenance"));
      await knex.schema.dropTableIfExists("platform_settings");
    },
  },

  // The industry a tenant belongs to (services/moduleCatalog.js): which modules it may be licensed for. Null means
  // "custom" (any module), which keeps every existing tenant exactly as it is.
  "016_tenant_industry": {
    async up(knex) {
      if (!(await knex.schema.hasColumn("tenants", "industry"))) {
        await knex.schema.alterTable("tenants", table => table.string("industry", 20).nullable());
      }
    },

    async down(knex) {
      if (await knex.schema.hasColumn("tenants", "industry")) await knex.schema.alterTable("tenants", table => table.dropColumn("industry"));
    },
  },

  // Clinic: the patient portal (patient number + PIN, routes/patientPortal.js), ages entered without a birthday
  // (an estimated date of birth), vitals a nurse records before the doctor (triage), the "Record vitals" permission
  // for admins, and the clinic's starter roles (Doctor, Nurse, Receptionist) for workspaces licensed for it.
  // Additive only: new nullable columns and new rows.
  "017_clinic_patient_portal": {
    async up(knex) {
      const now = new Date().toISOString();
      const addColumns = async (tableName, columns) => {
        const added = [];
        for (const [column, define] of Object.entries(columns)) {
          if (await knex.schema.hasColumn(tableName, column)) continue;
          await knex.schema.alterTable(tableName, table => define(table));
          added.push(column);
        }
        return added;
      };

      const patientColumns = await addColumns("patients", {
        dob_estimated: table => table.boolean("dob_estimated").nullable().defaultTo(false), // date_of_birth was worked out from an age
        portal_number: table => table.string("portal_number", 12).nullable(), // portal sign-in id: 8 random digits, unique per tenant
        portal_pin_hash: table => table.string("portal_pin_hash", 100).nullable(), // bcrypt; the PIN itself is never stored
        portal_pin_set_at: table => table.string("portal_pin_set_at", 30).nullable(), // portal sessions from before this are void
        portal_failed_attempts: table => table.integer("portal_failed_attempts").nullable().defaultTo(0),
        portal_locked_until: table => table.string("portal_locked_until", 30).nullable(),
        portal_last_login_at: table => table.string("portal_last_login_at", 30).nullable(),
      });
      if (patientColumns.includes("portal_number")) {
        await knex.schema.alterTable("patients", table => table.unique(["tenant_id", "portal_number"]));
      }

      await addColumns("appointments", {
        triage_vitals: table => table.text("triage_vitals").nullable(), // JSON, same shape as clinic_visits.vitals
        triage_complaint: table => table.string("triage_complaint", 500).nullable(),
        triage_by: table => table.integer("triage_by").nullable(), // users.id of whoever recorded it
        triage_at: table => table.string("triage_at", 30).nullable(),
      });

      for (const role of await knex("roles").where({ key: "admin" })) {
        const permissions = new Set(JSON.parse(role.permissions || "[]"));
        if (permissions.has("clinic.vitals.record")) continue;
        permissions.add("clinic.vitals.record");
        await knex("roles").where({ id: role.id }).update({ permissions: JSON.stringify([...permissions]), updated_at: now });
      }

      const { ensureModuleRoles } = await import("../services/permissions.js");
      for (const tenant of await knex("tenants").select("id", "features")) {
        let features = [];
        try {
          features = JSON.parse(tenant.features || "[]");
        } catch {
          features = [];
        }
        if (Array.isArray(features) && features.includes("clinic")) await ensureModuleRoles(knex, tenant.id, features, now);
      }
    },

    async down(knex) {
      if (await knex.schema.hasColumn("patients", "portal_number")) await knex.schema.alterTable("patients", table => table.dropUnique(["tenant_id", "portal_number"]));
      for (const [tableName, columns] of [
        ["patients", ["dob_estimated", "portal_number", "portal_pin_hash", "portal_pin_set_at", "portal_failed_attempts", "portal_locked_until", "portal_last_login_at"]],
        ["appointments", ["triage_vitals", "triage_complaint", "triage_by", "triage_at"]],
      ]) {
        for (const column of columns) {
          if (await knex.schema.hasColumn(tableName, column)) await knex.schema.alterTable(tableName, table => table.dropColumn(column));
        }
      }
    },
  },

  // Dedicated tenant databases (services/tenantDatabases.js): the connection a tenant's data lives in, as JSON with the
  // password encrypted. Null keeps the tenant in this (the platform) database, which is every existing tenant.
  "018_tenant_database": {
    async up(knex) {
      if (!(await knex.schema.hasColumn("tenants", "database"))) {
        await knex.schema.alterTable("tenants", table => table.text("database").nullable());
      }
    },

    async down(knex) {
      if (await knex.schema.hasColumn("tenants", "database")) await knex.schema.alterTable("tenants", table => table.dropColumn("database"));
    },
  },

  // Access rules (services/permissions.js): access given to or capped for chosen people on top of their roles, per
  // module level (none / read / write / manage) or a custom list, optionally between two dates.
  "019_access_rules": {
    async up(knex) {
      if (!(await knex.schema.hasTable("access_rules"))) {
        await knex.schema.createTable("access_rules", table => {
          table.increments("id").primary();
          table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
          table.string("name", 80).notNullable();
          table.string("description", 300).nullable();
          table.string("mode", 10).notNullable().defaultTo("grant"); // grant | limit
          table.text("levels").notNullable(); // JSON { module: none | read | write | manage | custom }
          table.text("permissions").nullable(); // JSON [keys] for modules set to custom
          table.string("starts_on", 10).nullable(); // YYYY-MM-DD, inclusive
          table.string("ends_on", 10).nullable();
          table.boolean("is_active").notNullable().defaultTo(true);
          table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
          table.string("created_at", 30).notNullable();
          table.string("updated_at", 30).notNullable();
          table.unique(["tenant_id", "name"]);
          table.index(["tenant_id", "is_active"]);
        });
      }
      if (!(await knex.schema.hasTable("access_rule_users"))) {
        await knex.schema.createTable("access_rule_users", table => {
          table.integer("rule_id").unsigned().notNullable().references("id").inTable("access_rules").onDelete("CASCADE");
          table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
          table.string("created_at", 30).notNullable();
          table.primary(["rule_id", "user_id"]);
          table.index(["user_id"]);
        });
      }
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("access_rule_users");
      await knex.schema.dropTableIfExists("access_rules");
    },
  },

  // Workspace meetings: Google Meet, Zoom, Microsoft Teams, and custom URL meetings with
  // 5-minute reminder alerts, sound notifications, and attendee tracking.
  "020_meetings": {
    async up(knex) {
      if (!(await knex.schema.hasTable("meetings"))) {
        await knex.schema.createTable("meetings", table => {
          table.increments("id").primary();
          table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
          table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
          table.string("title", 200).notNullable();
          table.text("description").nullable();
          table.string("platform", 30).notNullable().defaultTo("google_meet"); // google_meet, zoom, teams, custom
          table.string("url", 1000).notNullable();
          table.string("start_at", 30).notNullable(); // ISO UTC string
          table.string("end_at", 30).nullable(); // ISO UTC string
          table.integer("reminder_minutes").notNullable().defaultTo(5);
          table.boolean("reminder_sent").notNullable().defaultTo(false);
          table.boolean("is_instant").notNullable().defaultTo(false);
          table.string("created_at", 30).notNullable();
          table.string("updated_at", 30).notNullable();
          table.index(["tenant_id", "start_at"]);
          table.index(["reminder_sent", "start_at"]);
        });
      }
      if (!(await knex.schema.hasTable("meeting_participants"))) {
        await knex.schema.createTable("meeting_participants", table => {
          table.integer("meeting_id").unsigned().notNullable().references("id").inTable("meetings").onDelete("CASCADE");
          table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
          table.string("created_at", 30).notNullable();
          table.primary(["meeting_id", "user_id"]);
          table.index(["user_id"]);
        });
      }
      const hasMeetingCol = await knex.schema.hasColumn("notifications", "meeting_id");
      if (!hasMeetingCol) {
        await knex.schema.alterTable("notifications", table => {
          table.integer("meeting_id").unsigned().nullable();
        });
      }
      if (knex.client.dialect === "postgresql" || knex.client.dialect === "sqlite3") {
        await knex.raw("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at)");
      }
    },

    async down(knex) {
      if (knex.client.dialect === "postgresql" || knex.client.dialect === "sqlite3") {
        await knex.raw("DROP INDEX IF EXISTS idx_notifications_user_created");
      }
      await knex.schema.dropTableIfExists("meeting_participants");
      await knex.schema.dropTableIfExists("meetings");
      if (await knex.schema.hasColumn("notifications", "meeting_id")) {
        await knex.schema.alterTable("notifications", table => table.dropColumn("meeting_id"));
      }
    },
  },

  // Tenant security access codes / PINs: random unique codes managed by tenant admins,
  // used for user creation and direct tenant login, looked up via a common platform table.
  "021_tenant_access_codes": {
    async up(knex) {
      if (!(await knex.schema.hasTable("tenant_access_codes"))) {
        await knex.schema.createTable("tenant_access_codes", table => {
          table.increments("id").primary();
          table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenants").onDelete("CASCADE");
          table.string("tenant_name", 120).notNullable();
          table.string("tenant_slug", 60).notNullable();
          table.string("code", 32).notNullable().unique();
          table.string("name", 80).notNullable().defaultTo("Tenant Security PIN");
          table.string("type", 30).notNullable().defaultTo("login_pin"); // login_pin | registration | general
          table.string("description", 255).nullable();
          table.boolean("is_active").notNullable().defaultTo(true);
          table.boolean("is_deleted").notNullable().defaultTo(false); // Soft delete: true or false only
          table.integer("usage_count").notNullable().defaultTo(0);
          table.integer("max_uses").nullable(); // null = unlimited
          table.string("expires_at", 30).nullable(); // ISO string, null = never
          table.string("last_used_at", 30).nullable();
          table.integer("created_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
          table.string("created_at", 30).notNullable();
          table.string("updated_at", 30).notNullable();
          table.index(["code", "is_deleted", "is_active"]);
          table.index(["tenant_id", "is_deleted"]);
          table.index(["tenant_slug"]);
        });
      }

      // Seed an active security PIN for existing tenants that do not have one yet
      if (await knex.schema.hasTable("tenants")) {
        const tenants = await knex("tenants").select("id", "name", "slug");
        const now = new Date().toISOString();
        for (const t of tenants) {
          const existing = await knex("tenant_access_codes").where({ tenant_id: t.id, is_deleted: false }).first();
          if (!existing) {
            const randomSuffix = Math.floor(100000 + Math.random() * 900000);
            await knex("tenant_access_codes").insert({
              tenant_id: t.id,
              tenant_name: t.name,
              tenant_slug: t.slug,
              code: `TF-${randomSuffix}`,
              name: "Default Security PIN",
              type: "login_pin",
              is_active: true,
              is_deleted: false,
              usage_count: 0,
              created_at: now,
              updated_at: now,
            });
          }
        }
      }
    },

    async down(knex) {
      await knex.schema.dropTableIfExists("tenant_access_codes");
    },
  },

  "022_user_login_codes": {
    async up(knex) {
      if (await knex.schema.hasTable("users")) {
        const hasColumn = await knex.schema.hasColumn("users", "login_code");
        if (!hasColumn) {
          await knex.schema.alterTable("users", table => {
            table.string("login_code", 32).nullable();
            table.index(["login_code"]);
          });
        }

        // Backfill existing users with unique login codes
        const users = await knex("users").select("id", "login_code");
        const usedCodes = new Set(users.map(u => u.login_code).filter(Boolean));
        for (const user of users) {
          if (!user.login_code) {
            let code;
            do {
              const num = Math.floor(100000 + Math.random() * 900000);
              code = `TF-${num}`;
            } while (usedCodes.has(code));
            usedCodes.add(code);
            await knex("users").where({ id: user.id }).update({ login_code: code });
          }
        }
      }
    },

    async down(knex) {
      if (await knex.schema.hasTable("users")) {
        const hasColumn = await knex.schema.hasColumn("users", "login_code");
        if (hasColumn) {
          await knex.schema.alterTable("users", table => {
            table.dropColumn("login_code");
          });
        }
      }
    },
  },

  "023_access_codes_and_sessions": {
    async up(knex) {
      // 1. Add is_code_login_enabled to users
      if (await knex.schema.hasTable("users")) {
        const hasCodeLoginEnabled = await knex.schema.hasColumn("users", "is_code_login_enabled");
        if (!hasCodeLoginEnabled) {
          await knex.schema.alterTable("users", table => {
            table.boolean("is_code_login_enabled").notNullable().defaultTo(true);
          });
        }
      }

      // 2. Add user_id to tenant_access_codes and backfill
      if (await knex.schema.hasTable("tenant_access_codes")) {
        const hasUserId = await knex.schema.hasColumn("tenant_access_codes", "user_id");
        if (!hasUserId) {
          await knex.schema.alterTable("tenant_access_codes", table => {
            table.integer("user_id").unsigned().nullable();
            table.index(["user_id"]);
          });
        }

        // Backfill any existing users into tenant_access_codes
        if (await knex.schema.hasTable("users") && await knex.schema.hasTable("tenants")) {
          const users = await knex("users as u")
            .join("tenants as t", "t.id", "u.tenant_id")
            .select("u.id", "u.name", "u.login_code", "u.tenant_id", "u.created_at", "t.name as tenant_name", "t.slug as tenant_slug");
          
          const now = new Date().toISOString();
          for (const user of users) {
            if (user.login_code) {
              const existing = await knex("tenant_access_codes").where({ code: user.login_code }).first();
              if (!existing) {
                await knex("tenant_access_codes").insert({
                  tenant_id: user.tenant_id,
                  user_id: user.id,
                  tenant_name: user.tenant_name,
                  tenant_slug: user.tenant_slug,
                  code: user.login_code,
                  name: `${user.name} Login Code`,
                  type: "user_login",
                  is_active: true,
                  is_deleted: false,
                  usage_count: 0,
                  created_at: user.created_at || now,
                  updated_at: now,
                });
              } else if (!existing.user_id) {
                await knex("tenant_access_codes").where({ id: existing.id }).update({
                  user_id: user.id,
                  type: "user_login",
                  updated_at: now,
                });
              }
            }
          }
        }
      }

      // 3. Create user_sessions table for active session limit tracking
      if (!(await knex.schema.hasTable("user_sessions"))) {
        await knex.schema.createTable("user_sessions", table => {
          table.increments("id").primary();
          table.integer("tenant_id").unsigned().notNullable();
          table.integer("user_id").unsigned().notNullable();
          table.string("session_id", 64).notNullable().unique();
          table.string("ip_address", 64).nullable();
          table.string("user_agent", 255).nullable();
          table.string("created_at", 30).notNullable();
          table.string("last_seen_at", 30).notNullable();
          table.string("expires_at", 30).notNullable();
          table.index(["user_id", "expires_at"]);
          table.index(["tenant_id"]);
          table.index(["session_id"]);
        });
      }

      // 4. Add is_tenant_admin to password_resets
      if (await knex.schema.hasTable("password_resets")) {
        const hasCol = await knex.schema.hasColumn("password_resets", "is_tenant_admin");
        if (!hasCol) {
          await knex.schema.alterTable("password_resets", table => {
            table.boolean("is_tenant_admin").notNullable().defaultTo(false);
            table.index(["is_tenant_admin", "status"]);
          });
        }
      }
    },

    async down(knex) {
      if (await knex.schema.hasTable("password_resets")) {
        const hasCol = await knex.schema.hasColumn("password_resets", "is_tenant_admin");
        if (hasCol) {
          await knex.schema.alterTable("password_resets", table => {
            table.dropColumn("is_tenant_admin");
          });
        }
      }

      if (await knex.schema.hasTable("user_sessions")) {
        await knex.schema.dropTableIfExists("user_sessions");
      }

      if (await knex.schema.hasTable("tenant_access_codes")) {
        const hasUserId = await knex.schema.hasColumn("tenant_access_codes", "user_id");
        if (hasUserId) {
          await knex.schema.alterTable("tenant_access_codes", table => {
            table.dropColumn("user_id");
          });
        }
      }

      if (await knex.schema.hasTable("users")) {
        const hasCodeLoginEnabled = await knex.schema.hasColumn("users", "is_code_login_enabled");
        if (hasCodeLoginEnabled) {
          await knex.schema.alterTable("users", table => {
            table.dropColumn("is_code_login_enabled");
          });
        }
      }
    },
  },
};

/** In-code migration source: no migration files or ESM loader quirks. */
export const migrationSource = {
  getMigrations: async () => Object.keys(migrations).sort(),
  getMigrationName: name => name,
  getMigration: name => migrations[name],
};
