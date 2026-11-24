# ADR-HERMES-000: Hermes as Reassembly Layer (기존 구조의 위치 관계)

- **상태:** Accepted
- **Accepted 일자:** 2026-11-24
- **작성일:** 2026-11-24
- **결정 소유:** 사람 (Human First)
- **근거:** 조사 결과 + 매핑 수정(역할 경계·Meaning≠View·재생성 원칙/설계/구현 구분) 반영 후 사람 승인
- **관련:**
  - ADR-ORIGINAL-REF-000 (Accepted) — 원본/참조 경계의 권위 문서
  - ADR-CONFIRM-000 (본문 미존재, 이름만 참조됨)
  - ADR-002, ADR-SHARED-OWNER-001
  - CoreHub Fact → Connection → Meaning → Opportunity
  - 조사 산출: 2026-11-24 Hermes 원칙 재조립 조사

---

## 1. 목적과 범위

이 ADR의 목적은 **Hermes를 새롭게 정의하는 것이 아니다.**

이미 BRAINPOOL 안에 존재하는 원칙과 기능을 **Hermes라는 이름 아래에서 어떻게 재조립해서 사용하는지** 위치 관계를 명확히 기록한다.

- 새로운 코어·새로운 저장소·새로운 파이프라인을 만들지 않는다.
- 기존 ADR 원본을 수정하지 않는다.
- 설계 문서와 실제 Production 구현을 구분한다.
- 미확인 사항은 미확인으로 남긴다.

---

## 2. 한 줄

**Hermes는 독립 코어가 아니다. 기존 원본/참조 경계와 CoreHub 파이프라인 위에서, 메시지를 조사하고 관련 맥락·연결 가능성을 발견해 제안하는 운영 레이어다.**

---

## 3. 정체성 · 역할 · 경계 (Normative)

| 구분 | 고정 내용 |
|------|-----------|
| **정체성** | Hermes는 독립 코어가 아니다. 참조 계층의 이해·제안 역할이다. |
| **역할** | 조사 · 이해 · 분류 · 제안. 기존 메시지와 자료를 조사하고, 관련 맥락과 연결 가능성을 발견해 제안한다. |
| **실행 경계** | 원본 수정 금지 · 자동 승격 금지 · 직접 실행 금지. |
| **연결 경계** | 기존 CoreHub 구조와 승인된 Core API를 재사용한다. 새 병렬 저장소·테이블을 만들지 않는다. |

### 3.1 역할 구분 (반드시 유지)

- **Hermes**: 기존 메시지·자료를 조사하고, 관련 맥락과 연결 *가능성*을 발견해 **제안**한다. 연결을 *수행하는* 주체가 아니다.
- **CoreHub**: Fact → Connection → Meaning → Opportunity 구조를 담당한다.
- **사람**: 제안을 검토하고 필요한 결정을 내린다.

Hermes는 연결 수행자가 아니라 **연결할 만한 맥락을 발견하는 조사자**다.

### 3.2 실행 금지 (ORIGINAL-REF와 정렬)

- `messages.content` 등 원본을 UPDATE하지 않는다.
- Opportunity / Hermes 제안 / `adopted` 결과가 자동으로 원본이나 프로젝트 결정이 되지 않는다.
- 승격은 사람 승인 후 기존 Core API만 사용한다.

### 3.3 사람 확정 컬럼

- `confirmed_by_human`(및 관련 컬럼)은 **기존 컬럼을 재사용**한다는 원칙만 적는다.
- 실제 승인 경로가 완성됐다는 표현은 하지 않는다.
- ADR-CONFIRM-000 본문이 아직 없으므로, 그 문서의 규칙을 미리 확정·가져오지 않는다.
- `adopted`와 `confirmed_by_human`은 분리 유지 (adopted = AI 선택, confirmed_by_human = 사람 확정).

---

## 4. 기존 개념과의 매핑 (재조립)

