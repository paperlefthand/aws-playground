import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { err, noContent, ok } from "../responses.js";
import type { Principal } from "../auth.js";
import type {
  Post,
  UpdateRoleRequest,
  User,
  UserList,
} from "../types.js";

const sampleUser = (userId: string, role: User["role"] = "member"): User => ({
  userId,
  name: `User ${userId}`,
  email: `${userId}@example.com`,
  role,
  createdAt: "2026-01-01T00:00:00Z",
});

const requireAdmin = (p: Principal | null): APIGatewayProxyResult | null => {
  if (!p) return err(401, "unauthorized", "Authentication required");
  if (p.role !== "admin") return err(403, "forbidden", "Admin role required");
  return null;
};

export const listUsers = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
): APIGatewayProxyResult => {
  const guard = requireAdmin(principal);
  if (guard) return guard;
  const limit = Number(event.queryStringParameters?.limit ?? 10);
  const body: UserList = {
    items: [sampleUser("u-1", "admin"), sampleUser("u-2")].slice(0, limit),
  };
  return ok(body);
};

export const readUser = (
  _event: APIGatewayProxyEvent,
  principal: Principal | null,
  userId: string,
): APIGatewayProxyResult => {
  if (!principal) return err(401, "unauthorized", "Authentication required");
  if (principal.role !== "admin" && principal.userId !== userId) {
    return err(403, "forbidden", "Cannot read other users");
  }
  return ok(sampleUser(userId));
};

export const updateRole = (
  event: APIGatewayProxyEvent,
  principal: Principal | null,
  userId: string,
): APIGatewayProxyResult => {
  const guard = requireAdmin(principal);
  if (guard) return guard;
  let body: UpdateRoleRequest;
  try {
    body = JSON.parse(event.body ?? "{}") as UpdateRoleRequest;
  } catch {
    return err(400, "bad_request", "Invalid JSON body");
  }
  if (body.role !== "admin" && body.role !== "member") {
    return err(400, "bad_request", "role must be admin or member");
  }
  return ok(sampleUser(userId, body.role));
};

export const removeUser = (
  _event: APIGatewayProxyEvent,
  principal: Principal | null,
  _userId: string,
): APIGatewayProxyResult => {
  const guard = requireAdmin(principal);
  if (guard) return guard;
  return noContent();
};

export const listPosts = (
  _event: APIGatewayProxyEvent,
  _principal: Principal | null,
  userId: string,
): APIGatewayProxyResult => {
  const posts: Post[] = [
    {
      id: "p-1",
      authorId: userId,
      title: "Hello",
      content: "stub",
      status: "published",
      publishedAt: "2026-01-02T00:00:00Z",
    },
  ];
  return ok(posts);
};

export const listFollowers = (
  _event: APIGatewayProxyEvent,
  _principal: Principal | null,
  _userId: string,
): APIGatewayProxyResult => {
  return ok([sampleUser("u-2"), sampleUser("u-3")]);
};
