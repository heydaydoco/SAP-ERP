/** Authenticated principal — the access-token payload and `request.user` shape. */
export interface AuthUser {
  /** app_user.id */
  sub: string;
  username: string;
  roles: string[];
  /** Granted permission codes (`domain:subject:action`, or `*`). */
  permissions: string[];
}
