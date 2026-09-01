# PLAN-GATE — edit-gate 재설계 실행 계획

> 2026-09-01, 커밋 게이트를 edit 게이트로 교체하는 리디자인의 설계 기록.
> 배경 논의와 결정은 이 문서가 유일한 기록이다. PLAN.md §6.1의 pre-commit
> 게이트 서술은 이 문서로 대체된다 (PLAN-GRAPHIFY.md와 무관 — 그쪽 결과는 유효).

## 0. 확정된 결정 (사용자, 2026-09-01)

1. **종단 배포 스터디.** 실제로 Claude Code로 개발하는 팀에 배포하고, 그 팀의
   코드베이스에 적용해 효과를 분석한다. 실험실 세션이 아니다. controlled
   experiment가 아니라 technology probe — 정책은 조작 변수가 아니라 측정 변수.
2. **게이트는 commit이 아니라 edit 시점에 선다.** 잠긴 영토를 건드리는
   Edit/Write/MultiEdit가 트리거. **커밋 게이트는 제거한다** (백스톱으로도
   남기지 않음 — 깔끔한 교체).
3. **통과 = 영구 언락.** 체크를 통과한 component는 이후 퀴즈 없이 edit 승인.
   재잠금은 반란(rebellion)만이 일으킨다.
4. **반란 = collaborator의 변경.** 남이 그 component의 sources를 바꾸면 stale
   (반란)로 전환 + 재잠금. 변경분(diff)에 근거한 퀴즈를 통과하면 회복.
5. **async 조건 (구 postsession):** 잠긴 영토의 edit은 차단하되, 에이전트가 그
   자리에서 파일을 **설명해 가르치고**, 실제 체크는 나중에 — 웹/모바일 또는
   다음 세션의 /scale-study — 에서 통과시켜 언락한다.
6. **팀장은 default만 정한다.** `.scale/policy.json`(커밋됨)이 팀 기본값,
   팀원은 자기 user config로 **어느 knob이든 override 가능**. 강제가 아니라
   norm. 팀장 본인의 게이트 적용 여부도 본인이 정한다 — 팀장도 한 명의
   사용자로서 자기 override(`gate.enabled: false`)를 쓰면 되므로 별도 면제
   knob은 만들지 않는다.
7. 텔레메트리 수집 경로는 **나중에** (시스템 구현 우선).

## 1. 설계 원칙의 변화

| | 구 설계 (pre-commit) | 신 설계 (edit gate) |
|---|---|---|
| 트리거 | Claude Code Bash 도구의 `git commit` | `PreToolUse(Edit\|Write\|MultiEdit)` |
| 측정 대상 | 방금 만든 변경의 이해 (사후) | 건드리기 전 영토의 이해 (사전 자격) |
| 통과 효과 | marker TTL 10분 | **영구 언락** (반란만 재잠금) |
| skip | 항상 가능, 최종 (drop) | enforcement 정책에 따름; soft에서 **세션 한정 임시 언락** |
| 조건 축 | timing: 게이트 유무 자체가 다름 | assessment: 같은 락·같은 가르침, **평가 시점만** 다름 (sync/async) |
| 설정 주체 | 개인 config | **팀장 default(policy.json) < 개인 override(config.json)** |

핵심 문장: **에이전트의 쓰기 속도가 인간의 이해 속도에 율속된다.** 위협 공간이
정확히 둘로 갈라진다 — 내(+내 에이전트) 변경은 edit gate가 **쓰기 전에** 검사하고
(pre-cleared by construction), 남의 변경은 반란이 **머지 후에** 잡는다.

## 2. 레이어드 설정

```
schema 기본값  <  .scale/policy.json (커밋, 팀장 default)  <  ~/.scale/<repo-id>/config.json (개인 override)
```

- 병합은 leaf-key 단위 deep merge (객체는 재귀, 배열/원시값은 교체).
- **user config는 sparse여야 한다** — 명시적으로 고른 키만 저장. 전부
  materialize해서 쓰면 모든 키가 "사용자가 정했음"이 되어 policy default가
  영원히 죽는다. `scale init`·`config set`·serve의 settings PATCH 모두
  sparse로 쓴다.
- policy에 **없는** 키 (개인 전용): `user`, `language`, `models`(API 제공자/키).
- policy 파일이 invalid JSON/스키마 위반이면 **무시하고 user-only로 동작**
  (fail open). `scale status` 헤더가 policy 적용 여부를 표시한다.
- 변조 방지는 하지 않는다 — override가 정당한 행위이므로 방지할 것이 없다.
  override delta 자체가 나중에 텔레메트리의 관심 데이터다.

