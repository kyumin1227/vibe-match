// Lambda 함수명 예: chemistry-room-create-room
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - POST /rooms

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 2; // 48시간

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

exports.handler = async () => {
  let attempts = 0;

  while (attempts < 5) {
    const code = generateCode();
    const createdAt = Math.floor(Date.now() / 1000);
    const hostToken = crypto.randomUUID();

    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `ROOM#${code}`,
            SK: "META",
            status: "OPEN",
            hostToken,
            createdAt,
            ttl: createdAt + ROOM_TTL_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return respond(200, { code, hostToken });
    } catch (e) {
      if (e.name === "ConditionalCheckFailedException") {
        attempts += 1;
        continue;
      }
      console.error(e);
      return respond(500, { error: "방을 생성하지 못했습니다." });
    }
  }

  return respond(500, { error: "방 코드 생성에 반복적으로 실패했습니다. 다시 시도해주세요." });
};
