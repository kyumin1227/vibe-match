// 50명 부하 테스트 — 실제 배포된 API를 그대로 호출한다 (DynamoDB까지 실제로 탄다).
// 실행: node load-test-50.js
// 요구사항: Node.js 18 이상 (내장 fetch 사용)
//
// 하는 일:
//   1) 방 생성
//   2) N명 입장
//   3) 각자 30문항(1~5) 랜덤 제출
//   4) 방 마감 (여기서 N*(N-1)/2 쌍의 궁합을 계산 + BatchWrite. N=50이면 1225쌍, 49번의 BatchWrite)
//   5) 상태/결과 샘플 조회
//   6) 조언(advice) 호출 — 실제 LLM 호출이라 비용이 발생한다. 원치 않으면 아래 RUN_ADVICE를 false로.
//
// 방은 TTL 48시간짜리라 자동 삭제된다. 실행할 때마다 새 방이 생기니 여러 번 돌려도 안전하다.

const API_BASE = "https://5wem3wqvzj.execute-api.ap-northeast-2.amazonaws.com";
const N = 50;
const CONCURRENCY = 4; // 한꺼번에 너무 많이 쏘면 콜드스타트 구간에서 503이 날 수 있다. 낮게 시작해서 올려본다.
const RUN_ADVICE = true;

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
    if (res.ok) return { json, ms, attempts: attempt };
    // 503/502/429는 콜드스타트·스로틀링일 수 있으니 짧게 쉬고 재시도한다. 나머지는 즉시 실패.
    const retryable = res.status === 503 || res.status === 502 || res.status === 429;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw Object.assign(new Error(json.error || json.message || `HTTP ${res.status}`), { status: res.status, path, json });
    }
    retryCount += 1;
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
}

// 동시에 CONCURRENCY개씩만 실행되는 워커 풀
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
  console.log(`=== ${N}명 부하 테스트 시작 (동시성 ${CONCURRENCY}) ===\n`);

  const { json: room, ms: createMs } = await api("/rooms", { method: "POST" });
  console.log(`[1] 방 생성 → code=${room.code} (${fmt(createMs)})`);

  const t0 = Date.now();
  const joinTimes = [];
  const participants = await mapConcurrent(Array.from({ length: N }), CONCURRENCY, async () => {
    const { json, ms } = await api(`/rooms/${room.code}/join`, { method: "POST", body: {} });
    joinTimes.push(ms);
    return { participantId: json.participantId, codename: json.codename };
  });
  console.log(
    `[2] ${N}명 입장 완료 (총 ${fmt(Date.now() - t0)}, 평균 ${fmt(Math.round(joinTimes.reduce((a, b) => a + b, 0) / N))}, 최대 ${fmt(Math.max(...joinTimes))})`,
  );

  const codenameSet = new Set(participants.map((p) => p.codename));
  console.log(`    코드네임 중복 없음 확인: ${codenameSet.size === N ? "OK" : `FAIL (고유 ${codenameSet.size}/${N})`}`);

  const t1 = Date.now();
  const answerTimes = [];
  await mapConcurrent(participants, CONCURRENCY, async (p) => {
    const { ms } = await api(`/rooms/${room.code}/answers`, {
      method: "POST",
      body: { participantId: p.participantId, answers: randomAnswers() },
    });
    answerTimes.push(ms);
  });
  console.log(
    `[3] ${N}명 검사 제출 완료 (총 ${fmt(Date.now() - t1)}, 평균 ${fmt(Math.round(answerTimes.reduce((a, b) => a + b, 0) / N))}, 최대 ${fmt(Math.max(...answerTimes))})`,
  );

  const { json: closeResult, ms: closeMs } = await api(`/rooms/${room.code}/close`, {
    method: "POST",
    body: { hostToken: room.hostToken },
  });
  const expectedPairs = (N * (N - 1)) / 2;
  console.log(`[4] 방 마감 (궁합 계산) → 참가자 ${closeResult.participantCount}명, 쌍 ${expectedPairs}개 계산 (${fmt(closeMs)})`);

  const { json: status } = await api(`/rooms/${room.code}/status`);
  console.log(`[5] 상태 확인 → status=${status.status}, submitted=${status.submittedCount}, pending=${status.pendingCount}`);

  const sample = participants[0];
  const { json: result, ms: resultMs } = await api(`/rooms/${room.code}/results/${sample.participantId}`);
  console.log(
    `    샘플 결과 조회 (${sample.codename}) → topMatches ${result.topMatches.length}개, opposite ${result.opposite ? "있음" : "없음"} (${fmt(resultMs)})`,
  );

  if (RUN_ADVICE) {
    const { json: advice, ms: adviceMs } = await api(`/rooms/${room.code}/advice`, {
      method: "POST",
      body: { lang: "ko" },
    });
    console.log(
      `[6] 조언 생성 → status=${advice.status}, cached=${advice.cached}, participantCount=${advice.stats?.participantCount} (${fmt(adviceMs)})`,
    );
    if (advice.advice) console.log(`    groupVibe: ${advice.advice.groupVibe}`);
  } else {
    console.log("[6] 조언 생성 스킵 (RUN_ADVICE = false)");
  }

  console.log(`\n=== 완료. 방 코드: ${room.code} (48시간 후 자동 만료) | 재시도 발생 횟수: ${retryCount} ===`);
})().catch((e) => {
  console.error(`\n실패: [${e.path || "?"}] ${e.status || ""} ${e.message}`);
  if (e.json) console.error(JSON.stringify(e.json, null, 2));
  process.exit(1);
});
