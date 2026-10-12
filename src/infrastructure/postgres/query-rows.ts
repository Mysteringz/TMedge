/** TypeORM's PostgreSQL driver wraps rows from DML `RETURNING` in [rows, rowCount]. */
export function queryRows<Row>(result: unknown): Row[] {
  if (!Array.isArray(result)) throw new TypeError('PostgreSQL query did not return a row list.');
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as Row[];
  }
  return result as Row[];
}
