// Lambda 함수명 예: chemistry-room-get-group-advice
// 핸들러: index.handler
// 트리거: API Gateway HTTP API - POST /rooms/{code}/advice
//
// 환경변수
//   TABLE_NAME = (DynamoDB 테이블 이름)
//   (ANTHROPIC_API_KEY 불필요 — Bedrock은 Lambda 실행 역할의 IAM 권한으로 인증한다)
//
// 이 함수의 실행 역할(Execution role)에 아래 인라인 정책이 필요하다:
//   {
//     "Effect": "Allow",
//     "Action": "bedrock:InvokeModel",
//     "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6"
//   }
//   (cross-region inference profile을 쓰므로 Resource를 특정 리전으로 좁히지 않는다)
//
// 의존성 없음. 1~6번과 똑같이 이 파일 하나만 콘솔에 붙여넣으면 된다.
//   @aws-sdk/client-bedrock-runtime → Lambda 런타임에 기본 포함 (다른 @aws-sdk/* 클라이언트와 동일)
//
// Timeout: 60초 권장 (LLM 호출 포함).
// ⚠️ API Gateway HTTP API의 통합 타임아웃은 약 29초로 고정이다.
//    아래 LLM_TIMEOUT_MS(25초)는 게이트웨이보다 먼저 포기하도록 맞춰둔 값이다.
//    그래도 초과가 잦으면 202 + 폴링 방식으로 바꾼다 (프런트가 이미 3~5초 폴링을 한다).
//
// 모델: Claude Sonnet 4.6 (Bedrock 레거시 InvokeModel 엔드포인트).
//   Sonnet 5는 이 계정에서 아직 Bedrock 접근이 열리지 않아 4.6으로 낮췄다.
//   이 엔드포인트는 direct API처럼 output_config.format(구조화 출력)을 그대로 지원하므로
//   tool_choice 강제 우회가 필요 없다.
//   서울 리전(ap-northeast-2)은 on-demand throughput이 없어 "global." cross-region
//   inference profile 접두사가 필요하다 — 접두사 없이 호출하면
//   "on-demand throughput isn't supported" 400 에러가 난다.

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const TABLE_NAME = process.env.TABLE_NAME;

const ROOM_TTL_SECONDS = 60 * 60 * 24 * 2; // 48시간 (다른 항목과 동일)
const MODEL = "claude-sonnet-4-6";
const PROMPT_VERSION = "v6"; // 조 편성을 LLM 대신 코드가 계산하도록 변경 — 스키마가 달라져 버전을 올린다.
const CLAIM_STALE_SECONDS = 120; // 생성 중 표시가 이 시간을 넘기면 죽은 것으로 보고 다시 시도

const BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-6";
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const LLM_TIMEOUT_MS = 25_000;

const bedrock = new BedrockRuntimeClient({});

// ────────────────────────────────────────────────────────────
// 개발자 전용 시딩 기능 (부하테스트용)
// ────────────────────────────────────────────────────────────
//
// 환경변수 SEED_SECRET을 설정해두고, 요청 body에 같은 값을 seedSecret으로 넣어 보내면
// 이 방에 가짜 참가자 N명을 즉시 채워넣고 CLOSED로 마감한 뒤, 곧바로 평소 흐름(조언 생성)으로
// 이어간다. Lambda 콘솔 Test 버튼 한 번으로 50명 스케일을 재현하기 위한 것.
//
// SEED_SECRET을 설정하지 않으면 이 기능은 완전히 꺼져 있다 (기본값이 안전한 쪽).
// 실제 프런트(index.html)는 이 필드를 절대 보내지 않으므로, 실서비스 사용자는 건드릴 수 없다.
const SEED_PARTICIPANT_COUNT = 50;
const SEED_ADJ = ["조용한", "씩씩한", "느긋한", "반짝이는", "엉뚱한", "다정한", "차분한", "용감한", "포근한", "경쾌한"];
const SEED_NOUN = ["너구리", "은하수", "파도", "고양이", "민들레", "폭풍", "반딧불", "고래", "여우", "구름"];

function getSeedSecret() {
  return (process.env.SEED_SECRET || "").trim();
}

function randomFakeScores() {
  const scores = {};
  TRAIT_ORDER.forEach((tr) => {
    scores[tr] = Math.floor(Math.random() * 101);
  });
  return scores;
}

