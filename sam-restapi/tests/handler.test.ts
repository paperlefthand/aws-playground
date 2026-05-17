import { handler } from "../src/handler.js";
import { mkEvent } from "./helpers.js";

const parse = (body: string | null) => JSON.parse(body ?? "null");

describe("handler", () => {
  describe("authentication", () => {
    it("returns 401 when no Authorization header is present on /me", async () => {
      const res = await handler(mkEvent("GET", "/me"));
      expect(res.statusCode).toBe(401);
      expect(parse(res.body)).toMatchObject({ code: "unauthorized" });
    });

    it("returns 403 when a non-admin calls GET /users", async () => {
      const res = await handler(mkEvent("GET", "/users", { token: "u-1:member" }));
      expect(res.statusCode).toBe(403);
      expect(parse(res.body)).toMatchObject({ code: "forbidden" });
    });
  });

  describe("users routes", () => {
    it("GET /users (admin) returns a UserList", async () => {
      const res = await handler(mkEvent("GET", "/users", { token: "u-1:admin" }));
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it("GET /users/{userId} (self) returns 200", async () => {
      const res = await handler(
        mkEvent("GET", "/users/u-1", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toMatchObject({ userId: "u-1" });
    });

    it("GET /users/{userId} (other, non-admin) returns 403", async () => {
      const res = await handler(
        mkEvent("GET", "/users/u-2", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(403);
    });

    it("PATCH /users/{userId}/role (admin) updates role", async () => {
      const res = await handler(
        mkEvent("PATCH", "/users/u-9/role", {
          token: "u-1:admin",
          body: { role: "admin" },
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toMatchObject({ userId: "u-9", role: "admin" });
    });

    it("DELETE /users/{userId} (admin) returns 204", async () => {
      const res = await handler(
        mkEvent("DELETE", "/users/u-9", { token: "u-1:admin" }),
      );
      expect(res.statusCode).toBe(204);
    });

    it("GET /users/{userId}/posts returns a Post array", async () => {
      const res = await handler(
        mkEvent("GET", "/users/u-1/posts", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(parse(res.body))).toBe(true);
    });
  });

  describe("me routes", () => {
    it("GET /me returns the caller's profile", async () => {
      const res = await handler(mkEvent("GET", "/me", { token: "u-1:member" }));
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toMatchObject({ userId: "u-1" });
    });

    it("PATCH /me updates profile", async () => {
      const res = await handler(
        mkEvent("PATCH", "/me", {
          token: "u-1:member",
          body: { bio: "updated" },
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toMatchObject({ bio: "updated" });
    });

    it("GET /me/notifications?unreadOnly=true filters to unread", async () => {
      const res = await handler(
        mkEvent("GET", "/me/notifications", {
          token: "u-1:member",
          query: { unreadOnly: "true" },
        }),
      );
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(body.every((n: { read: boolean }) => !n.read)).toBe(true);
    });

    it("GET /me/cart returns a Cart", async () => {
      const res = await handler(
        mkEvent("GET", "/me/cart", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toHaveProperty("items");
    });

    it("GET /me/posts without includeDrafts excludes drafts", async () => {
      const res = await handler(
        mkEvent("GET", "/me/posts", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(
        body.every((p: { status: string }) => p.status === "published"),
      ).toBe(true);
    });
  });

  describe("routing edge cases", () => {
    it("returns 404 for an unknown path", async () => {
      const res = await handler(mkEvent("GET", "/nope"));
      expect(res.statusCode).toBe(404);
    });

    it("returns 405 for a defined path with an unsupported method", async () => {
      const res = await handler(
        mkEvent("DELETE", "/me", { token: "u-1:member" }),
      );
      expect(res.statusCode).toBe(405);
    });
  });
});
