import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const SRC = "openapi/openapi.yaml";
const DST = "openapi/openapi-aws.yaml";

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const integration = {
  type: "aws_proxy",
  httpMethod: "POST",
  uri: {
    "Fn::Sub":
      "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${UserServiceFunction.Arn}/invocations",
  },
  payloadFormatVersion: "1.0",
};

const cognitoAuthorizer = {
  type: "apiKey",
  name: "Authorization",
  in: "header",
  "x-amazon-apigateway-authtype": "cognito_user_pools",
  "x-amazon-apigateway-authorizer": {
    type: "cognito_user_pools",
    providerARNs: [{ "Fn::Sub": "${CognitoUserPool.Arn}" }],
  },
};

const doc = yaml.load(fs.readFileSync(SRC, "utf8"));

for (const pathItem of Object.values(doc.paths ?? {})) {
  for (const [key, op] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(key)) continue;
    op["x-amazon-apigateway-integration"] = integration;
    // Normalize per-operation security overrides for API Gateway:
    //   - TypeSpec emits NoAuth as `security: [{}]`; API Gateway expects `security: []`.
    //   - Any BearerAuth reference is remapped to CognitoAuth.
    if (Array.isArray(op.security)) {
      const mapped = op.security
        .map((entry) =>
          entry && "BearerAuth" in entry ? { CognitoAuth: entry.BearerAuth } : entry,
        )
        .filter((entry) => entry && Object.keys(entry).length > 0);
      op.security = mapped;
    }
  }
}

// Replace OpenAPI HTTP Bearer scheme with a Cognito User Pool authorizer.
// TypeSpec emits the global `security: [BearerAuth: []]`; per-operation
// `security: []` (NoAuth) is preserved as-is to keep public endpoints open.
doc.components = doc.components ?? {};
doc.components.securitySchemes = { CognitoAuth: cognitoAuthorizer };
doc.security = [{ CognitoAuth: [] }];

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, yaml.dump(doc, { lineWidth: 200, noRefs: true }));

console.log(`wrote ${DST}`);
