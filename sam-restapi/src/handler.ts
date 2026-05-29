import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { route } from "./router.js";

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  return route(event);
};