### 2.1 새 config 스키마 (효력 기준)

```jsonc
{
  "user": "…",                 // 개인 전용
  "language": "en|ko",        // 개인 전용
  "gate": {
    "enabled": true,           // 팀장 본인 옵트아웃도 이 knob (개인 override)
    "modality": "quiz|socratic",
    "assessment": "sync|async",   // sync=즉석(채팅), async=설명만+나중에 언락
    "enforcement": "advisory|soft|hard"
    // advisory: 차단 없음, 알림/기록만.  soft: 차단 + skip 가능(세션 임시 언락).
    // hard: 차단 + skip 없음 (개인 enforcement override가 공인된 압력 밸브).
  },
  "unlock": { "passBar": 0.6, "checksRequired": 1 },
  "exempt": { "paths": [] },   // globish (*, **). 정확 매칭에 없는 신규 파일은 자동 면제
  "budgets": { "maxPerSession": 2, "cooldownMinutes": 15, "sessionIdleResetMinutes": 720 },
  "thresholds": { /* 기존 그대로 */ },
  "models": { /* 기존 그대로 */ }
}
```

**마이그레이션 (구 키 → 신 키, idempotent, 스키마 preprocess):**
- `condition.timing` inflow→`gate.assessment: sync`, postsession→`async`
- `condition.modality` → `gate.modality`
- `inflow.triggers` → `gate.enabled` (pre-commit 포함 여부)
- `budgets.maxPerCommit` **삭제** (아무 코드도 읽지 않았음), `budgets.minChangedLines`
  **삭제** (커밋 diff 전용 개념 — edit에는 diff가 없다)

구 postsession 사용자는 마이그레이션 후 async가 되어 **게이트가 새로 생긴다** —
의도된 동작 변경 (신 설계에서 두 조건 모두 게이트를 가진다).

## 3. 잠금 모델

### 3.1 원장 — `~/.scale/<repo-id>/locks.json` (개인, per-user)

```jsonc
{ "version": 1,
  "components": { "<id>": { "unlockedAt": "ISO", "sha": "…", "checks": 1, "via": "check" } } }
```

- **locked(id)** = 원장에 없음 **AND** coverage state ≠ `validated`
  (기존 validated는 grandfather — 이미 이해를 증명한 영토를 재잠그지 않는다).
- **언락 경로 (전부 같은 함수 `noteCheckOutcome`):** ① `scale record`
  ② quest 완료 (CLI `quest complete` / 웹 API) — `by === 'user'`이고 그 체크의
  평균 점수 ≥ `unlock.passBar`일 때 checks 증가, `checksRequired` 도달 시 언락.
  `--by agent` 결과는 **절대 언락하지 않는다.**
- **세션 skip:** `SessionRecord.sessionSkips: string[]` — soft에서 defer한
  component. 예산 기간(세션)이 끝나면 자연 소멸. defer = 세션 임시 언락이며
  더 이상 "최종 drop"이 아니다.
- 락은 개인의 것이다. 지도는 팀이 공유하지만 같은 component가 나에겐 잠기고
  선임에겐 열려 있는 것이 정상 상태다.

### 3.2 게이트 판정 (`gateEditDecision`, core, pure) — 순서대로 첫 매치

0. `gate.enabled === false` → allow
1. 대상 component 산출: 편집 파일 → **정확 인덱스만** (nearest-dir 폴백 금지 —
   신규 파일이 11개 component로 번지는 것을 측정으로 확인함. 신규 파일은
   자동 면제) → `exempt.paths` 필터
2. unlocked(원장 ∪ validated) · sessionSkips · recentlyAddressed(TTL 10분,
   retry 통과용) 제외 → 후보 없음 → allow
3. `enforcement === 'advisory'` → allow + evidence(`outcome: advisory`) 기록
   (advisory 행도 recentlyAddressed에 잡혀 같은 component 반복 기록을 자연
   rate-limit)
4. 세션 예산 소진 (`interventionsThisSession ≥ maxPerSession`) → allow
   (soft-fallback; S3에서 async 큐로 연결)
5. 쿨다운 내 → allow
6. **deny**: top-1 후보 (importance × (1−mean), 기존 랭킹 재사용), 예산 소모.
   reason은 assessment·enforcement별 3변형: sync=지금 튜터 체크,
   async=**설명만 하고 퀴즈 금지** + 웹/scale-study 안내, hard=skip 문구 제거.

coverage는 **스냅샷**(coverage.json)을 읽는다 — edit는 커밋보다 훨씬 잦아서
recompute(git churn 전수 조사)를 hook 경로에 둘 수 없다. 스냅샷은
SessionStart/record가 계속 갱신한다.

