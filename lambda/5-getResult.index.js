// Lambda 함수명 예: chemistry-room-get-result
// 핸들러: index.handler
// 환경변수: TABLE_NAME = (DynamoDB 테이블 이름)
// 트리거: API Gateway HTTP API - GET /rooms/{code}/results/{participantId}

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

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

exports.handler = async (event) => {
  const { code, participantId } = event.pathParameters || {};
  if (!code || !participantId) return respond(400, { error: 'code, participantId가 필요합니다.' });

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: 'META' } }));
  if (!room.Item) return respond(404, { error: '존재하지 않는 방 코드입니다.' });
  if (room.Item.status !== 'CLOSED') return respond(409, { error: '방장이 아직 결과를 공개하지 않았습니다.' });

  const participant = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: `PARTICIPANT#${participantId}` } })
  );
  if (!participant.Item) return respond(404, { error: '참가자를 찾을 수 없습니다.' });

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: `RESULT#${participantId}` } })
  );

  return respond(200, {
    codename: participant.Item.codename,
    scores: participant.Item.scores,
    topMatches: result.Item ? result.Item.topMatches : [],
    opposite: result.Item ? result.Item.opposite : null,
  });
};