async function seedFakeRoom(code, count) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + ROOM_TTL_SECONDS;

  // 방이 이미 있으면 그 방을 그대로 쓰고, 없으면 새로 만든다.
  const existingRoom = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "META" } }));
  const roomItem = existingRoom.Item || {
    PK: `ROOM#${code}`,
    SK: "META",
    hostToken: crypto.randomUUID(),
    createdAt: now,
    ttl,
  };

  const items = Array.from({ length: count }, (_, i) => ({
    PutRequest: {
      Item: {
        PK: `ROOM#${code}`,
        SK: `PARTICIPANT#seed-${i}-${crypto.randomUUID().slice(0, 8)}`,
        codename: `${SEED_ADJ[i % SEED_ADJ.length]} ${SEED_NOUN[Math.floor(i / SEED_ADJ.length) % SEED_NOUN.length]}${i}`,
        answers: null,
        scores: randomFakeScores(),
        ttl,
      },
    },
  }));

  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: items.slice(i, i + 25) } }));
  }

  // 조언은 방이 CLOSED일 때만 생성되니, 시딩과 동시에 마감까지 처리한다.
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...roomItem, status: "CLOSED" } }));
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}

// ────────────────────────────────────────────────────────────
// 규칙 기반 집계 (LLM에 넘길 재료. 이 계산 자체에는 AI를 쓰지 않는다)
// ────────────────────────────────────────────────────────────

