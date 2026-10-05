/** Student account fields retained by the existing users.json format. */
export interface User {
  /** Stable account identity; older JSON records acquire one during import. */
  id?: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: number;
}
