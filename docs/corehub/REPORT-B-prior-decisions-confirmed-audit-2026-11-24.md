# REPORT-B — prior_decisions / confirmed_by_human 읽기 전용 코드 감사

- **일자:** 2026-11-24
- **성격:** 읽기 전용. 코드 변경 없음.
- **범위:** `sykim-stack/hajuncore-app` main (`4779ad4`), 관련 문서(ADR-CONFIRM-000, AUDIT 2026-10-24, NOTE migration)
- **근거 ADR:** ADR-CONFIRM-000 Accepted

---

## 1. 감사 질문

1. `prior_decisions` / Room Context가 **`confirmed_by_human=true`만** 결정으로 쓰는가?
2. `adopted=true`만으로 결정을 주입하는 경로가 있는가?

---

## 2. 방법

- GitHub `hajuncore-app` main 트리 열람 + `lib/*`, `types/hajun.ts`, ContextRoom 일부 raw 조회
- 검색어: `confirmed_by_human`, `prior_decisions`, `adopted`, `hajun_posts`, `decision`, `msg_type`

---

## 3. 결과 요약

| 항목 | 결과 | 판정 |
|------|------|------|
| 문자열 `confirmed_by_human` | **main 코드에서 미검출** (조회한 lib/types 범위) | **갭** — ADR 컬럼 재사용 원칙과 코드 미연결 |
| 문자열 `prior_decisions` | **미검출** | 문서 용어와 코드 심볼 불일치 또는 미구현 |
| 문자열 `adopted` | **조회 파일에서 미검출** | `hajun_posts.adopted` 경로가 이 트리의 주 경로가 아닐 수 있음 |
| `hajun_posts` 테이블 접근 | **미검출** | SoT가 `hajun_messages` 쪽으로 이동한 흔적 |
| 결정 표현 | `msg_type: 'decision'` 메시지 + product_validation `metadata.decision === 'pass'` | **다른 모델** — 플래그 컬럼이 아닌 메시지 타입 |

---

## 4. 현재 제품 모델 (관측)

`types/hajun.ts` 주석:

> Single Source of Truth: `hajun_yards` / `hajun_rooms` / `hajun_messages`

- 메시지 타입에 `decision` 포함
- `hajunApiPost`: `msg_type === 'decision'` 이고 상품검증 메타가 `pass`이면 listing draft 생성 (`ensureListingDraftFromPass`)
- Room context 조립 시 메시지 목록을 요약 문자열로 넣고, **confirmed 필터는 보이지 않음**

즉 ADR-CONFIRM이 말하는 `hajun_posts.confirmed_by_human` 게이트와 **현재 main의 결정 표현이 스키마적으로 분리**되어 있다.

---

## 5. 문서 vs 구현

| 문서 (2026-10-24) | main (2026-11, 관측) |
|-------------------|----------------------|
| `hajun_posts` + `adopted` / `confirmed_by_human` | 주 경로가 `hajun_messages` + `msg_type` |
| prior_decisions = confirmed only | `prior_decisions` 심볼 없음 |
| adopted만으로 결정 주입 금지 | `adopted` 경로 미검출; **대신** decision 메시지가 곧 결정 행위에 가깝게 쓰임 |

**미확인 (이 감사에서 단정하지 않음)**

- production DB에 `hajun_posts` 행·컬럼이 살아 있는지, 다른 브랜치/레거시 워커가 쓰는지
- `mes/integration-1` 등 production 배포 커밋이 main과 동일한지 (STATUS 문서상 production은 `b5c8220` 계열)
- `decision` msg_type이 Human First 확정과 동일한 의미인지 (UI에서 누가 쓰는지)

---

## 6. ADR-CONFIRM 준수 관점

- **스키마 재사용 원칙:** 컬럼이 코드에서 읽히지 않으면 “재사용”은 문서만 존재.
- **자동 승격 금지:** `adopted→confirmed` 코드는 안 보임 (양호 쪽).
- **사람만 확정:** `decision` 메시지 INSERT가 사람/AI 어느 author_type으로 들어오는지는 **추가 추적 필요**.

---

## 7. 권고 (구현 착수 아님)

1. production / 대상 브랜치에서 `confirmed_by_human`·`hajun_posts` 사용 여부 **한 번 더 프로브** (읽기 전용).
2. 제품 결정을 `msg_type=decision`으로 통일할지, `confirmed_by_human`으로 되돌릴지 **제품 결정** (새 ADR 또는 CONFIRM 보완 ADR — 본문 패치 금지).
3. 그 전까지 AI 경로가 `decision`을 자동 INSERT하지 않는지 author_type 감사.

---

## 8. 한 줄

**main 코드 기준으로는 confirmed_by_human / prior_decisions / adopted 경로가 보이지 않고, 결정은 hajun_messages의 decision 타입으로 표현된다. ADR-CONFIRM 게이트와 구현이 아직 맞물리지 않은 상태다.**
