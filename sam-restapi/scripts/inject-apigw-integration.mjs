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

const doc = yaml.load(fs.readFileSync(SRC, "utf8"));

for (const pathItem of Object.values(doc.paths ?? {})) {
  for (const [key, op] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(key)) continue;
    op["x-amazon-apigateway-integration"] = integration;
  }
}

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, yaml.dump(doc, { lineWidth: 200, noRefs: true }));

console.log(`wrote ${DST}`);
