# brainpool-corehub 초기 구조 설계
> 작성일: 2026-07-08
> 기준: CoreHub Foundation v1.1
> 스택: Next.js 14.2.x + TypeScript + Supabase (공유 DB)
> 배포: Vercel Hobby (sykim-stack org)

---

## 1. 레포 구조

```
brainpool-corehub/
├── app/
│   └── api/
│       └── corehub/
│           ├── facts/route.js      → Fact 수집
│           ├── connect/route.js    → Connection 발견
│           ├── meanings/route.js   → Possible Meaning 조회
│           └── opportunities/route.js → Opportunity 조회
├── lib/
│   ├── supabase.ts                 → CoreNull과 동일 패턴
│   └── engines/
│       ├── FactCollector.js        → Fact 수집 엔진
│       ├── ConnectionEngine.js     → Connection 발견 엔진
│       ├── MeaningEngine.js        → Possible Meaning 생성
│       └── OpportunityEngine.js    → Opportunity 발견
├── types/
│   └── corehub.ts                  → 타입 정의
├── package.json
├── tsconfig.json
└── next.config.js
```

---

## 2. Supabase 테이블 설계

공유 DB (`grlfocvlfatuvphkyivd`) 에 `corehub` 스키마 추가.

```sql
-- Fact 수집 테이블
CREATE TABLE corehub.facts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,        -- 'CoreNull' | 'CoreRing' | 'CoreChat' | 'HajunAI'
  fact_type     TEXT NOT NULL,        -- 'space.seed.created' | 'language.emotion.detected' | ...
  owner_key     TEXT NOT NULL,        -- 행동 주체
  house_id      UUID,                 -- 관련 House (있을 경우)
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload       JSONB DEFAULT '{}',   -- Fact 상세 데이터
  processed     BOOLEAN DEFAULT FALSE -- Connection 처리 여부
);

-- Connection 발견 테이블
CREATE TABLE corehub.connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_ids        UUID[] NOT NULL,    -- 연결된 Fact ID 목록
  connection_type TEXT NOT NULL,      -- 연결 유형
  strength        FLOAT DEFAULT 0,    -- 연결 강도 (0.0 ~ 1.0)
  owner_key       TEXT,
  house_id        UUID,
  detected_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Possible Meaning 테이블
CREATE TABLE corehub.meanings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meaning_type    TEXT NOT NULL,
  confidence      FLOAT DEFAULT 0,    -- 가능성 (확정 아님)
  source_fact_ids UUID[] NOT NULL,    -- 근거 Fact 목록
  connection_ids  UUID[],             -- 근거 Connection 목록
  owner_key       TEXT,
  house_id        UUID,
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ         -- 의미의 유효 시간
);

-- Opportunity 테이블
CREATE TABLE corehub.opportunities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_type    TEXT NOT NULL,
  source_meaning_id   UUID REFERENCES corehub.meanings(id),
  target_owner_key    TEXT NOT NULL,
  priority            TEXT DEFAULT 'medium',  -- 'low' | 'medium' | 'high'
  action_type         TEXT NOT NULL,
  payload             JSONB DEFAULT '{}',
  is_consumed         BOOLEAN DEFAULT FALSE,  -- CoreNull이 View에 반영했는가
  consumed_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 학습 로그
CREATE TABLE corehub.learning_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  UUID REFERENCES corehub.opportunities(id),
  outcome         TEXT,               -- 'clicked' | 'ignored' | 'converted'
  logged_at       TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 3. API 설계 (코딩 계약 동일)

```
- throw 금지 → _error 반환
- req.text() + JSON.parse()
- HTTP: 200 또는 500만
- traceId 필수
- export const dynamic = 'force-dynamic'
```

### POST /api/corehub/facts
Core에서 Fact를 전달받아 저장.

```json
Request:
{
  "source": "CoreNull",
  "fact_type": "space.seed.created",
  "owner_key": "owner_abc123",
  "house_id": "uuid",
  "occurred_at": "2026-07-08T00:00:00Z",
  "payload": { "room_id": "uuid", "bloom_date": "2026-12-31" }
}

