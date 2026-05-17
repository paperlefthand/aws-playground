import type { APIGatewayProxyResult } from "aws-lambda";

export const ok = (body: unknown, statusCode = 200): APIGatewayProxyResult => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const noContent = (): APIGatewayProxyResult => ({
  statusCode: 204,
  headers: {},
  body: "",
});

export const err = (
  statusCode: number,
  code: string,
  message: string,
): APIGatewayProxyResult => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, message }),
});
