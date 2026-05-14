/**
 * Supabase-compatible query builder backed by node-postgres.
 *
 * Implements the subset of the Supabase JS client used in this codebase:
 * .from(table).select().eq().neq().in().is().or().filter().order().limit().single().maybeSingle()
 * .from(table).insert().select().single()
 * .from(table).update().eq().select().single()
 * .from(table).delete().eq()
 * .from(table).upsert(data, { onConflict, ignoreDuplicates })
 *
 * Returns { data, error } matching the Supabase response shape.
 */

import pg from "pg";

const { Pool } = pg;

type QueryResult<T = Record<string, unknown>> = {
    data: T | T[] | null;
    error: Error | null;
};

type OrderOpts = { ascending?: boolean; nullsFirst?: boolean };
type UpsertOpts = { onConflict?: string; ignoreDuplicates?: boolean };

class QueryBuilder {
    private pool: pg.Pool;
    private schema: string;
    private table: string;
    private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    private selectColumns = "*";
    private conditions: { sql: string; values: unknown[] }[] = [];
    private orderClauses: string[] = [];
    private limitCount: number | null = null;
    private returnSingle = false;
    private returnMaybeSingle = false;
    private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
    private upsertOpts: UpsertOpts = {};
    private returningCols: string | null = null;
    private paramIndex = 0;

    constructor(pool: pg.Pool, schema: string, table: string) {
        this.pool = pool;
        this.schema = schema;
        this.table = table;
    }

    private nextParam(): string {
        this.paramIndex++;
        return `$${this.paramIndex}`;
    }

    private qualifiedTable(): string {
        return `"${this.schema}"."${this.table}"`;
    }

    select(columns = "*"): this {
        if (this.op === "insert" || this.op === "update" || this.op === "upsert") {
            this.returningCols = columns;
        } else {
            this.op = "select";
            this.selectColumns = columns;
            this.returningCols = columns;
        }
        return this;
    }

    insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
        this.op = "insert";
        this.payload = data;
        return this;
    }

    update(data: Record<string, unknown>): this {
        this.op = "update";
        this.payload = data;
        return this;
    }

    delete(): this {
        this.op = "delete";
        return this;
    }

    upsert(
        data: Record<string, unknown> | Record<string, unknown>[],
        opts?: UpsertOpts,
    ): this {
        this.op = "upsert";
        this.payload = data;
        this.upsertOpts = opts ?? {};
        return this;
    }

    eq(column: string, value: unknown): this {
        const p = this.nextParam();
        this.conditions.push({ sql: `"${column}" = ${p}`, values: [value] });
        return this;
    }

    neq(column: string, value: unknown): this {
        const p = this.nextParam();
        this.conditions.push({ sql: `"${column}" != ${p}`, values: [value] });
        return this;
    }

    in(column: string, values: unknown[]): this {
        if (values.length === 0) {
            this.conditions.push({ sql: "FALSE", values: [] });
            return this;
        }
        const placeholders = values.map(() => this.nextParam());
        this.conditions.push({
            sql: `"${column}" IN (${placeholders.join(", ")})`,
            values,
        });
        return this;
    }

    is(column: string, value: null | boolean): this {
        if (value === null) {
            this.conditions.push({ sql: `"${column}" IS NULL`, values: [] });
        } else {
            this.conditions.push({
                sql: `"${column}" IS ${value ? "TRUE" : "FALSE"}`,
                values: [],
            });
        }
        return this;
    }

    or(filterStr: string): this {
        const parsed = this.parseOrFilter(filterStr);
        if (parsed) {
            this.conditions.push(parsed);
        }
        return this;
    }

    not(column: string, operator: string, value: unknown): this {
        if (operator === "is" && value === null) {
            this.conditions.push({ sql: `"${column}" IS NOT NULL`, values: [] });
        } else if (operator === "eq") {
            return this.neq(column, value);
        } else {
            const p = this.nextParam();
            this.conditions.push({ sql: `NOT ("${column}" = ${p})`, values: [value] });
        }
        return this;
    }

    filter(column: string, operator: string, value: unknown): this {
        if (operator === "cs") {
            const p = this.nextParam();
            this.conditions.push({
                sql: `"${column}" @> ${p}::jsonb`,
                values: [value],
            });
        } else if (operator === "eq") {
            return this.eq(column, value);
        } else if (operator === "neq") {
            return this.neq(column, value);
        }
        return this;
    }

    order(column: string, opts?: OrderOpts): this {
        const dir = opts?.ascending === false ? "DESC" : "ASC";
        const nulls = opts?.nullsFirst === true ? "NULLS FIRST" : opts?.nullsFirst === false ? "NULLS LAST" : "";
        this.orderClauses.push(`"${column}" ${dir}${nulls ? ` ${nulls}` : ""}`);
        return this;
    }

    limit(count: number): this {
        this.limitCount = count;
        return this;
    }

    single(): this {
        this.returnSingle = true;
        this.limitCount = 1;
        return this;
    }

    maybeSingle(): this {
        this.returnMaybeSingle = true;
        this.limitCount = 1;
        return this;
    }

    async then<TResult1 = QueryResult, TResult2 = never>(
        resolve?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        try {
            const result = await this.execute();
            return resolve ? resolve(result) : (result as unknown as TResult1);
        } catch (err) {
            if (reject) return reject(err);
            throw err;
        }
    }

    private async execute(): Promise<QueryResult> {
        try {
            switch (this.op) {
                case "select":
                    return await this.execSelect();
                case "insert":
                    return await this.execInsert();
                case "update":
                    return await this.execUpdate();
                case "delete":
                    return await this.execDelete();
                case "upsert":
                    return await this.execUpsert();
                default:
                    return { data: null, error: new Error(`Unknown op: ${this.op}`) };
            }
        } catch (err) {
            return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
        }
    }

    private collectParams(): unknown[] {
        return this.conditions.flatMap((c) => c.values);
    }

    private whereClause(): string {
        if (this.conditions.length === 0) return "";
        return " WHERE " + this.conditions.map((c) => c.sql).join(" AND ");
    }

    private buildReturning(): string {
        if (!this.returningCols) return "";
        const cols = this.returningCols === "*" ? "*" : this.returningCols.split(",").map((c) => `"${c.trim()}"`).join(", ");
        return ` RETURNING ${cols}`;
    }

    private formatResult(rows: Record<string, unknown>[]): QueryResult {
        if (this.returnSingle) {
            if (rows.length === 0) {
                return { data: null, error: new Error("Row not found") };
            }
            return { data: rows[0], error: null };
        }
        if (this.returnMaybeSingle) {
            return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
    }

    private async execSelect(): Promise<QueryResult> {
        const cols = this.selectColumns === "*" ? "*" : this.selectColumns.split(",").map((c) => `"${c.trim()}"`).join(", ");
        let sql = `SELECT ${cols} FROM ${this.qualifiedTable()}`;
        sql += this.whereClause();
        if (this.orderClauses.length) sql += ` ORDER BY ${this.orderClauses.join(", ")}`;
        if (this.limitCount !== null) sql += ` LIMIT ${this.limitCount}`;

        const result = await this.pool.query(sql, this.collectParams());
        return this.formatResult(result.rows);
    }

    private async execInsert(): Promise<QueryResult> {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
        if (rows.length === 0) return { data: [], error: null };

        const columns = Object.keys(rows[0]);
        const colList = columns.map((c) => `"${c}"`).join(", ");

        this.paramIndex = 0;
        const valueSets: string[] = [];
        const allValues: unknown[] = [];

        for (const row of rows) {
            const placeholders = columns.map(() => this.nextParam());
            valueSets.push(`(${placeholders.join(", ")})`);
            for (const col of columns) {
                allValues.push(row[col] !== undefined ? row[col] : null);
            }
        }

        let sql = `INSERT INTO ${this.qualifiedTable()} (${colList}) VALUES ${valueSets.join(", ")}`;
        if (this.returningCols) {
            const retCols = this.returningCols === "*" ? "*" : this.returningCols.split(",").map((c) => `"${c.trim()}"`).join(", ");
            sql += ` RETURNING ${retCols}`;
        }

        const result = await this.pool.query(sql, allValues);
        return this.formatResult(result.rows);
    }

    private async execUpdate(): Promise<QueryResult> {
        const data = this.payload as Record<string, unknown>;
        const columns = Object.keys(data);
        const allValues: unknown[] = [];

        let idx = 1;
        const setClauses = columns.map((col) => {
            allValues.push(data[col]);
            return `"${col}" = $${idx++}`;
        });

        const whereParts: string[] = [];
        for (const cond of this.conditions) {
            const rewritten = cond.sql.replace(/\$\d+/g, () => `$${idx++}`);
            whereParts.push(rewritten);
            allValues.push(...cond.values);
        }

        let sql = `UPDATE ${this.qualifiedTable()} SET ${setClauses.join(", ")}`;
        if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
        if (this.returningCols) {
            const retCols = this.returningCols === "*" ? "*" : this.returningCols.split(",").map((c) => `"${c.trim()}"`).join(", ");
            sql += ` RETURNING ${retCols}`;
        }

        const result = await this.pool.query(sql, allValues);
        return this.formatResult(result.rows);
    }

    private async execDelete(): Promise<QueryResult> {
        let sql = `DELETE FROM ${this.qualifiedTable()}`;
        sql += this.whereClause();
        if (this.returningCols) {
            sql += this.buildReturning();
        }

        const result = await this.pool.query(sql, this.collectParams());
        return { data: result.rows, error: null };
    }

    private async execUpsert(): Promise<QueryResult> {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
        if (rows.length === 0) return { data: [], error: null };

        const columns = Object.keys(rows[0]);
        const colList = columns.map((c) => `"${c}"`).join(", ");

        this.paramIndex = 0;
        const valueSets: string[] = [];
        const allValues: unknown[] = [];

        for (const row of rows) {
            const placeholders = columns.map(() => this.nextParam());
            valueSets.push(`(${placeholders.join(", ")})`);
            for (const col of columns) {
                allValues.push(row[col] !== undefined ? row[col] : null);
            }
        }

        const conflictCols = this.upsertOpts.onConflict ?? "id";
        const conflictTarget = conflictCols.split(",").map((c) => `"${c.trim()}"`).join(", ");

        let sql = `INSERT INTO ${this.qualifiedTable()} (${colList}) VALUES ${valueSets.join(", ")}`;
        sql += ` ON CONFLICT (${conflictTarget})`;

        if (this.upsertOpts.ignoreDuplicates) {
            sql += " DO NOTHING";
        } else {
            const updateCols = columns.filter(
                (c) => !conflictCols.split(",").map((x) => x.trim()).includes(c),
            );
            if (updateCols.length > 0) {
                sql += ` DO UPDATE SET ${updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")}`;
            } else {
                sql += " DO NOTHING";
            }
        }

        if (this.returningCols) {
            const retCols = this.returningCols === "*" ? "*" : this.returningCols.split(",").map((c) => `"${c.trim()}"`).join(", ");
            sql += ` RETURNING ${retCols}`;
        }

        const result = await this.pool.query(sql, allValues);
        return this.formatResult(result.rows);
    }

    private parseOrFilter(filterStr: string): { sql: string; values: unknown[] } | null {
        // Parses Supabase-style OR filter strings like:
        // "user_id.eq.abc,project_id.in.(id1,id2)"
        const parts = this.splitOrParts(filterStr);
        const clauses: string[] = [];
        const values: unknown[] = [];

        for (const part of parts) {
            const eqMatch = part.match(/^(\w+)\.eq\.(.+)$/);
            if (eqMatch) {
                const p = this.nextParam();
                clauses.push(`"${eqMatch[1]}" = ${p}`);
                values.push(eqMatch[2]);
                continue;
            }
            const inMatch = part.match(/^(\w+)\.in\.\((.+)\)$/);
            if (inMatch) {
                const inValues = inMatch[2].split(",");
                const placeholders = inValues.map(() => this.nextParam());
                clauses.push(`"${inMatch[1]}" IN (${placeholders.join(", ")})`);
                values.push(...inValues);
                continue;
            }
            const neqMatch = part.match(/^(\w+)\.neq\.(.+)$/);
            if (neqMatch) {
                const p = this.nextParam();
                clauses.push(`"${neqMatch[1]}" != ${p}`);
                values.push(neqMatch[2]);
                continue;
            }
        }

        if (clauses.length === 0) return null;
        return { sql: `(${clauses.join(" OR ")})`, values };
    }

    private splitOrParts(filterStr: string): string[] {
        const parts: string[] = [];
        let current = "";
        let depth = 0;
        for (const ch of filterStr) {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth === 0) {
                parts.push(current.trim());
                current = "";
            } else {
                current += ch;
            }
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
    }
}

