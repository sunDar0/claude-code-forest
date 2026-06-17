// Claude Code Forest — Electron preload.
//
// 보안 기본값 유지용 최소 preload. 클라(public/)는 fetch 로 localhost API 만
// 호출하므로 IPC 노출이 필요 없다 — contextIsolation:true · nodeIntegration:false
// 아래에서 렌더러는 일반 브라우저처럼 동작한다.
//
// 추후 네이티브 기능(파일 저장 다이얼로그·앱 버전 표시 등)이 필요하면
// 여기서 contextBridge.exposeInMainWorld 로 좁게(필요한 메서드만) 노출한다.
