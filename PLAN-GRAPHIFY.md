# PLAN-GRAPHIFY — graphify 통합 실행 계획 (Opus 핸드오프)

> **이 문서의 목적**: 이전 세션(Fable 5)에서 감사·검증·설계한 graphify 통합 계획을
> 다른 Claude Code 세션(Opus)이 이 대화 없이 실행할 수 있게 만든 자족 문서.
> 모든 주장에는 파일:라인 근거가 있고, "검증됨" 표시는 실제 실행으로 재현했다는 뜻이다.
>
> 작성일: 2026-08-30 · 기준 HEAD: `f7109c6`
>
> **갱신 2026-08-30**: Task 0과 P0 완료. 결과와 계획 수정 사항은 **§9**를 먼저 읽을 것.
> §1.1(미커밋 변경)과 §4의 Task 0 / P0 항목은 완료 상태로 표시돼 있다.

---

## 0. 배경 한 단락

SCALE의 coverage memory(`.scale/`)는 `/scale-map` 스킬이 LLM으로 한 번 구축한다.
지금 그 산출물의 구조적 사실 — component 경계, `sources` 앵커, 컴포넌트 간 엣지,
`importance` — 은 전부 LLM 추측이며 ground truth가 없다.
[graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0, PyPI 패키지명
`graphifyy` — y 두 개)는 tree-sitter AST로 코드 그래프를 **로컬·결정론·LLM 0원**으로
추출한다. 이걸 이용해:

1. **맵이 코드를 정확히 반영**하게 만들고 (경계 검증, `depends_on` 엣지, 진짜 centrality)
2. **퀴즈가 더 핵심을 찌르게** 만든다 (구조 grounding, 이웃 기반 오답, 반사실 문항).

**비용 절감은 목표가 아니다.** 빌드 비용의 ~40%는 paper 산문 출력이라 graphify가
못 건드린다 ([estimate.ts](packages/core/src/estimate.ts)의 `MEASURED_BUILD` 참조).
목표는 정확도다.

---

## 1. 현재 리포 상태 — 실행 전 필독

### 1.1 ~~미커밋 변경~~ → ✅ 커밋됨 `515612d` (훅 stdin 배관 수리)

이전 세션에서 고친 것: 훅 스크립트는 payload를 stdin으로 넘기는데 CLI가 stdin을
전혀 읽지 않아, **evidence 569행 전부 빈 componentIds**로 기록되고 있었다
(fog 36/37, unification 1%의 직접 원인). 수리 내용:

| 파일 | 상태 | 내용 |
|---|---|---|
| `packages/cli/src/hook-input.ts` | 신규 | payload 파싱: `prompt`/`tool_input` 추출, TTY 스킵, 150ms 백스톱 + `stdin.unref()` |
| `packages/cli/src/__tests__/hook-input.test.ts` | 신규 | Edit/Write/MultiEdit/NotebookEdit 형태 10건 |
| `packages/cli/src/state.ts` | 수정 | `pending-edits.json` 저장소 (propose→execute 짝, TTL 10분, 세션 키잉 `sessionId\u0000file`) |
| `packages/cli/src/index.ts` | 수정 | `log prompt/touch/review` stdin 폴백 (argv 우선), 절대→리포상대 경로 정규화(`relToRepo`), `context`가 같은 `session_id`면 예산 보존 (compact에서 예산 리필되던 버그) |
| `packages/plugin/bin/scale.mjs` | 재번들 | `npm run build:plugin` 산출물 |

검증 완료: 테스트 112개 통과, 훅 지연 90–130ms(< 200ms 예산), 실제 훅 스크립트
경유 종단 확인, 명시적 argv 경로 회귀 없음, 동시 세션이 서로의 proposal을 닫지 않음.

~~**Task 0: 이 diff를 리뷰하고 커밋하라.**~~ → ✅ 완료. 커밋 `515612d`.
브랜치 `fix/hook-evidence-capture` (main은 미변경 — fast-forward 여부는 사용자 판단).

### 1.2 알려진 문제 중 이 계획과 얽힌 것