| Hermes 원칙 / 용어 | 기존 BRAINPOOL 개념 | 비고 |
|--------------------|---------------------|------|
| Source는 불변 | 원본 (Original). messages.content 등. AI·worker는 content UPDATE 금지 (ORIGINAL-REF R1) | 이미 잠김 |
| 하나의 사건은 여러 의미를 가질 수 있다 / 복수 맥락 허용 | CoreHub Connection + Meaning (복수 가능 설계) | 용어만 다름. Hermes가 직접 생성·관리하지 않음 |
| 연결 가능성 발견 | Hermes의 조사·제안 역할 | CoreHub가 Connection/Meaning을 담당 |
| View | Source와 참조 정보를 특정 목적에 맞게 보여주는 **표현·표시 계층**. 원본을 덮어쓰지 않음 | Meaning과 동일시하지 않음 |
| Meaning | CoreHub의 의미 연결 개념 | 기존 CoreHub 개념 그대로 유지 |
| AI 제안 · 사람 확정 | Human First. 제안은 참조. 확정은 사람 | confirmed_by_human 컬럼 재사용 원칙만 |
| 해석은 다시 할 수 있다 | **원칙**: 해석과 참조는 다시 생성할 수 있다. **설계 대응**: CoreHub Meaning / Opportunity. **실제 구현**: 재계산·재생성 경로는 **미확인** | 원칙·설계·구현을 구분 |

### 4.1 Meaning과 View를 동일시하지 않음

- **Meaning** = CoreHub의 의미 연결 개념. 기존 파이프라인의 일부.
- **View** = Source와 참조 정보를 특정 목적에 맞게 보여주는 표현·표시 계층. 원본을 덮어쓰지 않는 해석·표시 원칙.
- Meaning을 View의 구현체라고 정의하지 않는다.

### 4.2 재생성 표현 규칙

- 원칙: 해석과 참조는 다시 생성할 수 있다.
- 설계 대응: CoreHub Meaning / Opportunity.
- 실제 구현: 재계산 및 재생성 경로의 작동 여부는 **미확인**. 문서만으로 구현 완료로 간주하지 않는다.

---

## 5. 하지 않는 것 (Out of Scope)

- 새 데이터 구조·테이블·스키마 제안
- 기존 ADR 원본 수정
- Hermes를 실행 주체 또는 독립 코어로 승격
- ADR-CONFIRM-000 규칙을 본문 없이 확정·도입
- Production 구현 완성 선언
- Owner/인증 경계의 안정화 (별도 작업 영역)

---

## 6. 설계 문서 vs 구현 상태 (요약)

| 항목 | 문서/설계 | 구현·Live (조사 시점) |
|------|-----------|------------------------|
| 원본/참조 경계 | ADR-ORIGINAL-REF-000 Accepted | 논리 경계 문서화됨. 물리 분할 없음 |
| CoreHub 파이프라인 | Fact–Connection–Meaning–Opportunity | 스키마 존재. Fact 유입 있음. Opportunity 상대적 희소. 재생성 경로 미확인 |
| confirmed_by_human | 컬럼 존재·재사용 원칙 | 스키마 적용 보고됨. 코드 경로 완전 검증은 미확인 |
| Hermes 런타임 | 참조 계층 제안 역할 | 독립 서비스/테이블 미확인. 개념적 레이어 |
| Owner·인증 | SHARED-OWNER 등 | 아직 안정화되지 않음 (P4, handoff 등 진행 중) |

문서가 Accepted라고 해서 코드까지 완성된 것은 아니다.

---

## 7. 결과 (Consequences)

**긍정**

- Hermes가 “새 시스템”이 아니라 기존 구조의 재조립임이 문서화된다.
- CoreHub와 Hermes의 역할 경계가 흐려지지 않는다.
- Meaning과 View, 원칙·설계·구현이 혼동되지 않는다.
- 원본 보존 · 자동 승격 금지 · Human First가 유지된다.

**비용 / 남은 일**

- ADR-CONFIRM-000 본문 작성은 별도.
- confirmed 경로의 코드 검증, Opportunity/Meaning 재생성 경로 확인은 별도 조사.
- Owner·인증 안정화는 Hermes 범위 밖.

---

## 8. 한 줄 (재확인)

**구조는 그대로 두고, Hermes라는 이름 아래에서 기존 원칙과 기능을 어떻게 조사·제안 레이어로 쓰는지 위치만 명확히 한다. 연결을 수행하는 것은 CoreHub이고, 결정을 내리는 것은 사람이다.**
