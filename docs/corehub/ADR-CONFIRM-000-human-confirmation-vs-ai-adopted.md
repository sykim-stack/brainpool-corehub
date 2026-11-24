# ADR-CONFIRM-000: Human Confirmation vs AI Adopted

- **상태:** Proposed
- **작성일:** 2026-11-24
- **결정 소유:** 사람 (Human First)
- **관련:**
  - ADR-ORIGINAL-REF-000 (Accepted) — R3·R4, 승격 규칙
  - ADR-HERMES-000 (Accepted) — 제안 레이어, 자동 승격 금지
  - NOTE-hajun_posts-confirmed-migration-2026-10-24.md (Applied, user-reported)
  - SQL: `20261024_hajun_posts_confirmed_by_human.sql`
  - AUDIT-write-paths-original-vs-reference-2026-10-24.md

---

## 1. 목적과 범위

이 ADR의 목적은 **사람 확정과 AI 채택을 분리하는 규칙을 한곳에 고정**하는 것이다.

이미 ADR-ORIGINAL-REF-000, NOTE, 마이그레이션 SQL, Hermes ADR에 흩어져 있던 원칙을 모은다.  
새로운 승인 시스템·새 테이블·새 워크플로를 설계하지 않는다.

- 기존 `hajun_posts` 컬럼을 재사용한다.
- 설계 문서와 실제 코드 경로를 구분한다.
- 미확인 사항은 미확인으로 남긴다.

---

## 2. 한 줄

**`adopted`는 AI 라운드 선택일 뿐 프로젝트 결정이 아니다. 프로젝트 결정은 `confirmed_by_human=true`일 때만이다. AI·Hermes·파이프라인은 adopted를 confirmed로 자동 승격하지 않는다.**

---

## 3. 정의 (Normative)

| 용어 | 의미 | 프로젝트 결정 여부 |
|------|------|-------------------|
| **adopted** | AI 라운드에서 선택된 답/초안 | **아님** |
| **confirmed_by_human** | 사람이 프로젝트 결정으로 수용함 | **예** |
| **confirmed_at** | confirmed_by_human이 true가 된 시각 | — |
| **confirmed_by** | 확정한 주체 식별 (auth uid, owner_key, operator id 등). 실제 식별자 형식과 인증 주체 검증은 별도 인증 경계 결정에 따른다. 본 ADR은 식별 체계를 확정하지 않는다. | — |

### 3.1 분리 규칙

- `adopted`와 `confirmed_by_human`은 **독립**이다.
- `adopted = true`가 `confirmed_by_human = true`를 함의하지 않는다.
- **adopted → confirmed 백필·자동 복사 금지.**

### 3.2 사용 규칙 (의도)

| 용도 | 사용해야 할 플래그 | 사용하면 안 되는 플래그 |
|------|-------------------|------------------------|
| prior_decisions / 프로젝트 결정 주입 | `confirmed_by_human = true` | `adopted`만 |
| AI 라운드 선택·후보 표시 | `adopted` | — |
| 사람 미확정 후보 목록 | `adopted = true` AND `confirmed_by_human = false` 등 | — |

문서화된 의도: Room Context / prior_decisions는 **confirmed_by_human=true만** 결정으로 쓴다.  
`adopted=true`만으로 결정 주입하는 경로가 있으면 제거 대상이다.  
(코드 경로의 실제 준수 여부는 §6 미확인.)

---

## 4. 스키마 (기존 재사용)

대상 테이블: `public.hajun_posts`

| 컬럼 | 타입 | 기본 | 비고 |
|------|------|------|------|
| `adopted` | boolean (기존) | — | AI 선택. 의미 변경 없음 |
| `confirmed_by_human` | boolean not null | false | 사람 확정 |
| `confirmed_at` | timestamptz null | null | 확정 시각 |
| `confirmed_by` | text null | null | 확정 주체 식별. 형식·검증은 별도 인증 경계에 따름 (본 ADR에서 체계 미확정) |

- 마이그레이션: `20261024_hajun_posts_confirmed_by_human.sql`
- 적용 상태: **user-reported Applied 2026-10-24** (NOTE). VERIFY 당시 confirmed_n=0 기대(백필 없음).
- 이 ADR은 컬럼을 새로 만들지 않는다. 이미 있는 컬럼의 **의미와 쓰기 규칙**만 고정한다.