- **고아 소스 5파일 / 1291 LOC** (아래 P0.5에서 해결):
  `packages/cli/src/hook-input.ts`(신규라 당연), `keys.ts`, `llm.ts`,
  `packages/web/src/Settings.tsx`, `i18n.ts`.
  [index-map.ts](packages/core/src/index-map.ts)의 최근접 디렉터리 폴백이 이들 편집을
  **6~11개 컴포넌트에 오염 크레딧**한다 (검증됨: cli 쪽 파일은 11개 전부에 매칭).
- **낡은 paper**: `.scale/platform/config-schema/`가 삭제된 `models.build` 키를
  가르침 (커밋 7839f9c에서 제거 — 튜터가 오답을 정답 처리하게 됨).
  `.scale/memory/memory-builder-skill/`도 없어진 빌드 게이트 서술.
  `map.json`의 `builtFromSha`는 `0b5c4c3`, HEAD는 `f7109c6` (4커밋 뒤).
- **`.scale/map.json` 실측**: 노드 37, 엣지 `reference` 324 / `depends_on` 0 /
  `hierarchy` 0. 밀도 24.3% (모듈 그래프 통상 2~5%) — Related Work 지시문이
  협업/의존/**대조**를 한 엣지 종류에 뭉뚱그린 탓. importance sd 0.184, 최솟값
  0.19로 주변부가 없음.

---

## 2. 검증된 코드 사실 (재조사 불필요 — 근거 포함)

이 절의 사실들은 이전 세션에서 소스를 직접 읽거나 실행해 확인했다.

1. **`depends_on`은 이미 스키마에 있고 생산자만 없다.**
   [map.ts:25](packages/core/src/schema/map.ts) `z.enum(['hierarchy','reference','depends_on'])`,
   [layout.ts:239](packages/core/src/layout.ts)가 importance 계산에 이미 포함,
   [styles.css:231](packages/web/src/styles.css) 전용 스타일 존재. 실제 map.json에 0개.
2. **importance는 동결되지 않는다.** [layout.ts](packages/core/src/layout.ts)의
   증분 모드는 **좌표만** 보존하고 importance는 매 실행마다 현재 엣지 in-degree에서
   재계산한다. → `depends_on` 도입은 게이트 랭킹(`importance × (1−mean)`,
   [gate.ts](packages/core/src/gate.ts))과 quest 랭킹
   ([quest.ts `pickComponents`](packages/cli/src/quest.ts))을 바꾼다.
   **스터디 freeze 전에만 허용, 참가자 진행 중 금지.**
3. **엣지 주입 지점**: `scale map layout` 액션
   ([index.ts의 `'layout'` 커맨드, computeLayout 호출부](packages/cli/src/index.ts))이
   `loaded.edges`(paper Related Work 파생)를 `computeLayout`에 넘긴다.
   여기서 `.scale/deps.json`을 병합하면 **@scale/core는 무변경**으로 끝난다.
4. **퀴즈 grounding에 구조 입력이 전무하다.**
   [quest.ts `groundingText()`](packages/cli/src/quest.ts)는 title+concepts+rationale만
   LLM에 넘기면서 프롬프트는 `"structure" (how the component is built)` 문항을
   요구한다. 튜터 루브릭의 structure 만점 기준은 "traces data & control flow" —
   출제 근거에 흐름 정보가 없다.
5. **결정론 폴백의 오답이 약하다.**
   [quest.ts `deterministicQuizItems`](packages/cli/src/quest.ts)는 **임의 순회
   순서로 다른 컴포넌트들의** concept을 오답 풀로 쓰고, 모자라면
   "위의 어느 것도 아니다" 류 generic filler로 채운다. 튜터 스킬은 "REAL
   misconceptions"를 요구하지만 재료가 없다.
6. **프롬프트 매칭이 심볼을 못 본다.**
   [index.ts `matchComponentsFromText`](packages/cli/src/index.ts)는 component
   id/title/concept 이름만 substring 매칭. 주니어가 `materializeCoverage`,
   `gateDecision` 같은 **심볼 이름**으로 말하면 전부 매칭 실패 → prompt evidence가
   빈 componentIds가 된다 (stdin 수리로 텍스트는 이제 도달하는데 사전이 빈약).
7. **churn/loyalty는 junior 핫패스다.**
   [coverage.ts `gitChurn`](packages/cli/src/coverage.ts)이 coverage recompute마다
   실행 — **여기에 graphify/Python 진입 금지.** git numstat 방식 유지.
8. **문서 오류**: [scale-map SKILL.md](packages/plugin/skills/scale-map/SKILL.md)는
   `importance = dependency centrality × git churn`이라 하지만 layout.ts에 churn은
   없다 (grep 0건). P1에서 SKILL 문구도 고칠 것.

### graphify 쪽 확인 사실

- 코드 추출은 tree-sitter AST, **로컬·API 키 불필요** (`--code-only`).
  TS/TSX 지원 (37개 문법에 포함).
- **graph.json 실제 형태 (실측)**: NetworkX node-link —
  `{directed, multigraph, graph, nodes, links, hyperedges, built_at_commit}`.
  엣지 배열 키는 `edges`가 아니라 **`links`** 다 (파서는 둘 다 받도록 할 것).
  노드 `{id, label, source_file, source_location, community, ...}`, 엣지
  `{source, target, relation, confidence}`.
- `graphify cluster-only . --no-label`로 커뮤니티 라벨링 LLM 호출 차단 가능.
  `--resolution`으로 커뮤니티 수 조절.
- `analyze.py`에 `graph_diff(G_old, G_new)` 실재 (P3 싱크용).
- **graphify의 `EXTRACTED/INFERRED`와 SCALE paper의 `provenance`는 의미가 다르다.**
  전자 = 엣지가 소스에 명시됐나, 후자 = 설계 근거를 사람이 말했나. **자동 매핑 금지.**
- 주의: v0.9.x, 거의 매일 릴리스. **버전 핀 필수.** Leiden extra는 Python < 3.13.
- 클러스터링 결정론: **확인됨 (§9)**. 같은 입력 2회 추출에서 노드·엣지 집합, 배열
  순서, 680개 노드 전부의 커뮤니티 배정이 동일. 유일한 바이트 차이는 graphify가
  스탬프하는 `built_at_commit` 필드뿐.

---

## 3. 배치 아키텍처 (합의된 원칙)

> **graphify는 senior 빌드/싱크 타임에만 실행된다. 산출물은 `.scale/`에 커밋되는
> 작은 증류 JSON으로만 junior에게 도달한다. junior 쪽 Python 의존성은 0.**

```
[senior 머신 — Python이 존재하는 유일한 곳]
  uv tool install "graphifyy==<pinned>"        # Python 3.12 권장
  graphify extract . --code-only               # LLM 0, 로컬
  graphify cluster-only . --no-label
     ↓ graphify-out/graph.json                 # gitignore (빌드 중간물)
  node scripts/distill-graph.mjs               # P1에서 작성
     ↓
  .scale/deps.json      # 컴포넌트 단위 depends_on (커밋)
  .scale/symbols.json   # 심볼 → componentIds (커밋)
  (+ fidelity report → stdout, 커밋 안 함)

[junior 머신 — Python 0]
  scale map layout      # deps.json 병합 → depends_on 엣지
  scale log prompt      # symbols.json 조회 (핫패스 안전: JSON lookup)
  quest / tutor         # map.json의 depends_on 이웃으로 grounding
```

- `graphify-out/`은 `.gitignore`에 추가. 단, 논문 재현성용으로 빌드에 쓴
  `graph.json` 스냅샷 + graphifyy 버전 + `--resolution` 값은 `.scale/build/`에 보존.
- LLM이 쓴 `reference` 엣지는 **지우지 않는다** — `depends_on`과 병존시키면
  두 집합의 차이(정밀도/재현율)가 그 자체로 논문 데이터가 된다.
- graphify는 경계의 **저자가 아니라 검증자/후보 제안자**다. Leiden 커뮤니티 ≠
  학습 단위 ("a thing a junior could understand in one sitting") — 경계 채택은
  항상 사람(또는 승인 게이트를 거친 빌드 스킬)이 한다.

---

## 4. 단계별 실행 계획

### ✅ Task 0 — stdin 수리 커밋 (§1.1) — 완료 `515612d`

### ✅ P0 — fidelity report — 완료. **결과는 §9 참조.**

(아래는 원래 계획. 실제 실행에서 달라진 점은 §9에 기록.)

graphify를 리포 의존성으로 만들지 **않고**, 한 번 돌려 현재 `.scale/`과 대조만 한다.

1. graphify 설치 (버전 핀) 후 위 §3 명령으로 `graphify-out/graph.json` 생성.
2. **결정론 확인**: extract+cluster를 2회 실행, `graph.json` diff. 커뮤니티가
   흔들리면 논문 서술을 "커밋된 스냅샷 기준"으로 못 박는다.
3. `scripts/graphify-check.mjs` (Node, 신규) 작성 — 입력: `graph.json`,
   `.scale/index.json`, 각 paper의 `sources`. 출력 지표:
   - **orphan files**: 어떤 component의 `sources`에도 없는 소스 파일 (현재 5개 예상)
   - **dead sources**: paper가 앵커했지만 디스크에 없는 경로
   - **double-claimed**: 2개 이상 component가 주장하는 파일 (의도일 수 있음 — 나열만)
   - **link precision**: Related Work 링크 중 실제 경계 넘는 AST 엣지가 있는 비율
   - **link recall**: 경계 넘는 AST 엣지(컴포넌트 쌍 단위) 중 Related Work 링크가 있는 비율
   - **cohesion**: 컴포넌트 내부 엣지 밀도 / 외부 엣지 밀도 (경계 품질 프록시)
   - 파일→컴포넌트 매핑은 `index.json` **정확 매칭만** 사용 (폴백 쓰면 지표가 오염됨).
4. 결과를 사용자에게 보고. 이 리포트가 P0.5의 입력이 된다.

**수용 기준**: 스크립트가 지표 6종을 출력하고, 2회 실행 결정론 여부가 기록됨.

### P0.5 — `/scale-map` 싱크 (LLM 빌드 1회)

`/scale-map` 스킬의 Sync 모드(§5)를 실행하되 P0 리포트를 입력으로:

- 고아 5파일을 기존 component에 편입하거나 신규 component 생성
  (`hook-input.ts`는 capture province의 evidence 배관 근처가 자연스러움 — 판단은 빌드 시).
- 낡은 paper 갱신: `config-schema` (models.build 삭제 반영), `memory-builder-skill`
  (빌드 게이트 서술), `terminology-skin`/`quest-generation`/`commit-gate`/
  `evidence-log`의 낡은 서술 (감사에서 지적됨 — 각 paper를 현재 코드와 대조).
- `scale map layout` (증분) + `scale map index` 재생성, `builtFromSha` 재스탬프.
- **주의**: 스킬의 cost gate 준수 — 빌드 모델은 Opus 4.8/Fable 5, 사용자 확인 필수.

**수용 기준**: P0 스크립트 재실행 시 orphan 0, dead sources 0.

### P1 — 증류 아티팩트 + 배선 (2~3일)

1. `scripts/distill-graph.mjs` (신규):
   - `graph.json`의 각 엣지를 `source_file`→`index.json` 정확 매칭으로 컴포넌트
     쌍에 귀속. 같은 컴포넌트 내부 엣지는 버림.
   - `.scale/deps.json` 스키마 (제안 — 구현 시 조정 가능):
     ```json
     { "builtFromSha": "…", "graphifyVersion": "0.9.x", "resolution": 1.0,
       "edges": [ { "from": "state-engine", "to": "coverage-model",
                    "count": 7, "extracted": 5, "inferred": 2 } ] }
     ```
   - `.scale/symbols.json`: `{ "symbols": { "materializeCoverage": ["state-engine"], … } }`
     필터: 심볼 길이 ≥ 4, 소문자 일반 단어 제외(스톱리스트), **여러 컴포넌트에
     걸치는 심볼은 제외** (오염 크레딧 방지 — 최근접 디렉터리 폴백과 같은 문제를
     재생산하지 말 것).
2. `scale map layout`이 `.scale/deps.json` 존재 시 `depends_on` 엣지로 병합
   (없으면 기존 동작 — **graphify는 항상 선택적**). 중복 (from,to,kind) 제거.
   최소 count 임계(예: ≥2)는 구현 시 판단하되 deps.json에 raw count를 남겨
   임계를 나중에 바꿀 수 있게 할 것.
3. `log prompt`의 `matchComponentsFromText` 뒤에 symbols.json 조회 추가
   (파일 없으면 스킵). **핫패스 예산 < 200ms 재측정 필수.**
4. layout 재실행 → importance 갱신 (§2-2의 freeze 제약 확인 — 이 리포는 스터디 전이라 OK).
5. scale-map SKILL.md의 `importance = centrality × git churn` 오류 문구 수정.
6. 테스트: distill 스크립트 단위 테스트(픽스처 graph.json), symbols 매칭 테스트,
   deps 병합 layout 테스트.

**수용 기준**: map.json에 `depends_on` 엣지 존재, `scale log prompt "fix materializeCoverage"`가
`state-engine`을 매칭, 전체 테스트 통과, 훅 지연 < 200ms 유지, deps/symbols 없이도
모든 경로 정상 (선택성).

### P2 — 퀴즈 grounding (1~2일)

1. [quest.ts `groundingText()`](packages/cli/src/quest.ts)에 이웃 블록 추가 —
   **map.json의 depends_on 엣지에서** (이미 로드됨, 새 파일 읽기 불필요):
   ```
   Structure (from the dependency graph):
     depends on: coverage-model, evidence-log
     depended on by: coverage-materialization, gate-enforcement
   ```
2. `deterministicQuizItems`의 오답 풀을 **1-hop 이웃의 concept 우선**으로 정렬
   (이웃 소진 후 기존 순회, generic filler는 최후).
3. LLM 프롬프트와 [scale-tutor SKILL.md](packages/plugin/skills/scale-tutor/SKILL.md)에
   **반-trivia 규칙** 명시:
   > 엣지는 오답 후보와 반사실 문항("이 계약을 바꾸면 무엇이 먼저 깨지나")의
   > 무대 설정에만 쓴다. "X는 무엇을 import하는가" 같은 **엣지 조회 문항 금지** —
   > 그건 이해가 아니라 조회다.
4. `npm run build:plugin` 재번들 (훅/tutor가 쓰는 건 번들이다 — 잊기 쉬움).

**수용 기준**: 폴백 퀴즈의 오답이 이웃 concept에서 나옴(테스트), LLM 프롬프트에
이웃 블록 포함, 반-trivia 규칙이 프롬프트·SKILL 양쪽에 존재.

### P3 — 선택 (논문 후 또는 여유 시)

- 싱크 모드에서 `graph_diff`로 "어느 paper를 갱신할지" 판단 (senior 쪽 —
  whole-file loyalty 분모 한계 우회).
- Socratic 프록시([serve.ts](packages/cli/src/serve.ts))와 튜터에 이웃 블록.
- scale-map SKILL Survey 단계에 graphify 커뮤니티를 **후보**로 제시하는 선택 단계.
- (연구 설계 결정 필요) quest 위상 커리큘럼 — 의존받는 쪽 먼저 학습.

---

## 5. 하지 않기로 한 것 (재논의 불필요)

| 기각 | 이유 |
|---|---|
| junior 쪽 churn/loyalty를 graphify로 대체 | 핫패스 + Python 금지. git numstat 유지 |
| `.scale/` paper를 graphify로 그래프화 | docs 추출은 LLM 경로. Node 스크립트로 충분 |
| hero Mermaid를 callflow export로 시드 | paper는 개념 다이어그램을 원함. raw call graph는 노이즈 |
| graphify MCP 서버 상시 연결 | committed JSON 직접 읽기가 더 단순, 의존성 0 |
| Leiden 커뮤니티를 경계로 자동 채택 | 교육적 경계 ≠ 그래프 모듈 경계. 후보/대조군까지만 |
| EXTRACTED/INFERRED → provenance 자동 매핑 | 의미가 다름 (§2 graphify 절) |

## 6. 불변 제약 (전 단계 공통)

1. **junior 핫패스** (`log`, `gate`, `context`): < 200ms, LLM/네트워크/Python 금지.
2. **graphify는 항상 선택적**: deps.json/symbols.json이 없으면 기존 동작 그대로.
3. **freeze 제약**: `depends_on` 도입·엣지 집합 변경은 스터디 시작 전에만 (§2-2).
4. **스키마·코드에 게임 용어 금지** (skin은 UI 레이어).
5. paper 본문은 영어 유지 (repo-shared 상태), 학습자 대면 문자열만 `language` 설정 따름.
6. 버전 핀: `graphifyy==<P0에서 확정>`, Python 3.12.
7. 훅/tutor 쪽 변경 후에는 반드시 `npm run build:plugin` — 실행되는 건 번들이다.

## 7. 검증 커맨드 모음

```bash
npm run build && npx vitest run          # 타입 + 테스트 (현재 112개 통과 상태)
npm run build:plugin                     # 플러그인 번들 재생성

# 훅 종단 검증 (임시 HOME으로 실제 로그 오염 방지)
T=$(mktemp -d); HOME=$T node packages/plugin/bin/scale.mjs init -u tester
echo '{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"fix the commit gate"}' \
  | HOME=$T node packages/plugin/bin/scale.mjs log prompt
# 기대: "logged prompt (1 component(s))" — 0이면 배관 회귀

# 핫패스 지연 (< 200ms)
/usr/bin/time -p sh -c "echo '{}' | node packages/plugin/bin/scale.mjs gate commit >/dev/null"
```

## 8. 열린 질문 (실행 중 사용자 확인 필요)

1. Task 0 커밋 승인 (diff는 §1.1).
2. P0.5 `/scale-map` 싱크의 LLM 비용 승인 (스킬의 cost gate가 어차피 묻는다).
3. `--resolution` 값: P0 결과를 보고 20–60 component 밴드 기준으로 사용자와 결정.
4. deps.json의 최소 count 임계 (기본 제안: raw 저장, 병합 시 ≥2).

---

## 9. P0 실행 결과 (2026-08-30)

### 9.1 환경 — 실제로 설치된 것

```
uv tool install "graphifyy[leiden]" --python 3.12   →  graphify 0.9.53
```

**버전은 핀하지 않았다** (사용자가 최신 설치를 선택). 재현성이 필요한 시점에
`graphifyy==0.9.53`으로 핀할 것. `graph.json`은 스스로 `built_at_commit`을
스탬프하므로 어느 코드 상태에서 뽑았는지는 파일 안에 남는다.

### 9.2 🆕 `.graphifyignore`가 필수다 — 계획에 없던 발견

첫 추출 결과가 **2103 노드 중 1418개(67%)가 커밋된 생성 산출물**이었다:

| 파일 | 노드 수 |
|---|---|
| `packages/plugin/bin/scale.mjs` | 787 |
| `packages/plugin/web-dist/assets/index-*.js` | 631 |

플러그인이 자족적이려고 **일부러 커밋하는** 번들이라 `.gitignore`에 없고,
graphify에게는 그냥 소스로 보인다. 이미 진짜 소스로 그래프에 들어있는 코드가
번들 형태로 한 번 더 들어와 모든 심볼이 이중 계산된다.

→ `.graphifyignore`를 추가하고 `--force`로 재추출: **680 노드 / 1201 엣지 /
31 커뮤니티 / 67개 소스 파일.** 이 단계 없이 P1을 하면 모든 엣지가 두 배로 잡힌다.

### 9.3 결정론 — 확인됨 (논문에 쓸 수 있음)

동일 입력으로 2회 추출한 결과:

| 비교 항목 | 결과 |
|---|---|
| 노드 id 집합 / 엣지 집합 | 동일 |
| 노드·엣지 **배열 순서** | 동일 |
| 680개 노드의 커뮤니티 배정 | 전부 동일 (31개 커뮤니티) |
| 원시 바이트 | `built_at_commit` 필드 하나만 다름 |

→ "경계 후보는 결정론적으로 도출된다"는 서술이 가능하다. `--resolution`을 고정하고
`graph.json` 스냅샷을 보존하라는 §3 지침은 그대로 유효하다(입력이 바뀌면 결과도 바뀐다).

### 9.4 fidelity report 결과 — P1의 근거

`scripts/graphify-check.mjs` (신규, 읽기 전용, 의존성 0). `npm run check:map`.

**앵커 지표**

| 지표 | 값 |
|---|---|
| 죽은 앵커 | **0** — paper가 주장하는 경로는 전부 실재 |
| 고아 파일 (CODE tier) | **6 / 2748 LOC** — §1.2의 5개 + 스크립트 자신 |
| 중복 주장 | 4 파일 (`index.ts`가 6개 컴포넌트에) |
| Stale 앵커 | **20개 컴포넌트** — `config-schema`, `memory-builder-skill` 자동 검출 |

**그래프 지표** (680 노드 / 1201 엣지, EXTRACTED 100%)

| 지표 | 값 | 의미 |
|---|---|---|
| **link recall** | **68.0%** (51/75) | 실제 AST 의존 쌍의 2/3만 Related Work 링크 존재 — 24쌍 누락 |
| **link precision** | **24.6%** (51/207) | **map.json reference 쌍의 3/4가 코드 근거 없음** |
| link precision (보정) | 30.9% (51/165) | AST 노드가 없는 컴포넌트·앵커 집합이 포함관계인 쌍 42개 제외 |
| cohesion | 69.7% | 최약 `browser-safe-surface` 0% (intra 0 / cross 23) |

**precision 24.6%가 P1의 핵심 근거다.** §1.2에서 "밀도 24.3%는 Related Work 지시문이
협업/의존/대조를 뭉뚱그린 탓"이라고 추정했던 것이 정량 확인됐다. 그리고 `importance`가
바로 이 엣지의 in-degree(§2-2)이므로, **맵 배치와 게이트/quest 랭킹이 코드 근거 없는
링크 4분의 3 위에 서 있다.**

주의: 34/37 컴포넌트만 AST 노드를 가진다. 나머지 3개(`memory-builder-skill`,
`slash-commands`, `tutor-skill`)는 마크다운 스킬 파일만 앵커하므로 코드 전용
추출로는 원리적으로 corroborate 불가 — precision의 상한이 1.0이 아니다.

### 9.5 계획 수정 사항

1. **P0.5의 "orphan 0" 기준을 CODE tier로 한정하라.** 감사 표면을 `git ls-files`
   기반으로 넓히니 고아가 7 → 29로 늘었는데, 늘어난 23개는 `package.json`,
   `tsconfig.json`, 루트 `*.md`, `fixtures/` 다. 리포트는 tier를 분리해 출력한다.
   "코드 고아 0"이 의미 있는 기준이고, 나머지는 앵커 정책 결정 사항이지 작업이 아니다.
2. **`scripts/graphify-check.mjs` 자신이 고아다.** P0.5에서 `plugin-packaging`
   (이미 `scripts/build-plugin.mjs`를 앵커함)에 편입하는 게 자연스럽다.
3. **P1 파서는 `links` 키를 읽어야 한다** (§2 graphify 절 수정됨). `edges` 아니다.
4. **`.graphifyignore`를 P1 파이프라인의 전제로 문서화**했다(§9.2). 커밋됨.

### 9.6 다음 단계

**P0.5 — `/scale-map` 싱크.** 입력은 `npm run check:map` 출력:
- CODE tier 고아 6건 편입 (advisory owner가 후보를 제시함)
- Stale 20개 컴포넌트 중 churn 상위부터 paper 갱신
- `scale map layout` + `builtFromSha` 재스탬프
- 수용 기준: `npm run check:map`에서 **CODE tier 고아 0, 죽은 앵커 0**