Response:
{
  "data": { "fact_id": "uuid" },
  "traceId": "uuid"
}
```

### GET /api/corehub/opportunities
CoreNull이 View 생성 시 Opportunity 조회.

```
?owner_key=xxx
?house_id=xxx
?consumed=false  (미반영 Opportunity만)
```

### PATCH /api/corehub/opportunities
CoreNull이 View에 반영 후 consumed 처리.

```json
{ "opportunity_id": "uuid", "outcome": "shown" }
```

---

## 4. 엔진 설계

### FactCollector.js
```javascript
// Fact 저장 + 즉시 ConnectionEngine 트리거
async collect(ctx) {
  // 1. facts 테이블에 저장
  // 2. 같은 owner_key의 최근 Fact 조회 (N개)
  // 3. ConnectionEngine.detect() 호출
}
```

### ConnectionEngine.js
```javascript
// Fact 패턴에서 Connection 발견
async detect(ctx) {
  // 1. 최근 Fact 목록 조회
  // 2. fact_type 조합 패턴 매칭
  // 3. Connection 발견 시 corehub.connections에 저장
  // 4. MeaningEngine.generate() 호출
}
```

### MeaningEngine.js
```javascript
// Connection → Possible Meaning
async generate(ctx) {
  // 1. Connection 분석
  // 2. Possible Meaning 생성 (confidence 포함)
  // 3. corehub.meanings에 저장
  // 4. OpportunityEngine.evaluate() 호출
}
```

### OpportunityEngine.js
```javascript
// Possible Meaning → Opportunity
async evaluate(ctx) {
  // 1. Meaning confidence 임계값 확인 (예: 0.6 이상)
  // 2. Opportunity 생성
  // 3. corehub.opportunities에 저장
}
```

---

## 5. CoreNull → CoreHub 연결 포인트

CoreNull의 주요 이벤트에서 Fact Push 추가.

```javascript
// app/api/corenull/rooms/route.js (POST 완료 후)
if (data.seed_mode) {
  await fetch('https://corehub.vercel.app/api/corehub/facts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'CoreNull',
      fact_type: 'space.seed.created',
      owner_key,
      house_id,
      payload: { room_id: data.id, bloom_date: data.bloom_date }
    })
  }).catch(() => null)  // 실패해도 CoreNull 동작 영향 없음
}
```

**중요:** CoreHub 호출 실패가 CoreNull 응답에 영향을 주면 안 된다.
항상 `.catch(() => null)` 패턴으로 fire-and-forget.

---

## 6. Vercel 배포 설정

```
Project: brainpool-corehub
Framework: Next.js
Domain: corehub.vercel.app
Env:
  NEXT_PUBLIC_SUPABASE_URL=https://grlfocvlfatuvphkyivd.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=...
  CORENULL_API_URL=https://corenull.vercel.app
```

API 슬롯: 4개 (facts, connect, meanings, opportunities)
Vercel Hobby 12개 한도 내 여유.

---

## 7. 구현 순서

```
Step 1: GitHub에 brainpool-corehub 레포 생성
Step 2: Next.js 14 초기화 (package.json, tsconfig.json)
Step 3: lib/supabase.ts 작성 (CoreNull과 동일 패턴)
Step 4: Supabase에 corehub 스키마 + 테이블 생성
Step 5: POST /api/corehub/facts 구현 + 테스트
Step 6: FactCollector.js + ConnectionEngine.js 기초 구현
Step 7: CoreNull rooms/route.js에 Fact Push 추가
Step 8: Vercel 배포
Step 9: MeaningEngine + OpportunityEngine 구현
Step 10: GET /api/corehub/opportunities 구현
```

---

## 8. 한 줄 원칙

oreHub는 Fact를 연결한다. 의미를 발견한다. 기회를 제안한다. 판단하지 않는다. 강요하지 않는다. 사용자는 엔진을 모른다.