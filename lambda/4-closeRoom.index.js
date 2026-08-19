// Lambda 함수명 예: chemistry-room-close-room
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - POST /rooms/{code}/close
// 주의: 이 함수는 배치 계산이라 Timeout을 30초 정도로 넉넉히 설정하세요.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 2;
const TOP_N = 3; // 닮은꼴 상위 몇 명을 보여줄지

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(body) };
}

const TRAIT_ORDER = ['E', 'A', 'C', 'N', 'O'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 특성별로 다른 궁합 규칙을 적용한다 (단순 유사도가 아니라 MBTI 궁합 느낌의 상호보완 반영).
function traitScore(trait, a, b) {
  const diff = Math.abs(a - b);

  if (trait === 'A' || trait === 'C' || trait === 'O') {
    // 우호성/성실성/개방성: 비슷할수록 좋음 (생활 방식·가치관 마찰이 적음)
    return 100 - diff;
  }

  if (trait === 'E') {
    // 외향성: 적당히 다른 쪽이 오히려 좋음 (한쪽이 이끌고 한쪽이 맞춰주는 조합)
    const idealDiff = 35;
    const penaltyFactor = 0.8;
    return clamp(100 - Math.abs(diff - idealDiff) * penaltyFactor, 0, 100);
  }

  // N(신경증): 둘 다 낮을수록 좋고, 한쪽만 높아도 감점, 둘 다 높으면 크게 감점
  const avgStability = 100 - (a + b) / 2;
  const gapPenalty = diff * 0.3;
  return clamp(avgStability - gapPenalty, 0, 100);
}

function compatibility(scoresA, scoresB) {
  const total = TRAIT_ORDER.reduce((sum, tr) => sum + traitScore(tr, scoresA[tr], scoresB[tr]), 0);
  return Math.round(total / TRAIT_ORDER.length);
}

function rankMatches(target, others, topN) {
  const ranked = others
    .filter((o) => o.participantId !== target.participantId)
    .map((o) => ({ participantId: o.participantId, codename: o.codename, similarity: compatibility(target.scores, o.scores) }))
    .sort((a, b) => b.similarity - a.similarity);

  const topMatches = ranked.slice(0, topN);
  const opposite = ranked.length > 0 ? ranked[ranked.length - 1] : null;
  return { topMatches, opposite };
}

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* noop */ }
  const { hostToken } = body;

  if (!code || !hostToken) return respond(400, { error: 'code, hostToken이 필요합니다.' });

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: 'META' } }));
  if (!room.Item) return respond(404, { error: '존재하지 않는 방 코드입니다.' });
  if (room.Item.hostToken !== hostToken) return respond(403, { error: '방장만 마감할 수 있습니다.' });
  if (room.Item.status !== 'OPEN') return respond(409, { error: '이미 마감된 방입니다.' });

  const queryResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `ROOM#${code}` },
    })
  );

  const participants = (queryResult.Items || [])
    .filter((item) => item.SK.startsWith('PARTICIPANT#') && item.scores)
    .map((item) => ({ participantId: item.SK.replace('PARTICIPANT#', ''), codename: item.codename, scores: item.scores }));

  if (participants.length < 2) {
    return respond(400, { error: '매칭을 계산하려면 검사를 완료한 참가자가 최소 2명 필요합니다.' });
  }

  const ttl = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  const resultItems = participants.map((target) => {
    const { topMatches, opposite } = rankMatches(target, participants, TOP_N);
    return {
      PutRequest: {
        Item: { PK: `ROOM#${code}`, SK: `RESULT#${target.participantId}`, topMatches, opposite, ttl },
      },
    };
  });

  for (let i = 0; i < resultItems.length; i += 25) {
    const chunk = resultItems.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: chunk } }));
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ROOM#${code}`, SK: 'META' },
      UpdateExpression: 'SET #s = :closed',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':closed': 'CLOSED' },
    })
  );

  return respond(200, { ok: true, participantCount: participants.length });
};
