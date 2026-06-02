/** 교실 도구함 iframe 안에서 실행될 때 body 여백용 클래스 */
(function () {
  try {
    if (window.parent !== window) {
      document.documentElement.classList.add("hub-embedded");
    }
  } catch {
    document.documentElement.classList.add("hub-embedded");
  }
})();