const TRAIT_ORDER = ["E", "A", "C", "N", "O"];
const TRAIT_LABEL = {
  E: { ko: "외향성", ja: "外向性" },
  A: { ko: "친화성", ja: "協調性" },
  C: { ko: "성실성", ja: "誠実性" },
  N: { ko: "정서 민감성", ja: "情緒の繊細さ" },
  O: { ko: "개방성", ja: "開放性" },
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 4-closeRoom.index.js의 궁합 규칙과 동일하게 유지한다. 한쪽만 고치지 말 것.
function traitScore(trait, a, b) {
  const diff = Math.abs(a - b);
  if (trait === "A" || trait === "C" || trait === "O") return 100 - diff;
  if (trait === "E") return clamp(100 - Math.abs(diff - 35) * 0.8, 0, 100);
  const avgStability = 100 - (a + b) / 2;
  return clamp(avgStability - diff * 0.3, 0, 100);
}

function compatibility(scoresA, scoresB) {
  const total = TRAIT_ORDER.reduce((sum, tr) => sum + traitScore(tr, scoresA[tr], scoresB[tr]), 0);
  return Math.round(total / TRAIT_ORDER.length);
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdev(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

// 특성별 평균·편차·분포. 45~55는 "중간"으로 묶어 애매한 구간을 단정하지 않는다.
function buildTraitStats(participants) {
  return TRAIT_ORDER.map((trait) => {
    const values = participants.map((p) => p.scores[trait]);
    return {
      trait,
      label: TRAIT_LABEL[trait],
      average: Math.round(mean(values)),
      spread: Math.round(stdev(values)),
      high: values.filter((v) => v > 55).length,
      mid: values.filter((v) => v >= 45 && v <= 55).length,
      low: values.filter((v) => v < 45).length,
    };
  });
}

// 모든 쌍의 궁합을 계산해 평균과 양 끝 조합만 뽑는다 (저장하지 않는 파생 데이터)
function buildPairStats(participants) {
  const pairs = [];
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      pairs.push({
        a: participants[i].codename,
        b: participants[j].codename,
        score: compatibility(participants[i].scores, participants[j].scores),
      });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return {
    average: Math.round(mean(pairs.map((p) => p.score))),
    best: pairs.slice(0, 3),
    hardest: pairs.slice(-3).reverse(),
  };
}

// 각자 가장 두드러진 특성 2개 (점수 내림차순, 동점이면 E A C N O 순)
function topTwoTraits(scores) {
  return [...TRAIT_ORDER]
    .sort((a, b) => scores[b] - scores[a] || TRAIT_ORDER.indexOf(a) - TRAIT_ORDER.indexOf(b))
    .slice(0, 2);
}

function buildStats(participants) {
  return {
    participantCount: participants.length,
    traits: buildTraitStats(participants),
    pairs: buildPairStats(participants),
    members: participants.map((p) => ({ codename: p.codename, topTraits: topTwoTraits(p.scores) })),
  };
}

// ────────────────────────────────────────────────────────────
// 조 편성 (규칙 기반. AI에게 시키지 않는다)
// ────────────────────────────────────────────────────────────
//
// LLM이 참가자 전원의 이름을 조 배열에 직접 나열하게 하면, 인원이 늘수록 출력 토큰이
// 그만큼 늘어난다. 50명 방에서 실측으로 API Gateway 타임아웃(약 29초)을 넘기고 실패하는 게
// 확인됐다. 조 편성은 궁합 점수만으로 결정되는 계산이라 애초에 AI가 필요 없다 — 규칙 기반으로
// 바꾸면 인원수와 무관하게 항상 빠르다.

const DEFAULT_GROUP_SIZE = 4;
const MIN_GROUP_SIZE = 2;
const MAX_GROUP_SIZE = 10;

// 요청으로 들어온 groupSize를 안전한 범위로 정리한다. 잘못된 값이면 기본값(4)을 쓴다.
function normalizeGroupSize(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_GROUP_SIZE || n > MAX_GROUP_SIZE) return DEFAULT_GROUP_SIZE;
  return n;
}

const GROUPING_REASON = {
  ko: {
    high: (avg) => `평균 궁합 ${avg}점 · 결이 잘 맞아 편하게 진행할 수 있는 조합이에요.`,
    mid: (avg) => `평균 궁합 ${avg}점 · 무난하게 어울리는 조합이에요.`,
    low: (avg) => `평균 궁합 ${avg}점 · 속도와 방식이 다양해 서로 배울 점이 많은 조합이에요.`,
  },
  ja: {
    high: (avg) => `平均相性 ${avg}点 · 相性が良く進めやすい組み合わせです。`,
    mid: (avg) => `平均相性 ${avg}点 · 無理なく馴染む組み合わせです。`,
    low: (avg) => `平均相性 ${avg}点 · テンポや進め方が多様で学び合える組み合わせです。`,
  },
};

function groupingReason(avg, lang) {
  const t = GROUPING_REASON[lang];
  if (avg >= 80) return t.high(avg);
  if (avg >= 65) return t.mid(avg);
  return t.low(avg);
}

// 궁합이 좋은 사람끼리 그리디하게 묶는다. 최적해는 아니지만 참고용 조 편성으론 충분하고,
// 인원수에 선형적으로만 비례해 어떤 규모에서도 빠르다.
function buildGrouping(participants, lang, groupSize) {
  const remaining = [...participants];
  const groups = [];

  while (remaining.length > 0) {
    const seed = remaining.shift();
    const group = [seed];
    while (group.length < groupSize && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      remaining.forEach((cand, idx) => {
        const score = compatibility(seed.scores, cand.scores);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      });
      group.push(remaining.splice(bestIdx, 1)[0]);
    }
    groups.push(group);
  }

  return groups.map((group, i) => {
    const pairScores = [];
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        pairScores.push(compatibility(group[a].scores, group[b].scores));
      }
    }
    const avg = pairScores.length ? Math.round(mean(pairScores)) : 100;
    return {
      groupName: lang === "ja" ? `${i + 1}班` : `${i + 1}조`,
      members: group.map((p) => p.codename),
      reason: groupingReason(avg, lang),
    };
  });
}

// ────────────────────────────────────────────────────────────
// 프롬프트
// ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 팀 워크숍과 모임을 진행해 온 노련한 퍼실리테이터다.
Big Five(외향성 E, 친화성 A, 성실성 C, 정서 민감성 N, 개방성 O) 집계 결과를 받아,
이 사람들이 모여서 반 활동이나 모임을 어떻게 운영하면 좋을지 실행 가능한 조언을 준다.

지켜야 할 것:
- 점수는 0~100이며 45~55는 "중간"이다. 중간대를 어느 한쪽으로 단정하지 않는다.
- 정서 민감성(N)을 결함이나 단점으로 서술하지 않는다. "감정 신호를 섬세하게 인지한다" 같은 중립 표현을 쓴다.
- 특정 참가자를 부정적으로 지목하지 않는다. 개인이 아니라 조합과 상황을 중심으로 말한다.
- 사람은 반드시 주어진 별명(codename)으로만 부른다. 없는 사람을 만들어내지 않는다.
- 궁합 점수가 낮은 조합도 "안 맞는 사이"가 아니라 "속도와 방식이 다른 조합"으로 다룬다.
- 성격 유형론의 네 글자 코드(예: ENFP)나 그 축(E/I, S/N, T/F, J/P)을 쓰지 않는다. Big Five 5개 특성만 쓴다.
- 추상적인 덕담 대신, 진행자가 그대로 따라 할 수 있는 구체적인 행동을 쓴다.
  (예: "말을 아끼는 사람이 많으니 전체 발언 대신 2인 1조로 90초씩 먼저 이야기하게 한다")