### 3.3 훅 배선

- `pre-edit.mjs` → `scale gate edit` **한 번 호출** (기존 `log review`의 propose
  기록을 gate edit이 내부에서 수행 — 훅당 프로세스 수를 늘리지 않는다).
  deny면 permissionDecision envelope, 아니면 침묵.
- `post-edit.mjs` 불변 (touch + diff_review 닫기).
- **`pre-commit-gate.mjs`와 hooks.json의 Bash matcher 삭제. `scale gate commit`
  삭제.** git 커밋은 이제 아무 데서도 게이트되지 않는다.

## 4. 단계

### S0 — 이 문서. ✅
### S1 — 레이어드 config + edit gate + 잠금 원장 (이번 구현)
- core: 스키마 교체(§2.1) + 마이그레이션 + `PolicyFileSchema` + `resolveConfig`
- core: `gateEditDecision` (§3.2), 구 `gateDecision` 삭제
- cli: locks.json/sessionSkips (state.ts), `gate edit`, defer=세션 skip,
  record/quest-complete→`noteCheckOutcome`, sparse config 쓰기, effective 로더
- plugin: pre-edit 배선, 커밋 게이트 삭제, scale-tutor/scale-quiz 문구 교체
  (commit→edit, 영구 언락, async 프로토콜)
- web: Settings(assessment/enforcement/gate.enabled, perCommit·minChangedLines
  제거), i18n, data.ts
- 테스트: gate-edit 판정 · 레이어링/마이그레이션 · locks · defer/unlock 경로
### ✅ S2 — 반란 v2 (메커니즘) — 완료. **결과는 §11 참조.**
- authorship 필터 ✅ · 원장 재잠금 ✅ · 일일 다이제스트 ✅ · 반란 인지 deny 문구 ✅
- ⏸ **S2b — diff grounding**: 회복 퀴즈에 foreign diff 블록. 측정 결과 반란을
  일으킬 만한 diff는 최소 8.5k / 중앙값 19k / 최대 78k자라 **통째로 못 넣는다.**
  → 결정론적 skeleton(sha·author·subject·numstat·hunk 함수명) + churn 순위로 자른
  발췌 + 신뢰 경계 래핑 + anti-lookup 지시. 프롬프트 인젝션 표면이므로 S3의
  서버 채점과 함께 간다.
### S3 — async 완성
- deny 시 pending-unlock 기록 → 웹 뷰어 표면화, 다음 세션 /scale-study 안내
- **서버 채점**: /api/quests에서 정답 제거, 채점을 serve로 이동 —
  퀴즈가 권한이 된 순간부터 클라이언트 채점은 락 해제 수단이 된다 (전제 조건)
- LAN + bearer token (모바일), SessionStart에 잠김/대기 카운트
### S4 — UI 마감 + 텔레메트리 (별도 결정 후)
- Settings에 policy 출처 표시(“팀 기본값/내 override”) + override 해제 affordance
- override delta·skip·회피(잠긴 영토 우회) 로깅 — **학습 vs 회피**가 핵심 측정

## 5. 불변식

1. 훅은 전부 fail open — CLI 부재/오류/policy 파손이 edit를 막지 않는다.
2. 권한 원장과 이해도 모델은 분리 — 락이 coverage 수치를 만들거나 바꾸지 않는다.
3. user config는 sparse — policy default가 살아 있어야 한다.
4. `--by agent`는 어떤 경로로도 언락 불가.
5. edit hook 경로에 recompute/LLM/네트워크 금지 (< 200ms 목표 유지).
6. 게임 스킨은 UI 전용 — 스키마·코드는 중립 용어 (lock/unlock은 중립 어휘로 취급).

## 6. 하지 않기로 한 것

- 커밋 게이트 존치 (백스톱 포함) — 제거.
- 팀장 면제 knob — 개인 override로 해결.
- 정책 변조 방지/탐지 — override가 정당하므로 무의미.
- 절대 잠금 — hard도 개인 enforcement override로 풀 수 있다 (결정 §0-6의 귀결).
- Claude Code 밖 편집(vim 등)의 게이트 — 불가능하고, 우회 신호는 측정 대상.

## 11. S2 실행 결과 (2026-09-01)

### 11.1 측정이 기본값을 바꾼 지점

`trigger: 'any-foreign-commit'`을 **기본값으로 쓰면 안 된다**는 것이 측정으로 확정됐다.
이 리포에서 커밋 1개가 평균 **7.9 / 37개 component**를 건드리고, 상위 component는
커밋의 **56–60%**가 건드린다. 팀이 하루 몇 개의 PR만 머지해도 같은 영토에서 매일
쫓겨난다 — 게이트가 러닝머신이 된다. 모드는 남겼지만 문서에 이 숫자를 박아뒀다.

