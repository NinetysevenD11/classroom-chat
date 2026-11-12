/** Original OX doodle avatars — no third-party character IPs */
window.OX_AVATAR_COUNT = 32;

window.oxAvatarUrl = function oxAvatarUrl(id) {
  const n = Number(id);
  const safe = Number.isInteger(n) && n >= 0 && n < window.OX_AVATAR_COUNT ? n : 0;
  return `/ox-avatars/${safe}.svg`;
};

window.oxAvatarImg = function oxAvatarImg(id, className = "ox-avatar") {
  const img = document.createElement("img");
  img.src = window.oxAvatarUrl(id);
  img.alt = "";
  img.className = className;
  img.draggable = false;
  img.width = 96;
  img.height = 96;
  return img;
};

window.oxPlayerTile = function oxPlayerTile(player, opts = {}) {
  const tile = document.createElement("div");
  tile.className = "ox-char-tile" + (player.online === false ? " is-offline" : "") + (opts.mine ? " is-mine" : "");
  tile.appendChild(window.oxAvatarImg(player.avatarId, "ox-avatar"));
  const name = document.createElement("div");
  name.className = "ox-char-name";
  name.textContent = player.nickname || "—";
  tile.appendChild(name);
  const meta = document.createElement("div");
  meta.className = "ox-char-meta";
  const bits = [];
  if (player.score != null) bits.push(`${player.score}점`);
  if (player.submitted) bits.push("제출");
  if (player.online === false) bits.push("나감");
  meta.textContent = bits.join(" · ");
  tile.appendChild(meta);
  return tile;
};