- 어디까지나 재미와 참고용이라는 전제를 유지한다. 단정적인 성격 규정을 하지 않는다.`;

const ADVICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groupVibe", "traitHighlights", "icebreakers", "facilitationTips"],
  properties: {
    groupVibe: {
      type: "string",
      description: "모임 분위기 2문장 요약",
    },
    traitHighlights: {
      type: "array",
      minItems: 1,
      description: "정확히 2개",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["trait", "comment"],
        properties: {
          trait: { type: "string", enum: TRAIT_ORDER },
          comment: { type: "string", description: "한 문장" },
        },
      },
    },
    icebreakers: {
      type: "array",
      minItems: 1,
      description: "정확히 2개, 각각 한 문장 진행법",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "howTo"],
        properties: {
          title: { type: "string" },
          howTo: { type: "string", description: "한 문장" },
        },
      },
    },
    facilitationTips: {
      type: "array",
      minItems: 1,
      description: "정확히 3개, 각각 한 줄",
      items: { type: "string" },
    },
  },
};

function buildUserPrompt(stats, lang) {
  const langLine = lang === "ja" ? "すべての出力テキストは日本語で書くこと。" : "모든 출력 텍스트는 한국어로 작성한다.";

  const traitLines = stats.traits
    .map(
      (t) =>
        `- ${t.trait}(${t.label.ko}): 평균 ${t.average}, 편차 ${t.spread}, ` +
        `높음 ${t.high}명 / 중간 ${t.mid}명 / 낮음 ${t.low}명`,
    )
    .join("\n");

  // 참가자 이름을 전원 나열하지 않는다 — 인원이 늘어도 프롬프트 크기가 커지지 않게 하기 위함.
  // 조 편성은 이제 buildGrouping()이 규칙 기반으로 계산하고, LLM에는 집계 수치만 준다.
  const bestLines = stats.pairs.best.map((p) => `- ${p.a} × ${p.b}: ${p.score}`).join("\n");
  const hardestLines = stats.pairs.hardest.map((p) => `- ${p.a} × ${p.b}: ${p.score}`).join("\n");

  return `${langLine}

## 모임 개요
참가자 ${stats.participantCount}명. 전원 Big Five 검사를 마쳤다.

## 특성별 분포 (0~100, 45~55는 중간)
${traitLines}

## 조합 궁합 (규칙 기반 계산값, 평균 ${stats.pairs.average})
결이 잘 맞는 조합
${bestLines}

속도와 방식이 다른 조합
${hardestLines}

