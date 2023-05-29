import json
import boto3
import os

TABLE_NAME = os.environ["TABLE_NAME"]
AWS_REGION = os.environ["AWS_REGION"]

dynamodb_config = {"region_name": AWS_REGION}
dynamodb = boto3.resource("dynamodb", **dynamodb_config)
table = dynamodb.Table(TABLE_NAME)


def add_vehiclet(event, context):
    """Sample pure Lambda function

    Parameters
    ----------
    event: dict, required
        API Gateway Lambda Proxy Input Format

        Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format

    context: object, required
        Lambda Context runtime methods and attributes

        Context doc: https://docs.aws.amazon.com/lambda/latest/dg/python-context-object.html

    Returns
    ------
    API Gateway Lambda Proxy Output Format: dict

        Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
    """

    print(event, context)

    try:
        user_id = event["pathParameters"]["userId"]

        vehicle_data = json.loads(event["body"])
        vehicle_data["userId"] = user_id
        table.put_item(Item=vehicle_data)

        return {
            "statusCode": 201,
            "body": json.dumps({"message": "Vehicle added successfully"}),
        }

    except Exception as e:
        print(e)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "Internal Server Error"}),
        }
