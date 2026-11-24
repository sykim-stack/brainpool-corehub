# HANDOFF — Hermes / Confirm / ADR 승인 프로세스 (2026-11-24)

> 다른 에이전트·작업자가 이어서 작업할 때 **먼저 읽을 맥락 문서**.  
> 코드·DB·배포 승인이 아니다. 문서 경계만 잠긴 상태다.

---

## 1. 오늘 잠긴 것 (Accepted)

| 문서 | 경로 (repo) | 한 줄 |
|------|-------------|--------|
| **ADR-HERMES-000** | `docs/corehub/ADR-HERMES-000-hermes-as-reassembly-layer.md` | Hermes = 독립 코어 아님. 조사·이해·분류·**제안**만. CoreHub가 Fact→Connection→Meaning→Opportunity 수행. 사람 결정. Meaning≠View. 재생성 경로 **미확인**. |
| **ADR-CONFIRM-000** | `docs/corehub/ADR-CONFIRM-000-human-confirmation-vs-ai-adopted.md` | `adopted` ≠ `confirmed_by_human`. R1–R5. 자동 승격·백필 금지. 취소/재확정은 별도 결정. |
| **PROCESS-ADR-approval** | `docs/corehub/PROCESS-ADR-approval-2026-11-24.md` | ADR Accepted = 원칙 잠금 ≠ 코드/DB/배포. 본문 직접 수정 금지(변경=새 ADR). 메타(상태·일자·근거)만 사람 명시 승인 시 갱신. |

## 2. 문서 축 — 남은 열린 항목

| 항목 | 상태 |
|------|------|
| PR `docs/adr-hermes-confirm-process-2026-11-24` → main 병합 | **별도 명시 승인** 대기 |

## 3. 역할 경계 (절대 흐리지 말 것)

- **Hermes**: 기존 메시지·자료를 조사하고 연결 *가능성*을 **제안**. 연결 *수행* 주체 아님.
- **CoreHub**: Fact → Connection → Meaning → Opportunity.
- **사람**: 제안 검토·결정. `confirmed_by_human=true`만 프로젝트 결정.
- **원본**: `messages.content` 등 — AI/Hermes/worker UPDATE 금지 (ADR-ORIGINAL-REF-000).

## 4. 승인 프로세스 요약

1. Proposed 초안 → 사람 검토 → **명시적 발화**로만 Accepted  
   (예: “이 ADR을 Accepted로 변경해”). 단순 동의·침묵·이전 승인 추정 금지.
2. Accepted ≠ 코드 작성·PR 병합·마이그레이션·production 배포.
3. 코드/PR 오픈: 사람의 **명시적 작업 승인** + 범위·브랜치 합의.
4. PR 병합·프로덕션 배포: **별도 명시 승인**.
5. 기존 ADR **본문** 수정 금지. 보완 = 새 ADR. 메타데이터만 허용.

## 5. 이어서 하면 좋은 일 (우선순위 제안, 착수 전 사람 승인)

| # | 작업 | 전제 |
|---|------|------|
| A | ~~ADR-CONFIRM-000 Accepted~~ | **Done 2026-11-24** |
| B | prior_decisions / Room Context가 `confirmed_by_human`만 쓰는지 **읽기 전용** 코드 감사 | CONFIRM Accepted 완료 → 착수 가능(사람 작업 승인 후) |
| C | Meaning/Opportunity **재생성 경로** 존재 여부 조사 (구현 미확인 해소) | 조사만, 구현 아님 |
| D | Hermes 운영 프롬프트 초안 (제안만, 실행 금지 문구 포함) | HERMES Accepted 이미 충족; 사람 작업 승인 후 |
| E | ADR-CONFIRM Accepted 후 ORIGINAL-REF 관련 링크만 메타 갱신 여부 | 본문 수정 아님 |

## 6. 하지 말 것

- Hermes용 새 테이블·병렬 저장소 설계
- adopted → confirmed 자동 백필
- ADR Accepted만으로 마이그레이션/배포
- 기존 Accepted ADR 본문 패치
- Production `grlfocvlfatuvphkyivd` 변경 (별도 재승인 필요)

## 7. 권위 문서 순서

1. ADR-ORIGINAL-REF-000 (원본/참조 경계)  
2. ADR-HERMES-000 (재조립 위치)  
3. ADR-CONFIRM-000 (채택 vs 확정 — Accepted)  
4. PROCESS-ADR-approval (승인 절차)  
5. ADR-002 / ADR-SHARED-OWNER-001 (인증·Owner — 별 축)

## 8. 브랜치·커밋

- Repo: `sykim-stack/brainpool-corehub`
- Branch: `docs/adr-hermes-confirm-process-2026-11-24`
- main 병합·배포는 **별도 명시 승인** 후.

## 9. 한 줄

**구조는 그대로 두고, Hermes/Confirm/승인 절차의 위치만 문서에 잠갔다. 다음 작업자는 이 HANDOFF → Accepted ADR을 읽고, 구현은 사람 명시 승인 후에만 한다.**
