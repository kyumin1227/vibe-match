// Lambda 함수명 예: chemistry-room-submit-answers
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - POST /rooms/{code}/answers

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(body) };
}

// 빅파이브 5개 축, 각 6문항 (총 30문항)
const TRAIT_ORDER = ['E', 'A', 'C', 'N', 'O'];
const QUESTIONS_PER_TRAIT = 6;
const TOTAL_QUESTIONS = TRAIT_ORDER.length * QUESTIONS_PER_TRAIT;

function traitOfIndex(i) {
  return TRAIT_ORDER[Math.floor(i / QUESTIONS_PER_TRAIT)];
}

function computeScores(answers) {
  const sums = { E: 0, A: 0, C: 0, N: 0, O: 0 };
  answers.forEach((v, i) => { sums[traitOfIndex(i)] += v; });
  const scores = {};
  TRAIT_ORDER.forEach((tr) => {
    const min = QUESTIONS_PER_TRAIT * 1;
    const max = QUESTIONS_PER_TRAIT * 5;
    scores[tr] = Math.round(((sums[tr] - min) / (max - min)) * 100);
  });
  return scores;
}

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* noop */ }
  const { participantId, answers } = body;

  if (!code || !participantId || !Array.isArray(answers)) {
    return respond(400, { error: 'code, participantId, answers가 필요합니다.' });
  }
  if (answers.length !== TOTAL_QUESTIONS) {
    return respond(400, { error: `answers는 길이 ${TOTAL_QUESTIONS}의 배열이어야 합니다.` });
  }
  if (answers.some((v) => typeof v !== 'number' || v < 1 || v > 5)) {
    return respond(400, { error: '각 answer는 1~5 사이의 숫자여야 합니다.' });
  }

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: 'META' } }));
  if (!room.Item) return respond(404, { error: '존재하지 않는 방 코드입니다.' });
  if (room.Item.status !== 'OPEN') return respond(409, { error: '이미 마감된 방입니다.' });

  const participant = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: `PARTICIPANT#${participantId}` } })
  );
  if (!participant.Item) return respond(404, { error: '참가자를 찾을 수 없습니다.' });

  const scores = computeScores(answers);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ROOM#${code}`, SK: `PARTICIPANT#${participantId}` },
      UpdateExpression: 'SET answers = :a, scores = :s, submittedAt = :t',
      ExpressionAttributeValues: { ':a': answers, ':s': scores, ':t': Math.floor(Date.now() / 1000) },
    })
  );

  return respond(200, { ok: true, scores });
};
