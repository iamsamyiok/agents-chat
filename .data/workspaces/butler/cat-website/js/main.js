// 首页 / 通用交互逻辑

// 渲染导航（保持各页面一致，active 根据当前页高亮）
function renderNav() {
  const nav = document.querySelector(".nav-links");
  if (!nav) return;
  const page = document.body.dataset.page;
  const links = [
    { href: "index.html", label: "首页" },
    { href: "gallery.html", label: "图库" },
    { href: "about.html", label: "关于" }
  ];
  nav.innerHTML = links
    .map(l => `<a href="${l.href}" class="${l.href === page ? "active" : ""}">${l.label}</a>`)
    .join("");
}

// 渲染首页精选卡片（取前 3 只猫咪）
function renderFeatured() {
  const wrap = document.getElementById("featured");
  if (!wrap || typeof CATS === "undefined") return;
  const featured = CATS.slice(0, 3);
  wrap.innerHTML = featured
    .map(c => `
      <div class="card" onclick="location.href='gallery.html'">
        <img src="${c.image}" alt="${c.name}">
        <div class="body">
          <h3>${c.name}</h3>
          <p>${c.intro}</p>
        </div>
      </div>`)
    .join("");
}

document.addEventListener("DOMContentLoaded", function () {
  renderNav();
  renderFeatured();
});