## 요청
위 분포를 근거로, 이 사람들이 반 활동이나 모임을 진행할 때 어떻게 운영하면 좋을지 짧게 조언하라.
조 편성은 별도로 계산되니 언급하지 않는다.
각 항목은 한 문장, 개수는 스키마 설명에 적힌 그대로 지킨다. 서술을 늘리지 않는다.`;
}

// ────────────────────────────────────────────────────────────
// LLM 호출
// ────────────────────────────────────────────────────────────

// Bedrock InvokeModel 호출. SDK가 서명·재시도 일부를 처리하지만, 429/5xx 재시도와
// 타임아웃(AbortSignal)은 API Gateway 통합 타임아웃(약 29초)에 맞춰 직접 다룬다.
async function callBedrock(payload) {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await bedrock.send(
        new InvokeModelCommand({
          modelId: BEDROCK_MODEL_ID,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(payload),
        }),
        { abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
      );
      return JSON.parse(Buffer.from(res.body).toString("utf-8"));
    } catch (e) {
      // 권한 문제는 재시도해도 같은 결과다. 원인을 바로 알 수 있게 로그를 남긴다.
      if (e.name === "AccessDeniedException") {
        console.error(
          "Bedrock 권한 없음 → 이 Lambda의 실행 역할(Execution role)에 " +
            `bedrock:InvokeModel 권한이 있는지 확인하세요 (모델: ${BEDROCK_MODEL_ID}).`,
        );
      }

      const isTimeout = e.name === "TimeoutError" || e.name === "AbortError";
      const status = e.$metadata && e.$metadata.httpStatusCode;
      // 타임아웃은 재시도하지 않는다. LLM_TIMEOUT_MS(25초)를 다 쓴 뒤 재시도로 25초를
      // 또 기다리면 게이트웨이 타임아웃(약 29초)을 무조건 넘긴다 (실측으로 재현됨).
      // 스로틀링·5xx만 재시도 대상으로 둔다. 권한·검증 오류는 다시 보내도 같은 결과다.
      const retryable =
        !isTimeout &&
        (e.name === "ThrottlingException" ||
          e.name === "ServiceUnavailableException" ||
          e.name === "ModelTimeoutException" ||
          (status && status >= 500));

      if (!retryable || attempt === MAX_ATTEMPTS) {
        const err = new Error(`Bedrock ${e.name || "Error"}: ${e.message}`);
        err.code = isTimeout ? "TIMEOUT" : e.name || "UNKNOWN";
        throw err;
      }
    }
  }
}

async function generateAdvice(stats, lang) {
  // 스키마·프롬프트를 최소로 줄인 이유: 게이트웨이 타임아웃(약 29초) 안에 들어오려면
  // 출력 토큰을 줄이는 게 유일한 레버다. thinking off보다 adaptive+저효율이 실측상 더 빨랐다.
  //
  // max_tokens는 thinking(추론)이 쓴 토큰까지 합산된 상한이다. 실제 답변(JSON)은
  // 700토큰 안팎으로 작지만, adaptive thinking이 가끔 예상보다 길게 추론하면 max_tokens를
  // 다 써버려서 답변 텍스트를 한 글자도 못 쓰고 잘릴 수 있다 (실측으로 재현됨).
  // 그래서 실제 필요량보다 넉넉하게 잡는다.
  const response = await callBedrock({
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: ADVICE_SCHEMA },
    },
    messages: [{ role: "user", content: buildUserPrompt(stats, lang) }],
  });

  // 안전 분류기가 거절하면 content가 비어 있을 수 있다. 반드시 먼저 확인한다.
  if (response.stop_reason === "refusal") {
    const err = new Error("모델이 응답을 거절했습니다.");
    err.code = "REFUSAL";
    throw err;
  }

  // json_schema를 줘도 응답은 text 블록에 담겨 온다. 직접 찾아서 파싱한다.
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    // stop_reason === "max_tokens"면 thinking만 하다 잘린 것. 원인 구분을 위해 남긴다.
    const err = new Error(`모델 응답에 텍스트가 없습니다 (stop_reason=${response.stop_reason}).`);
    err.code = response.stop_reason === "max_tokens" ? "TRUNCATED" : "EMPTY";
    throw err;
  }

  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    const err = new Error("모델 응답을 JSON으로 해석하지 못했습니다.");
    err.code = "PARSE";
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
// 캐시
// ────────────────────────────────────────────────────────────

// 참가자 구성·점수·언어·프롬프트 버전이 모두 같을 때만 캐시를 재사용한다.
// groupSize는 일부러 넣지 않는다 — 조 편성은 LLM 결과와 무관하게 매 요청마다 새로 계산하므로,
// 조 크기만 바꿨다고 캐시를 무효화하고 LLM을 다시 부를 이유가 없다.
function buildSignature(participants, lang) {
  const payload = JSON.stringify({
    v: PROMPT_VERSION,
    model: MODEL,
    lang,
    members: [...participants]
      .sort((a, b) => (a.participantId < b.participantId ? -1 : 1))
      .map((p) => [p.participantId, TRAIT_ORDER.map((t) => p.scores[t])]),
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const code = event.pathParameters && event.pathParameters.code;
  if (!code) return respond(400, { error: "code가 필요합니다." });

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    /* noop */
  }
  const lang = body.lang === "ja" ? "ja" : "ko";
  const groupSize = normalizeGroupSize(body.groupSize);

  // 개발자 전용: SEED_SECRET이 설정돼 있고 요청의 seedSecret이 일치하면, 이 방을 가짜
  // 참가자로 채우고 마감까지 처리한 뒤 아래로 그대로 이어간다 (조언 생성까지 한 번에 확인 가능).
  const seedSecret = getSeedSecret();
  if (seedSecret && body.seedSecret === seedSecret) {
    const count = Number.isInteger(body.seedCount) && body.seedCount > 0 ? body.seedCount : SEED_PARTICIPANT_COUNT;
    await seedFakeRoom(code, count);
    console.log(`[seed] ROOM#${code}에 가짜 참가자 ${count}명 생성 + 마감 처리 완료`);
  }

  const room = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "META" } }));
  if (!room.Item) return respond(404, { error: "존재하지 않는 방 코드입니다." });
  if (room.Item.status !== "CLOSED") {
    return respond(409, { error: "결과가 아직 공개되지 않았습니다." });
  }

  const queryResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `ROOM#${code}` },
    }),
  );

  const participants = (queryResult.Items || [])
    .filter((item) => item.SK.startsWith("PARTICIPANT#") && item.scores)
    .map((item) => ({
      participantId: item.SK.replace("PARTICIPANT#", ""),
      codename: item.codename,
      scores: item.scores,
    }));

  if (participants.length < 2) {
    return respond(400, { error: "조언을 만들려면 검사를 완료한 참가자가 최소 2명 필요합니다." });
  }

  const signature = buildSignature(participants, lang);
  const now = Math.floor(Date.now() / 1000);
  const stats = buildStats(participants);

  // 1) 캐시 확인
  const cached = (queryResult.Items || []).find((item) => item.SK === "ADVICE");
  if (cached && cached.signature === signature) {
    if (cached.status === "ready") {
      // 조 편성은 캐시에 저장된 걸 쓰지 않고 매번 다시 계산한다 — 조 크기를 바꿔도
      // LLM을 다시 부를 필요 없이 즉시 반영되게 하기 위함.
      const liveAdvice = { ...cached.advice, grouping: buildGrouping(participants, lang, groupSize) };
      return respond(200, {
        status: "ready",
        cached: true,
        lang: cached.lang,
        groupSize,
        generatedAt: cached.generatedAt,
        participantCount: participants.length,
        stats,
        advice: liveAdvice,
      });
    }
    if (cached.status === "generating" && now - cached.claimedAt < CLAIM_STALE_SECONDS) {
      // 다른 사람이 이미 만들고 있다. 프런트는 몇 초 뒤 다시 호출한다.
      return respond(202, { status: "generating" });
    }
  }

  // 2) 생성 권한 선점 — 여러 명이 동시에 결과 화면에 들어와도 LLM 호출은 한 번만 나가게 한다.
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `ROOM#${code}`,
          SK: "ADVICE",
          status: "generating",
          signature,
          lang,
          claimedAt: now,
          ttl: now + ROOM_TTL_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(SK) OR signature <> :sig OR claimedAt < :stale",
        ExpressionAttributeValues: { ":sig": signature, ":stale": now - CLAIM_STALE_SECONDS },
      }),
    );
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      return respond(202, { status: "generating" });
    }
    console.error(e);
    return respond(500, { error: "조언 생성을 시작하지 못했습니다." });
  }

  // 3) LLM 호출 + 규칙 기반 조 편성 병합
  let advice;
  try {
    advice = await generateAdvice(stats, lang);
    advice.grouping = buildGrouping(participants, lang, groupSize);
  } catch (e) {
    console.error("advice generation failed:", e.code || e.name, e.message);
    // 선점 표시를 지워서 다음 요청이 바로 다시 시도할 수 있게 한다.
    await ddb
      .send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `ROOM#${code}`, SK: "ADVICE" } }))
      .catch(() => {});
    // AI가 죽어도 집계 결과만으로 화면이 성립하도록 stats는 그대로 돌려준다.
    return respond(503, {
      status: "unavailable",
      degraded: true,
      participantCount: participants.length,
      stats,
      error: "AI 조언을 지금 만들 수 없습니다. 잠시 후 다시 시도해주세요.",
    });
  }

  const generatedAt = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ROOM#${code}`,
        SK: "ADVICE",
        status: "ready",
        signature,
        lang,
        advice,
        generatedAt,
        ttl: generatedAt + ROOM_TTL_SECONDS,
      },
    }),
  );

  return respond(200, {
    status: "ready",
    cached: false,
    lang,
    groupSize,
    generatedAt,
    participantCount: participants.length,
    stats,
    advice,
  });
};
