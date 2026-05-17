import type { APIGatewayProxyEvent } from "aws-lambda";

export interface MkEventOptions {
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  token?: string;
}

export const mkEvent = (
  method: string,
  path: string,
  opts: MkEventOptions = {},
): APIGatewayProxyEvent => {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return {
    httpMethod: method,
    path,
    resource: path,
    headers,
    multiValueHeaders: {},
    queryStringParameters: opts.query ?? null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
};
