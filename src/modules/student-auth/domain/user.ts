/** Student account fields retained by the existing users.json format. */
export interface User {
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: number;
}
