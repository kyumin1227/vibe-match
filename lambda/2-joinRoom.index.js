// Lambda 함수명 예: chemistry-room-join-room
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - POST /rooms/{code}/join

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 2;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}

const ADJECTIVES = [
  "조용한",
  "씩씩한",
  "느긋한",
  "반짝이는",
  "엉뚱한",
  "다정한",
  "차분한",
  "용감한",
  "포근한",
  "경쾌한",
];
const NOUNS = ["너구리", "은하수", "파도", "고양이", "민들레", "폭풍", "반딧불", "고래", "여우", "구름"];
function randomCodename() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  if (!code) return respond(400, { error: "code가 필요합니다." });

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "META" } }));
  if (!room.Item) return respond(404, { error: "존재하지 않는 방 코드입니다." });
  if (room.Item.status !== "OPEN") return respond(409, { error: "이미 마감된 방입니다." });

  const participantId = crypto.randomUUID();
  const codename = randomCodename();
  const ttl = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: `ROOM#${code}`, SK: `PARTICIPANT#${participantId}`, codename, answers: null, scores: null, ttl },
    }),
  );

  return respond(200, { participantId, codename });
};
