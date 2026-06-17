---
name: procedural-dot-forest
description: 절차적 도트 그래픽으로 나무·숲을 캔버스에 코드로만 그리는 방법. labs tree-growth-simulation 의 Space Colonization + Pipe Model 이식, 픽셀퍼펙트 도트 렌더, grid[x][y] 사선 탑뷰, Y-sorting, 황금수액 알갱이 스로틀링, 일간 메트릭→나무 식생 매핑을 다룬다. "도트 나무", "절차적 나무", "픽셀 숲", "캔버스 나무 렌더", "나무 성장 연출", Claude Forest 클라이언트 작업 시 반드시 사용. 렌더 개선/잎 풍성하게/도트 또렷하게 같은 후속 작업에도 사용.
---

# 절차적 도트 숲 렌더링

서버의 일간 메트릭을 받아 에셋 없이 코드로만 도트 그래픽 숲을 그린다. 시뮬레이션(나무 구조)과 렌더(도트 그리기)를 분리한다.

## labs 에서 이식 (바퀴 재발명 금지)

`~/study/labs/src/` (Simulation.ts, speciesData.ts) 를 먼저 읽는다.

- **`Simulation.ts` Space Colonization** (Kill → Attraction → Grow): 충돌 없는 자연스러운 가지 분기 엔진. 그대로 이식.
  - Kill: 가지 반경 내 리소스 제거(겹침 방지). Attraction: 리소스가 최근접 가지 노드 유인. Grow: 유인 방향 평균 + lightSensitivity Lerp 로 새 노드.
- **Pipe Model 두께**: `node.thickness = Math.sqrt(자식 두께² 합)`. 루트로 갈수록 굵어짐 → 도트 기둥/가지 폭에 매핑.
- **렌더-시뮬 분리**: 시뮬은 `RenderLine[]`(`{start,end,thickness}`)만 내보내고 렌더러가 그린다. 이 구조 유지.
- **형태 다양성**: `resourceDistribution`(`upward`/`spreading`/`weeping`/`uniform`). 단 **고정 5수종이 아니라 그날 메트릭 강도로 파라미터 생성**.

## 메트릭 → 시각 매핑 (_workspace/00_architecture.md §2)

| daily 필드 | 시각 |
|---|---|
| `totalInputTokens` | 기둥 높이(-Y) + 가지 분기량(리소스 수) |
| `totalOutputTokens` | 가지 끝 잎 덩어리 크기·개수 |
| `totalCacheWriteTokens` | 기둥 두께 + 식생 레벨 상한 |
| `totalCacheReadTokens` | 황금 수액 알갱이 속도·밀도 |
| `requestCount` | 발치 잔디·꽃 밀도 |

**로그 스케일 필수**: 토큰이 수백만까지 폭발하므로 선형 매핑은 깨진다. `norm = log10(1+v) / log10(1+REF)`. REF 는 관측 분위수 또는 상수, 근거 한 줄 주석.

## 게임 모델 (§3)

- 그리드 셀(3×3 타일) 1개 = 하루(daily 원소 1개). 그날 강도가 식생 단계 결정: 빈땅 → 묘목(1×1) → 유목(2×2) → 성목(3×3). 임계값은 상수로.
- 날짜 누적 = 그리드 확장(8방향 십자, 제곱수 1→4→9). 오늘 셀만 "살아있게" 연출, 과거는 고목.

## labs 에 없어 새로 만들 3가지

### 1. grid[x][y] + 사선 탑뷰(45°)
논리 좌표는 2D 배열 격자. 화면 배치는 사선 탑뷰. 복잡한 대각 변환 공식 없이 `grid[x][y]` 를 그대로 쓰고, 화면 좌표는 단순 오프셋으로. 성장 시 주변 타일 오버랩 허용.

### 2. Y-sorting
그리기 직전 모든 오브젝트를 Y 기준 정렬해 후면부터:
```js
renderObjects.sort((a, b) => a.y - b.y);
```

### 3. 픽셀 퍼펙트
```js
ctx.imageSmoothingEnabled = false;   // 안티앨리어싱 강제 비활성
```
저해상도 백버퍼에 그린 뒤 정수배 nearest 업스케일, 좌표는 정수 스냅. 각진 도트 감성 유지.

## 황금 수액 스로틀링 (시각 공해 방지)

`cache_read` 가 수백만이어도 화면 알갱이는 **최대 40개 하드캡**. 개수 대신 **이동 속도 + Glow 밝기**로 밀도를 표현.
```js
const MAX_PARTICLES = 40;
const count = Math.min(MAX_PARTICLES, /* 밀도 기반 목표 */);
const speed = mapDensityToSpeed(density);   // 밀도↑ → 빠르게
const glow  = mapDensityToGlow(density);    // 밀도↑ → 밝게
```

## 폴링 / 견고성

- `/api/usage` 를 N초(기본 5초) 폴링, 직전 스냅샷과 diff 해 바뀐 셀만 갱신. 렌더는 rAF 루프로 항상.
- 폴링 실패: 직전 상태 유지 + "오프라인" 표식, 렌더 죽지 않음. 빈 daily: 흙 타일만.
- **목 데이터 모드**(`?mock=1`): 서버 없이 고정 샘플 daily 로 렌더 검증 가능하게.

## 흔한 함정

- ❌ 선형 토큰 매핑 → 큰 값에서 나무가 화면 밖. ✅ 로그 스케일.
- ❌ 알갱이를 cache_read 비례로 무제한 생성 → 시각 공해·성능 저하. ✅ 40개 캡 + 속도/Glow.
- ❌ `imageSmoothingEnabled` 미설정 → 도트가 흐릿. ✅ false + 정수 스냅.
- ❌ Y-sort 누락 → 앞 나무가 뒤 나무에 가려짐. ✅ 그리기 직전 정렬.
