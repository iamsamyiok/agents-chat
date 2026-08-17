// 图库渲染 + 点击详情弹窗

// 渲染全部猫咪卡片网格
function renderGallery() {
  const grid = document.getElementById("gallery-grid");
  if (!grid || typeof CATS === "undefined") return;
  grid.innerHTML = CATS
    .map((c, i) => `
      <div class="card" data-index="${i}">
        <img src="${c.image}" alt="${c.name}">
        <div class="body">
          <h3>${c.name}</h3>
          <p>${c.intro}</p>
        </div>
      </div>`)
    .join("");

  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(parseInt(card.dataset.index, 10)));
  });
}

// 打开详情弹窗
function openModal(index) {
  const c = CATS[index];
  const overlay = document.getElementById("modal-overlay");
  if (!c || !overlay) return;
  overlay.querySelector(".modal-body").innerHTML = `
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <img src="${c.image}" alt="${c.name}">
    <div class="modal-body-inner">
      <h3>${c.name}</h3>
      <p>${c.intro}</p>
      <div class="fun"><strong>🐾 趣味点：</strong>${c.fun}</div>
    </div>`;
  overlay.classList.add("show");
}

function closeModal() {
  const overlay = document.getElementById("modal-overlay");
  if (overlay) overlay.classList.remove("show");
}

document.addEventListener("DOMContentLoaded", function () {
  // 导航渲染（与各页面一致）
  const nav = document.querySelector(".nav-links");
  if (nav) {
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

  renderGallery();

  // 点击遮罩空白处关闭弹窗
  const overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });
  }
});