export interface PgClient {
    from(table: string): QueryBuilder;
    auth: {
        admin: {
            getUser(token: string): Promise<{ data: { user: { id: string; email?: string } | null } }>;
            deleteUser(id: string): Promise<{ error: Error | null }>;
            listUsers(): Promise<{ data: { users: { id: string; email?: string }[] } }>;
        };
    };
}

export function createPgClient(connectionString: string, schema = "public"): PgClient {
    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes("sslmode=require") || connectionString.includes("azure")
            ? { rejectUnauthorized: false }
            : undefined,
    });

    // Set search_path on each new connection
    pool.on("connect", (client) => {
        client.query(`SET search_path TO "${schema}", public`);
    });

    return {
        from(table: string): QueryBuilder {
            return new QueryBuilder(pool, schema, table);
        },
        auth: {
            admin: {
                async getUser(token: string) {
                    // Auth still goes through Supabase — this is a passthrough
                    const { createClient } = await import("@supabase/supabase-js");
                    const url = process.env.SUPABASE_URL || "";
                    const key = process.env.SUPABASE_SECRET_KEY || "";
                    const admin = createClient(url, key, { auth: { persistSession: false } });
                    return admin.auth.getUser(token);
                },
                async deleteUser(id: string) {
                    const { createClient } = await import("@supabase/supabase-js");
                    const url = process.env.SUPABASE_URL || "";
                    const key = process.env.SUPABASE_SECRET_KEY || "";
                    const admin = createClient(url, key, { auth: { persistSession: false } });
                    const { error } = await admin.auth.admin.deleteUser(id);
                    return { error };
                },
                async listUsers() {
                    const { createClient } = await import("@supabase/supabase-js");
                    const url = process.env.SUPABASE_URL || "";
                    const key = process.env.SUPABASE_SECRET_KEY || "";
                    const admin = createClient(url, key, { auth: { persistSession: false } });
                    const { data } = await admin.auth.admin.listUsers();
                    return { data: { users: data.users.map((u) => ({ id: u.id, email: u.email })) } };
                },
            },
        },
    };
}
