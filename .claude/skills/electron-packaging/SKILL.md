---
name: electron-packaging
description: Electron 앱을 윈도우(nsis/portable)·맥(dmg/zip) 설치본으로 패키징하는 방법. electron-builder 설정(appId·files·target·arch), 코드 서명 없이 빌드(mac identity:null), 아이콘, npm dist scripts, asar 와 쓰기 자원 unpack 을 다룬다. "윈도우 앱 빌드", "맥 앱 빌드", "dmg 만들기", "electron-builder 설정", "패키징", 배포본 생성 작업 시 반드시 사용. 타겟 추가·빌드 설정 수정 후속 작업에도 사용.
---

# Electron 패키징 (win + mac)

electron-builder 로 win/mac 설치본을 만든다. 전제: **코드 서명 없이**(개인/사내), **로컬에서 각 OS 직접 빌드**, **자동 업데이트 제외**. 이 전제가 설정을 크게 단순화한다.

## 왜 electron-builder 인가

win nsis 설치본 + mac dmg 를 **한 설정 블록**으로 다룬다(electron-forge 보다 다중 타겟이 간결). devDependency 로만 들어간다.

```
npm i -D electron electron-builder
```

`electron` 은 앱 런타임, `electron-builder` 는 패키징 도구.

## package.json 설정

`"type": "module"` 프로젝트이므로 `"main": "main.js"` 를 추가하고 `build` 블록을 둔다.

```jsonc
{
  "main": "main.js",
  "scripts": {
    "pack": "electron-builder --dir",        // 서명·압축 없이 빠른 디렉토리 빌드(검증용)
    "dist": "electron-builder",              // 현재 OS 설치본
    "dist:mac": "electron-builder --mac",
    "dist:win": "electron-builder --win"
  },
  "build": {
    "appId": "com.example.claudeforest",     // 역도메인(실제 값으로 교체)
    "productName": "Claude Code Forest",
    "files": [
      "main.js", "preload.js",
      "server/**/*", "public/**/*",
      "package.json"
    ],
    "extraResources": [],                     // 필요 시 mock/ 등
    "asar": true,
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.developer-tools",
      "identity": null,                       // ad-hoc 서명 — 인증서 불필요
      "hardenedRuntime": false
    },
    "win": {
      "target": ["nsis"]                      // 무설치 필요 시 "portable" 추가
    },
    "directories": { "buildResources": "build", "output": "dist" }
  }
}
```

### 핵심 결정 근거

- **`identity: null`**(mac): 인증서 없이 ad-hoc 서명으로 빌드한다. 사용자는 첫 실행 시 우클릭 → 열기 로 Gatekeeper 를 우회한다. 서명·공증을 켜면 Apple Developer 계정을 요구해 빌드가 막힌다(확정 제외).
- **`files`**: 앱에 들어갈 것만. `data/`·`dist/`·`_workspace/`·`.git/` 는 자동/명시 제외. `node_modules` 의 런타임 의존은 builder 가 알아서 넣는다(이 프로젝트는 서버가 표준 라이브러리만 써서 런타임 의존이 거의 없음).
- **arch**: 생략하면 빌드 머신 arch(이 머신은 arm64). x64 mac 도 지원하려면 `"mac": { "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }] }` 또는 `universal`. 사내 배포 대상 칩을 확인하고 정한다.

## asar 와 쓰기/읽기 자원

- **쓰기**: 앱은 `data/` 에 쓴다. 이건 패키징 경로가 아니라 **런타임 userData 경로**여야 한다(electron-app-integration 의 asar 함정 참조). 패키징 설정이 아니라 메인 프로세스가 푸는 문제 — integrator 가 했는지 확인하고, 안 됐으면 통지한다.
- **읽기**: `mock/`·스프라이트 PNG 등은 asar 안에서 `readFile` 로 읽힌다(Electron 이 asar 읽기를 투명 처리). 단 **자식 프로세스·네이티브 모듈이 실제 파일 경로를 요구**하면 `asarUnpack` 으로 푼다. 이 앱은 메인 스레드 `readFile` 라 보통 unpack 불필요 — 검증에서 읽기 실패가 나오면 그때 `asarUnpack` 추가.

## 아이콘

- `build/icon.icns`(mac), `build/icon.ico`(win). 소스는 `build/icon.png`(512×512 이상) 하나면 builder 가 변환하기도 하나, 안전하게 플랫폼별 파일을 둔다.
- **사용자가 아이콘을 안 주면**: electron 기본 아이콘으로 빌드하고 "아이콘 미제공 — `build/` 에 넣으면 자동 적용" 을 보고한다. 아이콘을 임의 생성하지 않는다(디자인은 사용자 몫).

## win 빌드는 어디서

확정: **로컬에서 각 OS 직접**. 이 mac 에서 `dist:mac` 은 네이티브로 된다. `dist:win`(nsis) 은 mac 에서 추가 도구(wine 등)를 요구하고 불안정 — **윈도우 머신에서 `npm run dist:win`** 이 정석이다. mac 에서 win 빌드 시도가 막히면 정상이며, "win 은 윈도우 PC 에서" 로 보고한다.

## 검증 연결

- `npm run pack`(--dir) 으로 빠르게 앱 디렉토리를 만들어 build-verifier 가 실행·구동 확인.
- 그다음 `npm run dist:mac` 으로 dmg/zip 산출 확인.
- `.gitignore` 에 `dist/`·`node_modules/` 가 있는지 확인(빌드 산출물 커밋 방지).

## 안티패턴

- 서명·공증·electron-updater 를 "혹시 몰라" 미리 설정 → 빌드가 인증서·피드 서버를 요구해 막힌다. 확정 전제(제외)를 지킨다.
- `files` 에 `**/*` 통째로 → asar 가 비대해지고 `data/`·`.git` 까지 들어간다. 필요한 것만 명시.
- 빌드 머신과 다른 arch 를 검증 없이 단정 → 대상 칩(arm64/x64)을 확인하고 arch 를 정한다.
