// Lambda 함수명 예: chemistry-room-join-room
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - POST /rooms/{code}/join
// body(선택): { "nickname": "내가 짓고 싶은 별명" }  ← 비우면 자동 생성

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 2;
const MAX_NICKNAME_LENGTH = 12;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}

// 방 하나에 최대 50명 정도 들어올 수 있으므로 조합 수를 넉넉히 늘렸다 (30 x 30 = 900가지).
// 자동 생성 이름은 일본어로 만든다.
const ADJECTIVES = [
  "静かな",
  "元気な",
  "のんびりな",
  "きらきらの",
  "変わった",
  "優しい",
  "落ち着いた",
  "勇敢な",
  "ぽかぽかの",
  "陽気な",
  "眠たい",
  "気ままな",
  "まっすぐな",
  "賢い",
  "陽だまりの",
  "風変わりな",
  "大胆な",
  "穏やかな",
  "好奇心旺盛な",
  "気まぐれな",
  "天真爛漫な",
  "しっかりした",
  "夢見がちな",
  "軽やかな",
  "温かい",
  "明るい",
  "素直な",
  "律儀な",
  "まろやかな",
  "涼しげな",
];
const NOUNS = [
  "たぬき",
  "天の川",
  "波",
  "猫",
  "たんぽぽ",
  "嵐",
  "ほたる",
  "くじら",
  "きつね",
  "雲",
  "ふくろう",
  "さくら",
  "流れ星",
  "うさぎ",
  "小川",
  "月",
  "虹",
  "かもめ",
  "雪だるま",
  "とんぼ",
  "桃",
  "梅",
  "竹",
  "星",
  "波紋",
  "稲妻",
  "こいぬ",
  "こねこ",
  "ひまわり",
  "山桜",
];
function randomCodename() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}${n}`;
}

// 앞뒤 공백 제거, 길이 제한, 빈 문자열이면 null 반환
function sanitizeNickname(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NICKNAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

// 이 방에 이미 존재하는 codename 목록 조회
async function getExistingCodenames(code) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `ROOM#${code}`, ":prefix": "PARTICIPANT#" },
      ProjectionExpression: "codename",
    }),
  );
  return new Set((result.Items || []).map((i) => i.codename));
}

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  if (!code) return respond(400, { error: "code가 필요합니다." });

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    /* noop */
  }

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "META" } }));
  if (!room.Item) return respond(404, { error: "존재하지 않는 방 코드입니다." });
  if (room.Item.status !== "OPEN") return respond(409, { error: "이미 마감된 방입니다." });

  const existing = await getExistingCodenames(code);
  const wanted = sanitizeNickname(body.nickname);

  let codename;
  if (wanted) {
    // 사용자가 입력한 별명 사용, 중복되면 숫자를 붙여서 구분
    if (!existing.has(wanted)) {
      codename = wanted;
    } else {
      let n = 2;
      while (existing.has(`${wanted}${n}`)) n += 1;
      codename = `${wanted}${n}`;
    }
  } else {
    // 입력 없으면 자동 생성, 중복되면 다시 뽑기 (최대 10번 시도)
    let attempts = 0;
    do {
      codename = randomCodename();
      attempts += 1;
    } while (existing.has(codename) && attempts < 10);
  }

  const participantId = crypto.randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: `ROOM#${code}`, SK: `PARTICIPANT#${participantId}`, codename, answers: null, scores: null, ttl },
    }),
  );

  return respond(200, { participantId, codename });
};