---

## 5. 쓰기·승격 규칙 (Normative)

### R1 — 자동 승격 금지

- AI, Hermes, CoreHub worker, 배치 작업은  
  `confirmed_by_human`을 `adopted` 값으로부터 설정하지 않는다.
- Opportunity / Hermes 제안 / `adopted` 결과가  
  자동으로 원본(`messages` 등)이나 프로젝트 결정이 되지 않는다.  
  (ADR-ORIGINAL-REF-000 R3 · ADR-HERMES-000과 동일)

### R2 — 사람만 확정

- `confirmed_by_human = true`로의 전환은 **사람 행위** 또는 사람이 승인한 경로만 허용한다.
- 확정 API/UI의 구체 구현은 이 ADR 범위 밖이다.  
  구현 시에도 R1·R2를 깨지 않아야 한다.

### R3 — 원본 불변

- 확정 여부와 관계없이, 참조 계층(Hermes·Hajun·CoreHub)이  
  `messages.content` 등 원본을 UPDATE하지 않는다.  
  (ADR-ORIGINAL-REF-000 R1)

### R4 — 승격 경로

- 참조 → 원본·프로젝트 결정으로의 승격은  
  **사람 승인 후 기존 Core API**만 사용한다.  
  Hermes/AI 직접 write 금지.

### R5 — 확정 취소 및 재확정

- 확정 취소 및 재확정의 **구체적인 처리 규칙은 본 ADR의 범위 밖**이다.
- 별도 결정 없이 `confirmed_by_human` 값을 자동으로 변경하거나 확정 상태를 자동 처리하지 않는다.
- 확정 취소 및 재확정이 필요한 경우 **별도 결정과 사람의 명시적 승인**을 따른다.

---

## 6. 설계 vs 구현 상태

| 항목 | 문서·스키마 | 구현·Live (조사 시점) |
|------|-------------|------------------------|
| 컬럼 존재 | SQL·NOTE에 정의 | user-reported 적용. 인벤토리 당시 프로브와 NOTE 적용 보고 사이 시차 있음 |
| adopted ≠ confirmed | 본 ADR + ORIGINAL-REF R4 | 원칙 문서화됨 |
| prior_decisions가 confirmed만 쓰는지 | NOTE·의도 명시 | **코드 경로 완전 검증 미확인** |
| adopted만으로 결정 주입 경로 제거 | NOTE에 “있으면 제거” | **미확인** |
| 확정 API/UI | 범위 밖 | 미구현 또는 미확인 |

문서가 Accepted여도 코드 준수가 자동으로 보장되지 않는다.  
준수 확인은 별도 코드 감사·테스트 작업이다.

---

## 7. 하지 않는 것 (Out of Scope)

- 새 테이블·새 스키마 제안
- 확정 API/UI 설계·구현
- adopted → confirmed 일괄 백필
- 확정 취소·재확정의 구체 처리 규칙 (R5: 별도 결정·사람 명시 승인 필요)
- `confirmed_by` 식별자 형식 및 인증 주체 검증 체계 (별도 인증 경계)
- ADR-ORIGINAL-REF-000 · ADR-HERMES-000 원본 수정
- Production 코드가 이미 규칙을 지킨다고 선언
- Owner/인증 경계 해결 (별도 영역)

---

## 8. 결과 (Consequences)

**긍정**

- AI 선택과 사람 결정의 경계가 한 문서에 고정된다.
- Hermes 제안·Opportunity·adopted가 “이미 결정된 것”으로 오해되는 경로를 문서 수준에서 차단한다.
- 기존 컬럼·마이그레이션을 재사용한다 (Evolution over Expansion).

**비용 / 남은 일**

- prior_decisions / Room Context 코드 경로 감사
- adopted-only 결정 주입 경로 유무 확인 및 제거
- 확정 API/UI는 필요 시 별도 작업
- Live VERIFY(컬럼·confirmed_n) 재확인이 필요하면 읽기 전용 프로브

---

## 9. 한 줄 (재확인)

**AI가 고른 것(adopted)은 후보일 뿐이고, 사람이 찍은 것(confirmed_by_human)만 결정이다. 둘을 자동으로 묶지 않는다.**
