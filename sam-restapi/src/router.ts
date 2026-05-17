import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractPrincipal } from "./auth.js";
import { err } from "./responses.js";
import * as users from "./routes/users.js";
import * as me from "./routes/me.js";

type Handler = (
  event: APIGatewayProxyEvent,
  principal: ReturnType<typeof extractPrincipal>,
  params: Record<string, string>,
) => APIGatewayProxyResult | Promise<APIGatewayProxyResult>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const r = (method: string, path: string, handler: Handler): Route => {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/\{([^}]+)\}/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "/?$",
  );
  return { method, pattern, paramNames, handler };
};

const routes: Route[] = [
  r("GET", "/users", (e, p) => users.listUsers(e, p)),
  r("GET", "/users/{userId}", (e, p, params) => users.readUser(e, p, params.userId!)),
  r("PATCH", "/users/{userId}/role", (e, p, params) =>
    users.updateRole(e, p, params.userId!),
  ),
  r("DELETE", "/users/{userId}", (e, p, params) =>
    users.removeUser(e, p, params.userId!),
  ),
  r("GET", "/users/{userId}/posts", (e, p, params) =>
    users.listPosts(e, p, params.userId!),
  ),
  r("GET", "/users/{userId}/followers", (e, p, params) =>
    users.listFollowers(e, p, params.userId!),
  ),

  r("GET", "/me", (e, p) => me.getProfile(e, p)),
  r("PATCH", "/me", (e, p) => me.updateProfile(e, p)),
  r("GET", "/me/notifications", (e, p) => me.listNotifications(e, p)),
  r("PATCH", "/me/notifications/{notificationId}", (e, p, params) =>
    me.updateNotification(e, p, params.notificationId!),
  ),
  r("GET", "/me/orders", (e, p) => me.listOrders(e, p)),
  r("GET", "/me/cart", (e, p) => me.getCart(e, p)),
  r("GET", "/me/posts", (e, p) => me.listMyPosts(e, p)),
];

const normalizePath = (event: APIGatewayProxyEvent): string => {
  const path = event.path ?? "";
  return path.replace(/\/+$/, "") || "/";
};

export const route = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const principal = extractPrincipal(event);
  const path = normalizePath(event);
  const method = event.httpMethod;

  let methodAllowed = false;
  for (const rt of routes) {
    const match = rt.pattern.exec(path);
    if (!match) continue;
    if (rt.method !== method) {
      methodAllowed = true;
      continue;
    }
    const params: Record<string, string> = {};
    rt.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]!);
    });
    return rt.handler(event, principal, params);
  }

  if (methodAllowed) {
    return err(405, "method_not_allowed", `Method ${method} not allowed on ${path}`);
  }
  return err(404, "not_found", `Path ${path} not found`);
};
