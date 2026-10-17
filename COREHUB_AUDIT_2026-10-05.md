# BrainPool CoreHub 저장소·운영 DB 종합 감사

- **점검일:** 2026-10-05
- **저장소:** [`sykim-stack/brainpool-corehub`](https://github.com/sykim-stack/brainpool-corehub)
- **점검 기준:** `main` 브랜치 `6412417` (`2026-07-18`, `fix: pattern priority + break after first match`)
- **범위:** 저장소 소스·설계 문서·의존성 및 연결된 Supabase `corehub` 스키마의 메타데이터와 Advisor 결과. 운영 데이터 내용은 열람하지 않음.
- **요약 판정:** **취약 의존성은 수정·재검증했으나, 현재 구현은 공개 환경에서 안전하고 신뢰할 수 있는 프로덕션 API라고 보기 어렵다.** 인증 부재, 잘못된 근거 Fact 연결, 이벤트 중복 생성, 비내구성 후처리는 여전히 해결해야 한다.

> **우선 결론:** 실제 Supabase에서 `corehub`의 5개 테이블은 모두 RLS가 켜져 있으나 정책은 하나도 없다. API 서버가 `SUPABASE_SERVICE_ROLE_KEY`로 연결되면 이 RLS는 우회된다. 그런데 저장소의 두 API 모두 호출자를 인증·인가하지 않으므로, 해당 키가 배포 환경에 설정되어 외부에서 API에 닿을 수 있는 경우 누구나 타 사용자 Fact를 조회하고 Fact·기회 데이터를 조작할 가능성이 있다. 실제 배포 URL과 환경변수는 확인하지 않았으므로 **노출 여부 자체는 조건부**다.

**후속 조치(2026-10-05):** Next.js `15.5.27`, PostCSS `8.5.28`(Next 한정 override), nanoid `3.3.19`로 업데이트했다. 클린 `npm ci` 이후 전체/프로덕션 `npm audit` 모두 **취약점 0건**, production build 성공을 확인했다.

## 1. 우선순위별 주요 발견

| 심각도 | 발견 사항 | 영향 |
|---|---|---|
| **치명적** | 인증·소유권 검증 없는 API와 service-role 연결 경로 | 배포 시 전 사용자 데이터 열람·위조·소비 처리 위험 |
| **높음** | `matchedFacts`가 항상 최근 Fact 전체를 고르는 버그 | 연결/의미의 근거가 오염되어 잘못된 추천 생성 |
| **높음** | 저장 성공 응답 뒤 연결 분석을 fire-and-forget | 함수가 종료되면 처리 누락, 재시도·복구 없음 |
| **높음** | 패턴 중복 방지·이벤트 멱등성 없음 | Connection·Meaning·Opportunity가 이벤트마다 누적 중복 |
| **해결됨** | 원점검의 npm 취약점(Critical 1, High 2) | Next.js 15.5.27 등으로 업데이트; 재검사 0건 |
| **높음** | Supabase `corehub` RLS 정책 0개 | RLS를 경계로 기대하는 접근은 막히거나, service role에선 보호가 적용되지 않음 |
| **중간** | seed abandonment 오탐·priority 정렬 오류·입력 검증 부족 | 잘못된 알림/추천, 요청에 의한 오류·과다 처리 |
| **중간** | 테스트·CI·DB 마이그레이션·린트 설정 부재 | 변경 안전성과 배포 재현성을 확인하기 어려움 |

## 2. 상세 문제

### C-01. API가 인증·인가를 하지 않음 — 치명적

**근거:** `app/api/corehub/facts/route.js:10–27, 56–79`, `app/api/corehub/opportunities/route.js:13–28, 30–87`.

- Fact POST는 `source`, `fact_type`, `owner_key` 문자열만 있으면 삽입을 시도한다. 누구의 이벤트를 보낼 권한이 있는지 확인하지 않는다.
- Fact GET은 `owner_key`가 선택 사항이어서, 인증이 없는 호출자가 필터를 빼고 Fact를 조회할 수 있다. 결과에서 `select('*')`로 `payload`를 포함한 모든 컬럼을 반환한다.
- Opportunity GET은 공개 `id` 조회 경로와 `owner_key` 조회 경로 모두 요청자의 신원을 증명하지 않는다.
- Opportunity PATCH는 ID만으로 레코드를 소비 처리한다. 해당 사용자의 소유인지, 이미 소비됐는지 확인하지 않는다. body의 `opportunity_id`가 query의 `id`보다 우선할 수도 있다.
- `lib/supabase.ts:9–10`은 `SUPABASE_SERVICE_ROLE_KEY`를 우선 사용한다. 이 키가 배포되어 있으면 RLS 정책을 우회한다. `SUPABASE_KEY`라는 역할이 모호한 대체 환경변수도 있다.
- Opportunity API는 `Access-Control-Allow-Origin: *`를 적용한다. CORS는 인증 대체 수단이 아니다. 현재 무인증 상태에서는 브라우저 호출을 폭넓게 허용하는 설정이 위험을 키운다.

**권고:** 외부에 노출하기 전에 인증 게이트를 필수화한다. 서비스 간 호출이면 짧은 수명의 서명된 서비스 토큰(HMAC/JWT 등), 만료·audience 검증과 키 회전을 둔다. `owner_key`는 요청 본문/쿼리 값이 아니라 검증된 주체의 권한 정보에서 결정하고 모든 SELECT·UPDATE에 소유자 조건을 포함한다. 브라우저가 직접 호출해야 한다면 인증된 사용자 JWT와 소유권 RLS를 별도로 설계한다. 허용 origin은 실제 클라이언트 목록으로 제한한다.

### C-02. 연결된 Fact 목록 필터가 항상 참임 — 높음

**근거:** `app/api/corehub/facts/route.js:93–96, 123–127`.

```js
const factTypes = recentFacts.map(f => f.fact_type)
const matchedFacts = recentFacts.filter(f => factTypes.includes(f.fact_type))
```

`factTypes`를 바로 `recentFacts`에서 만든 뒤 같은 배열의 항목을 검사하므로, 모든 행의 `fact_type`은 `factTypes`에 반드시 들어 있다. 따라서 `matchedFacts`는 패턴의 근거 이벤트만이 아니라 **최근 Fact 전부**가 된다. 잘못된 Fact 집합이 `connections.fact_ids`와 `meanings.source_fact_ids`에 저장되어, 나중에 생성된 추천의 근거를 감사·설명하기 어렵게 한다.

**권고:** 각 패턴이 요구하는 Fact ID·유형을 명시해 정확히 필터하고, 필수 조합·owner·house·시간 창을 모두 만족하는 경우에만 저장한다. 패턴별 테스트에서 연결 ID 배열을 검증한다.

### C-03. 후처리가 내구성 없는 fire-and-forget — 높음

**근거:** `app/api/corehub/facts/route.js:48–53`.

Fact를 저장한 뒤 `detectConnections(...).catch(...)`를 호출하고 기다리지 않은 채 성공 응답을 보낸다. 예외는 로그만 남고 재처리 큐나 복구 절차는 없다. 서버리스 실행 환경에서는 응답 이후 작업 완료가 보장되지 않으므로, Fact는 저장됐지만 Connection·Meaning·Opportunity는 빠지는 부분 실패가 발생할 수 있다.

**권고:** 가장 안전한 방식은 트랜잭션성 Outbox/작업 테이블과 재시도 가능한 워커다. `processed` 상태·시도 횟수·실패 사유·마지막 처리 시각을 실제 처리 흐름에 연결한다. 플랫폼의 사후 응답 작업 기능만 사용하는 경우에도 플랫폼 보장 범위를 확인하고, 오류를 재시도할 내구성 큐를 유지한다.

### C-04. 패턴이 반복 매칭되어 데이터·알림이 중복 생성 — 높음

**근거:** `facts/route.js:82–91, 123–148, 152–179, 182–223`.

- 연결 검사는 새 Fact에 대한 한 번의 이벤트가 아니라 최근 10개 Fact 안에 패턴이 존재하는지를 매번 검사한다.
- 해당 조건이 유지된 상태에서 무관한 Fact가 하나 들어와도 같은 패턴이 다시 삽입될 수 있다. 동시 Fact 유입 시에는 중복 가능성이 더 커진다.
- Connection → Meaning → Opportunity 각각에 중복 키·유일 제약·멱등성 키가 없고, 세 삽입 결과의 오류도 일관되게 확인하지 않는다.
- `processed` 컬럼은 입력 때 `false`로 저장되지만 소비·갱신되지 않는다.

**권고:** 정규화한 패턴 종류와 근거 Fact ID 집합으로 멱등성 fingerprint를 만들고 DB 유일 제약을 둔다. 한 Fact당 처리 상태 전이를 원자적으로 관리하고, 연결·의미·추천 생성 단계를 트랜잭션이나 Outbox 기반 상태 머신으로 묶는다.

### C-05. abandonment 위험 패턴이 즉시 오탐할 수 있음 — 높음

**근거:** `facts/route.js:113–119`.

`space.seed.created`는 최근 10개에 있고 `space.room.visited`와 `space.fruit.created`만 없으면 abandonment 위험으로 판단한다. seed 생성 직후 다른 Fact 하나만 추가돼도 최근 10개에 seed가 남아 있다면 위험 추천이 가능하다. “며칠 동안 활동 없음” 같은 경과 시간 조건이 없고, 10개 창에서 방문 이벤트가 빠졌다는 사실만으로 ‘방문 이력 없음’이라고 볼 수도 없다.

**권고:** seed 생성 시각부터 적절한 대기 기간, 같은 seed/room을 대상으로 한 방문·열매 여부, 최근 활동, 이미 보낸 추천 여부를 확인한다. 위험 판단 창과 추천 만료 정책을 도메인 규칙으로 명시한다.

### C-06. npm 런타임 취약점 — 해결 완료

초기 점검 당시 `npm audit`는 **총 3개: Critical 1, High 2**를 보고했다. 다음 표의 버전은 모두 **수정 전 잠금 파일 기준**이다.

| 패키지 | 잠금 파일 설치 버전 | npm audit 결과 | 참고 |
|---|---:|---|---|
| `next` | `14.2.35` | Critical | 다수 보안 권고 범위에 포함. 실제 악용 가능성은 배포 플랫폼·사용 기능·요청 경로에 따라 달라짐. |
| `postcss` | `8.4.31` | High | Next.js의 전이 의존성 |
| `nanoid` | `3.3.15` | High | Next.js/PostCSS 쪽 전이 의존성 |

- [Next.js GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36)
- [Next.js GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)
- [PostCSS GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)
- [nanoid GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)

**수정 내용:** Next.js 공식 [2026년 9월 보안 릴리스](https://nextjs.org/blog/september-2026-security-release)의 Maintenance LTS 패치 `15.5.27`로 올렸다. Next 15.5.27은 PostCSS `8.4.31`을 정확한 버전으로 고정하므로, 취약 범위를 벗어난 PostCSS `8.5.28`을 Next 하위 의존성 override로 적용했다. nanoid는 `3.3.19`로 갱신됐다. Next 16으로의 강제 major 업그레이드는 하지 않았다.

**수정 후 검증:** `npm ci` 성공, `npm audit --omit=dev`와 전체 `npm audit` 모두 **0 vulnerabilities**, Next.js production build 및 타입 검사 성공. 설치된 버전은 Next `15.5.27`, PostCSS `8.5.28`, nanoid `3.3.19`다. npm audit 매치 해소는 알려진 버전 취약성의 제거를 뜻하며, 이 보고서에서 실환경 익스플로잇 테스트를 수행한 것은 아니다.

### C-07. 운영 DB의 CoreHub RLS는 켜져 있지만 정책이 전혀 없음 — 높음

연결된 DB `grlfocvlfatuvphkyivd`에서 읽기 전용 메타데이터 점검을 수행했다.

- `corehub.facts`, `connections`, `meanings`, `opportunities`, `learning_logs` 5개 테이블 모두 존재하고, 모두 RLS enabled.
- `pg_policies` 조회 결과 **corehub 정책 0개**. Supabase Security Advisor도 이 5개 테이블 모두 `RLS Enabled No Policy`로 표시했다.
- 테이블 메타데이터상 행 수는 각각 facts 40, connections 20, meanings 17, opportunities 17, learning_logs 0으로 보고되었다. 사용자 데이터 내용은 확인하지 않았다.
- 이 설정은 anon/authenticated 역할의 직접 접근을 막을 수 있지만, **service_role을 사용하는 API 서버에는 보안 경계가 되지 않는다.** 반대로 `SUPABASE_KEY`가 anon 키로 설정된 배포라면 현재 RLS 정책 없이 API 쿼리가 실패할 수 있다.

**권고:** API 서버만 DB에 접근하는 설계라면 비밀 service key는 서버 환경에만 보관하되, API 앞단에서 모든 요청을 인증하고 서비스 수준 권한을 최소화한다. 클라이언트 직접 접근이 필요하면 소유권 기준 RLS 정책을 구체적으로 작성·테스트한다. 두 경로를 섞지 않는다.

### C-08. 입력 검증·오류 계약이 불충분 — 중간

**근거:** 두 `route.js`의 JSON 처리와 응답 분기.

- Facts POST의 `JSON.parse(await req.text())`가 try/catch 없이 실행된다. 잘못된 JSON은 `traceId`가 포함된 API 오류 응답으로 정리되지 않는다.
- 필수 필드 존재만 검사할 뿐 문자열 형식·허용 source/type·길이·UUID·`occurred_at` 유효성·payload 최대 크기를 검증하지 않는다.
- Facts GET의 `limit`은 `parseInt` 후 최소·최대 범위 검증이 없다. 임의로 크거나 잘못된 값이 DB 쿼리 오류나 자원 사용 증가를 유발할 수 있다.
- Opportunity PATCH에서 JSON 파싱은 보호하지만 body가 `null`, 배열, 예상하지 못한 타입인 경우 구조 분해·DB 작업이 실패할 수 있다. `outcome` 값도 enum 검증이 없다.
- 잘못된 입력, 미존재 행, 잘못된 메서드도 다수 `500`을 반환한다. 기대 가능한 오류는 400/404/405 등으로 구분하지 않는다. 설계 문서의 “200 또는 500만” 계약을 따르지만, 그 계약 자체가 클라이언트 재시도와 장애 분류를 어렵게 한다.
- DB 오류 문자열을 응답에 그대로 포함하는 경로가 있다(`opportunities/route.js:54, 77`). 내부 스키마·DB 오류 세부를 외부에 노출할 필요가 없다.

**권고:** Zod 등의 런타임 스키마, body 크기 제한, allowlist, limit 1–100 제한, 서버 오류 메시지 정제, traceId 기반 서버 로그, 올바른 상태 코드를 적용한다.

### C-09. Opportunity 정렬이 priority 의미와 반대 — 중간

**근거:** `opportunities/route.js:44–52`는 `priority`가 text인데 문자열 내림차순으로 정렬한다. 값이 `high`, `medium`, `low`라면 일반 사전식 순서는 업무 우선순위(`high > medium > low`)와 맞지 않는다. 보통 `medium`, `low`, `high` 순으로 나올 수 있어 화면/소비자의 최우선 추천이 뒤로 밀린다.

**권고:** 숫자 priority 컬럼/별도 순위 컬럼을 사용하거나 DB에서 명시적 순위표를 적용하고, 정렬 순서를 테스트한다. 만료·생성 시각의 tie-break 규칙도 명확히 둔다.

### C-10. 로그에 owner 식별자를 기록 — 중간 이하

**근거:** `facts/route.js:46`, `opportunities/route.js:86`.

`owner_key`를 일반 애플리케이션 로그에 남긴다. 실제 값이 가명이라도 계정 간 추적이 가능한 식별자일 수 있다. 요청 본문이나 민감 payload는 현재 출력하지 않는 점은 긍정적이나, 개인 데이터 보존기간·접근통제는 별도 검증 대상이다.

**권고:** 사용자 키는 마스킹/해시화하고 구조화 로그에 traceId, 오류 코드, 안전한 내부 식별자만 남긴다.

### C-11. 코드·문서·실제 운영 스키마 및 품질 관리의 간극 — 중간

- 설계 문서는 facts/connect/meanings/opportunities API와 엔진 모듈 4개를 계획하지만 저장소에는 facts/opportunities 두 Route Handler만 있다. `connect`, `meanings` 라우트, 엔진 모듈, `types/corehub.ts`는 없다. 현재 일부 처리 경로가 facts route 안에 직접 들어 있다.
- README는 제목 한 줄뿐이고 사용법·환경변수·로컬 실행·배포·API 계약을 설명하지 않는다.
- DB 마이그레이션 파일·테스트·GitHub Actions/CI 설정을 찾지 못했다. 운영 DB의 테이블은 존재하나 Git 저장소에서 그 상태를 재현하거나 코드와 동기화하는 절차가 없다.
- `main` 브랜치 보호는 GitHub API에서 설정되지 않은 것으로 확인했다. CI가 없고 branch protection도 없으므로 잘못된 변경이 검증 없이 합쳐질 수 있다.
- `npm run lint`는 실행되지만 ESLint 설정 파일이 없어 첫 실행에 대화형 설정 프롬프트가 뜨고 종료 코드 1로 끝났다. 따라서 자동 lint 경로로 쓸 수 없다.
- 오류 응답이 모든 분기에서 일관되게 traceId를 반환하지 않으며, `learning_logs`, meaning, opportunity 삽입 오류를 모두 확인하지 않는다.

**권고:** Supabase migration을 버전 관리하고, CI에서 lint·typecheck·unit/integration test·`npm audit`를 실행한다. main 보호와 필수 검사 조건을 둔다. README에 정확한 인증 헤더, 요청/응답 예시, 상태 코드, 환경변수 주의사항을 쓴다.

## 3. 실제 DB Advisor — 저장소 외 공유 DB 범위

CoreHub 테이블 외에 연결된 Supabase **공유 DB 전체**를 대상으로 한 Security Advisor에서 다음과 같은 별도 항목도 발견됐다. 이는 본 저장소 자체의 코드 결함으로 귀속시키면 안 되며, 다른 스키마·서비스의 영향일 수 있다.

- anon 및 authenticated 역할이 실행 가능한 `SECURITY DEFINER` 함수 9개가 보고됨.
- `SECURITY DEFINER` 속성의 view 2개가 보고됨.
- `search_path`가 고정되지 않은 함수 23개가 보고됨.
- 보안 권고 remediation: [Supabase Database Linter 문서](https://supabase.com/docs/guides/database/database-linter).
- CoreHub 성능 항목: 외래키 인덱스가 없는 `corehub.opportunities.source_meaning_id`, `corehub.learning_logs.opportunity_id`가 Advisor에 보고됨.

공유 DB 권한·함수·view를 수정하면 다른 서비스에 영향이 갈 수 있으므로, 소유 서비스별 확인과 회귀 검증 없이 일괄 변경하지 않는 것이 좋다.

## 4. 검증 결과와 범위 한계

| 검사 | 결과 |
|---|---|
| `npm ci` | **성공**; 수정된 잠금 파일 기준 클린 설치 |
| `npm run build` | **성공**; Next.js 15.5.27 production build 및 타입 검사 통과 |
| `npm run lint` | **실패(exit 1)**; ESLint 설정 대화형 초기설정에서 자동 실행 불가 |
| `npm audit --omit=dev` 및 전체 `npm audit` | **둘 다 0 vulnerabilities** (수정 후 재검증) |
| DB schema/table metadata | CoreHub 5개 테이블 확인, 설계 컬럼과 주요 구조 대체로 일치 |
| CoreHub RLS policies | **0개** 확인 |
| GitHub main protection | 보호 설정 없음 확인 |
| 앱 동작/공개 배포 엔드포인트 실호출 | 이번 점검 범위에서 수행하지 않음 |
| 인증 환경변수의 실제 배포 값 | 비밀값이므로 열람하지 않았고, 배포 환경도 미확인 |

빌드 통과는 컴파일 가능성을 뜻할 뿐, 인증·권한·DB 실연동 동작이나 비즈니스 로직 정확성을 입증하지 않는다. `npm audit` 0건은 검사 시점 의존성 공지 매치가 없음을 뜻하며 실환경 익스플로잇 테스트가 아니다.

## 5. 권고 조치 순서

1. **외부 배포가 있다면 즉시 점검:** 인증 없는 facts/opportunities API를 인증 게이트 뒤에 두거나 외부 접근을 차단한다. service-role이 설정된 상태로 공개됐을 가능성이 있으면 접근 로그를 검토하고 키 회전을 검토한다.
2. **인증·인가와 입력 검증:** 서비스 신원 검증, owner 소유권 확인, 허용 필드/ID/크기/limit 검증, 구체적인 상태 코드, 정보 노출이 적은 오류 응답.
3. **논리 정확성 수정:** `matchedFacts` 필터를 패턴 기반으로 고치고, abandonment 조건에 경과 시간·같은 seed의 실제 후속 이벤트를 반영한다. priority 정렬을 명시적 우선순위로 바꾼다.
4. **중복 및 유실 방지:** DB 유일 제약/멱등성 키와 내구성 있는 처리 큐·재시도·상태 전이를 도입한다.
5. **운영 재현성:** 기존 운영 스키마를 migration으로 추적하고, 테스트·lint·CI·main 보호를 설정한다. CoreHub 외 shared DB Advisor 항목은 별도 소유자 검토로 분리한다.

## 6. 결론

CoreHub는 **작은 초기 구현으로 빌드는 되며, npm 취약점은 수정됐지만 공개 운영 전 차단해야 할 인증 및 데이터 생성 신뢰성 결함이 남아 있다.** 다음 개선 목표는 기능 추가보다 **API 인증/권한**을 고정하고, 그 다음 **잘못된 Fact 연결과 중복·유실 처리**를 바로잡는 것이다. 테스트/마이그레이션 체계도 마련해야 한다.


## 7. 후속 작업 — Auth UID 및 이벤트 무결성 (2026-10-05)

사용자가 **새 소유권 기준은 Supabase Auth UID이며 기존 CoreNull/CoreHub 자료는 소유 확인 전 자동 연결하지 않음**으로 확정했다. 아래 변경은 `security/corehub-event-integrity-2026-10-05` 작업 브랜치에만 있으며, 운영 migration/API 배포는 하지 않았다.

### 구현 내용

- Facts 및 Opportunities handler에서 `Authorization: Bearer`를 Supabase Auth 서버에 검증하고, 사용자 UID는 검증 결과에서만 도출한다. 요청 body/query의 `owner_id`/`owner_key`는 권한으로 받지 않는다.
- House가 붙은 Fact는 `corenull.houses.owner_id`가 토큰 UID와 일치해야 한다. 미연결 legacy house는 거절하고, 기존 CoreHub 행의 소유자도 backfill하지 않는다.
- `corehub` 5개 테이블에 Auth UID 기반 SELECT RLS 정책, 클라이언트 직접 쓰기 금지, 제한된 server-role/API 권한을 정의한 forward migration을 추가했다.
- Fact POST는 stable `Idempotency-Key`를 요구한다. Postgres RPC 하나에서 Fact→Connection→Meaning→Opportunity 및 `processed=true`를 단일 transaction으로 처리하고, 같은 사용자/집 이벤트를 advisory lock으로 직렬화한다. Unique index가 Fact/Connection/Meaning/Opportunity/Learning Log 재시도를 방어한다.
- Fact 매칭은 같은 사용자·집, 동일한 안정 `seed_id` 또는 `conversation_id`, 인과 시간 순서, 정확한 두 Fact만 요구한다. 부재만 보고 abandonment를 단정하지 않고 source가 `space.seed.abandonment_due`를 명시해야 한다.
- README 및 v2 이벤트 계약 문서를 추가/갱신하고, v1 문서의 `owner_key` 및 fire-and-forget 예시를 폐기 표시했다.

### 읽기 전용 운영 DB 집계 — 자동 연결 불가 근거

행 내용은 열람하지 않고 집계만 확인했다. 현재 CoreNull houses 24건 중 `core_user_id` 연결 21건, Auth `owner_id` 1건, `owner_key` 3건이다. CoreHub Facts 40건 중 `house_id`가 존재하는 6건 모두 현재 CoreNull house와 일치하지 않았고, 확인한 `owner_key` 일치 및 Auth owner 연결은 각각 0건이었다. 따라서 기존 자료를 UID에 일괄 연결하지 않는다. 집별 Auth 소유 증명/계정 연결 절차가 별도로 필요하다.

### 검증 및 남은 차단 사항

- `npm test`: **11/11 통과**.
- `npm run build`: Next.js 15.5.27 production build 및 TypeScript 검사 **통과**.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- `git diff --check`: 통과.
- PostgreSQL 16 로컬 mock schema에서 migration 컴파일/적용 성공. Fact replay 1건, 동일 키·다른 payload 거부, 유저별 RLS 격리, seed/fruit 동시 도착 시 connection 1건 생성을 검증했다. 이는 staging/운영 Supabase 적용 검증이 아니다.
- 운영 migration은 **적용하지 않았다**. 실제 CoreNull 앱은 현재 Supabase Auth 기반 로그인을/house owner UID 연결을 제공하지 않고, 저장소에는 CoreHub로 보내는 실제 source integration/outbox도 없다. 따라서 새 API는 JWT와 house UID가 연결될 때까지 의도적으로 fail-closed이고, sender 재시도/outbox 연동 전에는 소스에서 CoreHub까지의 end-to-end 무손실 전송을 보장한다고 주장할 수 없다.
- Supabase Security Advisor가 별도 CoreNull 테이블 `corenull.interests`, `corenull.post_comments`, `corenull.post_reactions`, `corenull.reactions`에서 RLS 비활성을 보고했다. 앞서 제시한 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 4문은 검토 대상으로만 남기며 실행하지 않았다. 정책 없이 RLS를 켜면 현재 API 동작을 막을 수 있어, 해당 테이블 소유자가 접근 정책을 결정해야 한다.
