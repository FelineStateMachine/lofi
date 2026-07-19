/**
 * Encrypt-by-default tables: `privateTable` seals every column unless the
 * author opts a column out with `plain`, inverting the posture from "encrypt
 * what is sensitive" to "expose what the server needs". Reference columns
 * stay plaintext automatically — a foreign key the server cannot read cannot
 * join or gate — and each sealed column derives its label from the table's
 * prefix, so labels stay unique and stable per column.
 *
 * ```ts
 * notes: s.privateTable("notes", {
 *   body: s.string(),                 // sealed as encryptedText("notes.body")
 *   score: s.int(),                   // sealed as encryptedNumber("notes.score")
 *   at: s.timestamp(),                // sealed as encryptedDate("notes.at")
 *   meta: s.json(),                   // sealed as encryptedJson("notes.meta")
 *   workspaceId: s.ref("workspaces"), // plaintext: foreign keys stay joinable
 *   title: s.plain(s.string()),       // plaintext by author choice: a filter target
 * }),
 * ```
 *
 * @module
 */
import {
  type DefinedTable,
  schema,
  type SqlType,
  type TableDefinition,
  type TypedColumnBuilder,
} from "jazz-tools";
import {
  type EncryptedColumn,
  encryptedColumnLabelOf,
  encryptedDate,
  encryptedJson,
  encryptedNumber,
  encryptedText,
} from "./encrypted.ts";

declare const plainColumnBrand: unique symbol;

/** A column excluded from sealing by the author; see {@link plain}. */
export type PlainColumn<T> = T & { readonly [plainColumnBrand]: true };

const PLAIN_COLUMN = Symbol("lofi.plainColumn");

type AnyBuilder = TypedColumnBuilder<SqlType, boolean, string | undefined, boolean, unknown>;

/**
 * Marks a column of a {@link privateTable} as deliberately plaintext —
 * because it is a filter, sort key, or permission target the server must
 * evaluate. The marker is the visible record of that decision at the column
 * it affects.
 */
export function plain<T extends object>(column: T): PlainColumn<T> {
  Object.defineProperty(column, PLAIN_COLUMN, { value: true });
  return column as PlainColumn<T>;
}

type BuilderInternals = {
  _sqlType: unknown;
  _nullable?: boolean;
  _default?: unknown;
  _mergeStrategy?: string;
  _transform?: unknown;
  _references?: string;
  [PLAIN_COLUMN]?: true;
};

/**
 * The column mapping applied by {@link privateTable}: plain-marked columns,
 * reference columns, and byte columns keep their declared type; every other
 * column becomes an {@link EncryptedColumn} of its view type.
 */
export type PrivateTableColumns<TCols> = {
  [K in keyof TCols]: TCols[K] extends { readonly [plainColumnBrand]: true } ? TCols[K]
    : TCols[K] extends { readonly __jazzReferences: infer R } ? (R extends string ? TCols[K]
        : TCols[K] extends { readonly __jazzSqlType: "BYTEA" } ? TCols[K]
        : TCols[K] extends { readonly __jazzValue: infer V } ? EncryptedColumn<V>
        : never)
    : never;
};

function sealColumn(labelPrefix: string, name: string, builder: unknown): unknown {
  const internals = builder as BuilderInternals;
  if (internals[PLAIN_COLUMN] === true) return builder;
  if (encryptedColumnLabelOf(builder) !== undefined) return builder;
  if (internals._references !== undefined) return builder;
  const label = `${labelPrefix}.${name}`;
  if (internals._nullable === true) {
    throw new TypeError(
      `private table column "${label}" is optional; encrypted columns cannot be optional until ` +
        "the engine's null handling of transformed columns is pinned — mark it s.plain(...) or " +
        "drop .optional()",
    );
  }
  if (internals._default !== undefined) {
    throw new TypeError(
      `private table column "${label}" declares a default; the engine applies defaults below ` +
        "the seal boundary, which would store the default as plaintext — set the value at " +
        "insert time instead",
    );
  }
  if (internals._mergeStrategy !== undefined && internals._mergeStrategy !== "lww") {
    throw new TypeError(
      `private table column "${label}" declares the "${internals._mergeStrategy}" merge ` +
        "strategy, which cannot operate on ciphertext — sealed columns merge last-write-wins",
    );
  }
  if (internals._transform !== undefined) {
    throw new TypeError(
      `private table column "${label}" carries a transform, which sealing would discard — ` +
        "apply the transform in application code around the sealed value, or mark the column " +
        "s.plain(...)",
    );
  }
  const sql = internals._sqlType;
  if (sql === "BYTEA") {
    console.warn(
      `lofi schema: private table column "${label}" holds bytes and stays plaintext — store ` +
        "byte payloads as base64 in an encrypted json column to seal them",
    );
    return builder;
  }
  if (sql === "TEXT") return encryptedText(label);
  if (sql === "INTEGER" || sql === "REAL") return encryptedNumber(label);
  if (sql === "TIMESTAMP") return encryptedDate(label);
  // BOOLEAN, ENUM, JSON, and ARRAY views all round-trip as JSON values.
  return encryptedJson(label);
}

/**
 * Declares a table whose columns are sealed by default. `labelPrefix` is the
 * cryptographic identity prefix of every sealed column (`"prefix.column"`) —
 * treat it like the table name and never reuse it across tables. Columns opt
 * out of sealing only by being reference columns, byte columns (reported),
 * or wrapped in {@link plain}; optionals, defaults, non-lww merge
 * strategies, and transforms on sealed columns are configuration errors.
 */
export function privateTable<const TCols extends Record<string, AnyBuilder>>(
  labelPrefix: string,
  columns: TCols,
): DefinedTable<
  // Resolves to the exact mapped columns for every concrete schema; the
  // fallback branch only exists to satisfy the DefinedTable constraint while
  // the mapping is still generic.
  PrivateTableColumns<TCols> extends TableDefinition ? PrivateTableColumns<TCols> : TableDefinition
> {
  if (!labelPrefix.trim()) {
    throw new TypeError("privateTable requires a non-empty label prefix");
  }
  const sealed: Record<string, unknown> = {};
  for (const [name, builder] of Object.entries(columns)) {
    sealed[name] = sealColumn(labelPrefix, name, builder);
  }
  return schema.table(sealed as never) as unknown as DefinedTable<
    PrivateTableColumns<TCols> extends TableDefinition ? PrivateTableColumns<TCols>
      : TableDefinition
  >;
}
