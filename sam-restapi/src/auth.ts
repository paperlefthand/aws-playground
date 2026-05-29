import type { APIGatewayProxyEvent } from "aws-lambda";
import type { components } from "./types.js";

type Role = components["schemas"]["Role"];

export interface Principal {
  userId: string;
  role: Role;
}

export const extractPrincipal = (event: APIGatewayProxyEvent): Principal | null => {
  const header =
    event.headers?.Authorization ?? event.headers?.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const token = match[1];

  // Stub: token format `userId:role` (e.g. "u-1:admin"). Real impl would verify JWT.
  const [userId, role] = token.split(":");
  if (!userId || (role !== "admin" && role !== "member")) {
    return { userId: token, role: "member" };
  }
  return { userId, role: role as Role };
};
