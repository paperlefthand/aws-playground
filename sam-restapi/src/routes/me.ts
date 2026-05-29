import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { err, ok } from "../responses.js";
import type { Principal } from "../auth.js";
import type { components } from "../types.js";

type Schemas = components["schemas"];
type Cart = Schemas["Cart"];
type Notification = Schemas["Notification"];
type Order = Schemas["Order"];
type OrderStatus = Schemas["OrderStatus"];
type Post = Schemas["Post"];
type UpdateNotificationRequest = Schemas["UpdateNotificationRequest"];
type UpdateProfileRequest = Schemas["UpdateProfileRequest"];
type UserProfile = Schemas["UserProfile"];

const requireAuth = (p: Principal | null): APIGatewayProxyResult | null =>
  p ? null : err(401, "unauthorized", "Authentication required");

const sampleProfile = (userId: string): UserProfile => ({
  userId,
  bio: "Hello, I'm a stub.",
  avatarUrl: `https://example.com/avatar/${userId}.png`,
});

export const getProfile = (
  _event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  return ok(sampleProfile(principal!.userId));
};

export const updateProfile = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  let body: UpdateProfileRequest;
  try {
    body = JSON.parse(event.body ?? "{}") as UpdateProfileRequest;
  } catch {
    return err(400, "bad_request", "Invalid JSON body");
  }
  return ok({
    ...sampleProfile(principal!.userId),
    ...(body.bio !== undefined ? { bio: body.bio } : {}),
    ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
  });
};

export const listNotifications = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  const unreadOnly = event.queryStringParameters?.unreadOnly === "true";
  const all: Notification[] = [
    { id: "n-1", message: "Welcome", read: false, createdAt: "2026-01-01T00:00:00Z" },
    { id: "n-2", message: "Update", read: true, createdAt: "2026-01-02T00:00:00Z" },
  ];
  return ok(unreadOnly ? all.filter((n) => !n.read) : all);
};

export const updateNotification = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
  notificationId: string,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  let body: UpdateNotificationRequest;
  try {
    body = JSON.parse(event.body ?? "{}") as UpdateNotificationRequest;
  } catch {
    return err(400, "bad_request", "Invalid JSON body");
  }
  const out: Notification = {
    id: notificationId,
    message: "Stub notification",
    read: !!body.read,
    createdAt: "2026-01-01T00:00:00Z",
  };
  return ok(out);
};

export const listOrders = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  const status = event.queryStringParameters?.status as OrderStatus | undefined;
  const orders: Order[] = [
    {
      id: "o-1",
      userId: principal!.userId,
      total: 10.0,
      currency: "JPY",
      status: "paid",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  return ok(status ? orders.filter((o) => o.status === status) : orders);
};

export const getCart = (
  _event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  const cart: Cart = { items: [{ productId: "p-1", quantity: 2 }] };
  return ok(cart);
};

export const listMyPosts = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAuth(principal);
  if (guard) return guard;
  const includeDrafts = event.queryStringParameters?.includeDrafts === "true";
  const all: Post[] = [
    {
      id: "p-1",
      authorId: principal!.userId,
      title: "Published",
      content: "stub",
      status: "published",
      publishedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "p-2",
      authorId: principal!.userId,
      title: "Draft",
      content: "stub",
      status: "draft",
    },
  ];
  return ok(includeDrafts ? all : all.filter((p) => p.status === "published"));
};
