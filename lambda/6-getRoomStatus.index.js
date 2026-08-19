// Lambda 함수명 예: chemistry-room-get-room-status
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - GET /rooms/{code}/status
// 용도: 방장이 마감(close)하기 전에, 아직 검사를 완료하지 않은 참가자가 있는지 확인

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  if (!code) return respond(400, { error: "code가 필요합니다." });

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "META" } }));
  if (!room.Item) return respond(404, { error: "존재하지 않는 방 코드입니다." });

  const queryResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `ROOM#${code}` },
      ProjectionExpression: "SK, codename, scores",
    }),
  );

  const participants = (queryResult.Items || []).filter((item) => item.SK.startsWith("PARTICIPANT#"));
  const submitted = participants.filter((p) => p.scores);
  const pending = participants.filter((p) => !p.scores).map((p) => p.codename);

  return respond(200, {
    status: room.Item.status,
    total: participants.length,
    submittedCount: submitted.length,
    pendingCount: pending.length,
    pendingCodenames: pending,
  });
};
