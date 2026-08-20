// 브라우저에서 직접 만든 방(1-createRoom)에 가짜 참가자 50명을 입장시키고 검사까지 채운다.
// 마감·결과 확인·조언 생성은 이 스크립트가 하지 않는다 — 그건 웹에서 직접 진행한다.
//
// 사용법:
//   node fill-room.js <방코드>              → 기본 50명
//   node fill-room.js <방코드> <인원수>       → 인원수 직접 지정
//
// 예: node fill-room.js 451259
// 예: node fill-room.js 451259 10
//
// 요구사항: Node.js 18 이상 (내장 fetch 사용)

const API_BASE = "https://5wem3wqvzj.execute-api.ap-northeast-2.amazonaws.com";
const CONCURRENCY = 4; // 한꺼번에 너무 많이 쏘면 콜드스타트 구간에서 503이 날 수 있다.

const [, , ROOM_CODE, COUNT_ARG] = process.argv;
const N = COUNT_ARG ? parseInt(COUNT_ARG, 10) : 50;

if (!ROOM_CODE || !/^\d{6}$/.test(ROOM_CODE)) {
  console.error("사용법: node fill-room.js <6자리 방코드> [인원수]");
  console.error("예:     node fill-room.js 451259");
  console.error("예:     node fill-room.js 451259 10");
  process.exit(1);
}

let retryCount = 0;

async function api(path, opts) {
  const t0 = Date.now();
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(API_BASE + path, {
      method: opts?.method || "GET",
      headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const ms = Date.now() - t0;
    let json = {};
    try { json = await res.json(); } catch (e) { /* noop */ }
    if (res.ok) return { json, ms };
    const retryable = res.status === 503 || res.status === 502 || res.status === 429;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw Object.assign(new Error(json.error || json.message || `HTTP ${res.status}`), { status: res.status, path, json });
    }
    retryCount += 1;
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function randomAnswers() {
  return Array.from({ length: 30 }, () => 1 + Math.floor(Math.random() * 5));
}

function fmt(ms) {
  return `${ms}ms`;
}

(async () => {
  console.log(`=== 방 ${ROOM_CODE}에 가짜 참가자 ${N}명 채우기 (동시성 ${CONCURRENCY}) ===\n`);

  // 방이 실제로 있고 OPEN인지 먼저 확인한다 (마감된 방이면 join이 전부 409로 실패한다)
  const { json: before } = await api(`/rooms/${ROOM_CODE}/status`);
  console.log(`[0] 방 확인 → status=${before.status}, 기존 참가자 ${before.total}명`);
  if (before.status !== "OPEN") {
    console.error(`\n이 방은 이미 마감(${before.status})됐습니다. 웹에서 새 방을 만들고 그 코드로 다시 실행해주세요.`);
    process.exit(1);
  }

  const t0 = Date.now();
  const joinTimes = [];
  const participants = await mapConcurrent(Array.from({ length: N }), CONCURRENCY, async () => {
    const { json, ms } = await api(`/rooms/${ROOM_CODE}/join`, { method: "POST", body: {} });
    joinTimes.push(ms);
    return { participantId: json.participantId, codename: json.codename };
  });
  console.log(
    `[1] ${N}명 입장 완료 (총 ${fmt(Date.now() - t0)}, 평균 ${fmt(Math.round(joinTimes.reduce((a, b) => a + b, 0) / N))}, 최대 ${fmt(Math.max(...joinTimes))})`,
  );

  const codenameSet = new Set(participants.map((p) => p.codename));
  console.log(`    코드네임 중복 없음 확인: ${codenameSet.size === N ? "OK" : `FAIL (고유 ${codenameSet.size}/${N})`}`);

  const t1 = Date.now();
  const answerTimes = [];
  await mapConcurrent(participants, CONCURRENCY, async (p) => {
    const { ms } = await api(`/rooms/${ROOM_CODE}/answers`, {
      method: "POST",
      body: { participantId: p.participantId, answers: randomAnswers() },
    });
    answerTimes.push(ms);
  });
  console.log(
    `[2] ${N}명 검사 제출 완료 (총 ${fmt(Date.now() - t1)}, 평균 ${fmt(Math.round(answerTimes.reduce((a, b) => a + b, 0) / N))}, 최대 ${fmt(Math.max(...answerTimes))})`,
  );

  const { json: after } = await api(`/rooms/${ROOM_CODE}/status`);
  console.log(`[3] 최종 상태 → 전체 ${after.total}명, 검사 완료 ${after.submittedCount}명, 미완료 ${after.pendingCount}명`);

  console.log(`\n=== 완료. 재시도 발생 횟수: ${retryCount} ===`);
  console.log(`이제 웹 브라우저(방장 화면)에서 "마감하고 결과 보기"를 누르면 이어서 확인할 수 있습니다.`);
})().catch((e) => {
  console.error(`\n실패: [${e.path || "?"}] ${e.status || ""} ${e.message}`);
  if (e.json) console.error(JSON.stringify(e.json, null, 2));
  process.exit(1);
});
