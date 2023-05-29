import json
import boto3
import os

TABLE_NAME = os.environ["TABLE_NAME"]
AWS_REGION = os.environ["AWS_REGION"]

dynamodb_config = {"region_name": AWS_REGION}
dynamodb = boto3.resource("dynamodb", **dynamodb_config)
table = dynamodb.Table(TABLE_NAME)


def get_vehiclet(event, context):
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
    # return {
    #     "statusCode": 200,
    #     "body": json.dumps(event),
    # }

    try:
        user_id = event["pathParameters"]["userId"]
        
        # 単一アイテムの取得
        # response = table.get_item(Key={"userId": user_id})
        # vehicles = response.get("Item")

        response = table.query(KeyConditionExpression="userId = :userId",
                               ExpressionAttributeValues={":userId": user_id})
        vehicles = response.get("Items")

        # 複数ページへのクエリ実行
        while "LastEvaluatedKey" in response:
            response = table.query(
                KeyConditionExpression="userId = :userId",
                ExpressionAttributeValues={":userId": user_id},
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            vehicles.extend(response["Items"])

        if vehicles:
            return {"statusCode": 200, "body": json.dumps(vehicles)}
        else:
            return {
                "statusCode": 404,
                "body": json.dumps({"message": "Vehicle not found"}),
            }

    except Exception as e:
        print(e)
        return {
            "statusCode": 500,
            "body": json.dumps({"message": "Internal Server Error"}),
        }
    

