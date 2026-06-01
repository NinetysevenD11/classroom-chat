const LOGIN_BACKGROUNDS = [
  { url: "/images/login-bg-chalk-landscape.png", theme: "dark" },
  { url: "/images/login-bg-frame-color.png", theme: "light" },
  { url: "/images/login-bg-stem-blue.png", theme: "light" },
  { url: "/images/login-bg-pastel-grid.png", theme: "light" },
  { url: "/images/login-bg-stickers.png", theme: "light" },
  { url: "/images/login-bg-doodle-light.png", theme: "light" },
  { url: "/images/login-bg-doodle-dark.png", theme: "dark" },
];

(function pickLoginBackground() {
  const picked = LOGIN_BACKGROUNDS[Math.floor(Math.random() * LOGIN_BACKGROUNDS.length)];
  document.body.style.backgroundImage = `url("${picked.url}")`;
  document.body.classList.add(picked.theme === "dark" ? "bg-dark" : "bg-light");
})();

const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const submitBtn = document.getElementById("submitBtn");
const authForm = document.getElementById("authForm");
const idInput = document.getElementById("idInput");
const pwInput = document.getElementById("pwInput");
const msg = document.getElementById("msg");

let mode = "login"; // "login" | "signup"

function setMode(m) {
  mode = m;
  tabLogin.classList.toggle("active", m === "login");
  tabSignup.classList.toggle("active", m === "signup");
  submitBtn.textContent = m === "login" ? "로그인" : "회원가입";
  pwInput.setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
  msg.textContent = "";
}

tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = idInput.value.trim();
  const password = pwInput.value;
  if (!id || !password) {
    showMsg("아이디와 비밀번호를 입력하세요.", true);
    return;
  }
  submitBtn.disabled = true;
  try {
    const res = await fetch(mode === "login" ? "/api/login" : "/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });
    const data = await res.json();
    if (!data.ok) {
      showMsg(data.error || "실패했습니다.", true);
      submitBtn.disabled = false;
      return;
    }
    showMsg(mode === "login" ? "로그인 성공!" : "가입 완료!", false);
    window.location.href = "/";
  } catch (err) {
    showMsg("서버에 연결할 수 없습니다.", true);
    submitBtn.disabled = false;
  }
});

function showMsg(text, isError) {
  msg.textContent = text;
  msg.className = "msg " + (isError ? "error" : "ok");
}

setMode("login");