누적 churn/size 분포 (실측, 창=커밋 수):

| 창 | 변경된 comp | ≥0.10 | ≥0.25 | ≥0.50 | ≥1.0 |
|---|---|---|---|---|---|
| 1 | 2 | 2 | 1 | 0 | 0 |
| 3 | 22 | 14 | 8 | 3 | 0 |
| 5 | 22 | 17 | 8 | 3 | 0 |
| 10 | 24 | 19 | 12 | 3 | 0 |

→ `foreignRatio: 0.25`, `selfRatio: 0.8`.

**핵심 논거:** 재잠금 자체는 방해가 아니다. 그 영토를 *실제로 편집할 때만* deny가
되고 그건 `maxPerSession`에 이미 걸린다. 과발화 비용이 유계이므로 foreign 쪽은
민감하게 잡아도 된다. 반대로 self 쪽은 **edit gate가 쓰기 전에 이미 통과시킨**
코드라 재잠금이 측정하는 게 타이핑량뿐 — 그래서 훨씬 높은 바.

### 11.2 git 의미론 — 전부 실측

| 항목 | 결과 |
|---|---|
| 머지 귀속 | 기본 `git log --numstat`은 머지 커밋을 건너뛰어 **원저자에게** 귀속. 내가 머지해도 동료 churn으로 잡힘 ✅ |
| author vs committer | `%aE`(mailmap 정규화). rebase/squash는 committer를 덮어쓰므로 author만 살아남음. mailmap 없으면 `%ae`와 바이트 동일 |
| rename | pathspec이 rename 이전 이력을 못 봄 + 전체 add로 계상. 그대로 둠 — 동료가 앵커된 파일을 옮겼으면 그 paper의 앵커도 stale이라 플래그가 맞는 답 |
| per-commit vs net | 3커밋 구간에서 **+26%** (332 vs 264). 임계는 이 숫자 기준으로 새로 골랐지 물려받지 않음 |
| conflict 머지 | 머저의 충돌 해소 라인은 안 보임 → **과소** 계상 (안전 방향) |
| 로컬 `merge --squash` | author가 머저가 되어 동료 작업이 self로 읽힘 → 반란 미발화 (안전 방향) |

### 11.3 구현 중 잡은 결함 3건

1. **회복이 1회 체크로 안 됐다** (커밋 `9a8c438`). churn을 *직전* coverage.json의
   앵커에서 재고 있어서, 방금 재검증된 component가 반란 이전 sha와 비교돼 같은
   명령 안에서 다시 stale이 됐다. 재잠금을 붙이면 **통과한 체크가 방금 준 언락을
   스스로 회수**한다. fold를 먼저 돌려 이번 회차 앵커에서 재도록 2단계로 분리.
2. **NUL 바이트 2개가 소스 파일을 바이너리로 만들고 있었다.**
   `quest-items.test.ts`(1개) / `distill-graph.mjs`(3개). git이 `-\t-`로 보고해
   **churn 측정에서 영구히 안 보였다.** 이스케이프 시퀀스로 교체 + 측정 불가
   foreign 변경은 그 자체를 사유로 처리(`unmeasurableForeign`).
3. **churn 사전 필터가 틀렸다.** `git diff --name-only`(net)로 상위집합을 만들면
   바뀌었다 되돌려진 파일이 빠진다 — 24개 앵커 깊이 중 **17개에서 위반**.
   커밋 합집합(`git log --name-only`)으로 교체 후 위반 0.

### 11.4 지연

`scale context`(SessionStart 훅) — 37개 전부 앵커됨 + 15커밋 드리프트: **330ms**
(훅 백스톱 1500ms). 사전 필터가 조용한 리포에서 37번의 git 워크를 1번으로 접는다.
`gate edit`은 **git을 전혀 쓰지 않는다** (스냅샷 + 파일 I/O만).

### 11.5 알려진 틈 (문서화하고 수용)

- **스냅샷 지연**: 게이트는 마지막 recompute만큼만 최신이다. 동료 커밋을 pull한
  직후~다음 SessionStart 사이에는 게이트가 모른다.
- **10분 유예**: `recentlyAddressed`가 상태 검사보다 먼저라, 마지막 체크 후 10분
  안에 도착한 반란은 그 창 동안 강제되지 않는다.
- **로컬 squash-merge**: 동료 작업이 self로 읽힌다 (위 표). 안전 방향.
