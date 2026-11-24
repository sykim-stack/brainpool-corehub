# REPORT-C — Meaning / Opportunity 재생성 경로 조사

- **일자:** 2026-11-24
- **성격:** 읽기 전용. 코드 변경 없음.
- **범위:** `sykim-stack/brainpool-corehub` main — `app/api/corehub/facts/route.js`, `opportunities/route.js`
- **질문:** “해석과 참조는 다시 생성할 수 있다”는 **원칙**에 대해, **실제 재계산·재생성 API/잡이 있는가?**

---

## 1. 관측된 생성 경로 (단방향 insert)

`facts/route.js` (POST 처리 후 파이프라인):

1. Fact insert (`processed: false` 등)
2. 규칙 매칭 → **Connection insert**
3. `generateMeaning` → **meanings insert** (고정 meaningMap)
4. `generateOpportunity` → **opportunities insert** (고정 opportunityMap)

Meaning 타입 예: `seed.at.risk`, `new.relationship.forming`, `goal.achieved`  
Opportunity 예: `nudge.seed.owner`, `suggest.translation.help`, `celebrate.achievement`

**모두 `.insert(...)`.** 기존 meaning/opportunity를 지우고 다시 쓰거나, 동일 입력에 대해 recompute하는 함수는 **이 파일에서 없음**.

---

## 2. Opportunities API

`opportunities/route.js` (P4.3):

- **GET** — 스코프된 조회
- **PATCH** — 소비(consume) 처리
- HMAC 경로는 `501 hmac_not_implemented`

재생성·재계산 엔드포인트 아님.

---

## 3. 원칙 vs 설계 vs 구현 (ADR-HERMES 표현 정렬)

| 층 | 상태 |
|----|------|
| **원칙** | 해석·참조는 다시 생성할 수 있다 |
| **설계 대응** | CoreHub Meaning / Opportunity 테이블 + Fact 파이프라인 |
| **실제 구현 (main)** | **최초 생성(insert)만 확인.** 재생성·재계산 경로 **미확인 → 사실상 부재로 관측** |

---

## 4. 미확인

- staging/다른 브랜치에 recompute worker가 있는지
- DB 트리거/RPC로 meaning을 갱신하는지 (코드 경로 밖)
- 동일 connection에 대해 meaning을 중복 insert하는지 unique 제약

---

## 5. 한 줄

**CoreHub main은 Fact 유입 시 Meaning·Opportunity를 한 번 insert하는 파이프라인만 있고, 재계산/재생성 전용 경로는 관측되지 않았다.**
