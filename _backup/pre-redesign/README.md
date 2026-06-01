# UI 백업 (리디자인 전)

날짜: 2026-06-01

## 되돌리기

PowerShell에서 프로젝트 폴더(`채팅`)로 이동 후:

```powershell
Copy-Item "_backup\pre-redesign\student.css" "public\css\student.css" -Force
Copy-Item "_backup\pre-redesign\teacher.css" "public\css\teacher.css" -Force
Copy-Item "_backup\pre-redesign\login.css" "public\css\login.css" -Force
Copy-Item "_backup\pre-redesign\student.html" "public\student.html" -Force
Copy-Item "_backup\pre-redesign\teacher.html" "views\teacher.html" -Force
Copy-Item "_backup\pre-redesign\login.html" "public\login.html" -Force
```

손들기 기능만 유지하려면 CSS/HTML만 되돌리고 `server.js`, `student.js`, `teacher.js`는 그대로 두면 됩니다.
