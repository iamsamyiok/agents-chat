// 渲染首页宠物卡片 + 筛选/搜索 + 详情弹窗（纯前端，使用模拟数据）

let currentType = "全部";
let currentKeyword = "";

const grid = document.getElementById("grid");
const searchInput = document.getElementById("search");
const filterBox = document.getElementById("filters");

// 生成类型筛选按钮
function renderFilters() {
  const types = ["全部", ...new Set(PETS.map(p => p.type))];
  filterBox.innerHTML = types
    .map(t => `<button data-type="${t}" class="${t === currentType ? "active" : ""}">${t}</button>`)
    .join("");
  filterBox.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      currentType = btn.dataset.type;
      renderFilters();
      renderGrid();
    });
  });
}

// 过滤数据
function getFiltered() {
  return PETS.filter(p => {
    const matchType = currentType === "全部" || p.type === currentType;
    const kw = currentKeyword.trim().toLowerCase();
    const matchKw =
      !kw ||
      p.name.toLowerCase().includes(kw) ||
      p.breed.toLowerCase().includes(kw) ||
      p.location.toLowerCase().includes(kw);
    return matchType && matchKw;
  });
}

// 渲染卡片
function renderGrid() {
  const list = getFiltered();
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty">😿 没有找到匹配的宠物，换个条件试试吧～</div>`;
    return;
  }
  grid.innerHTML = list
    .map(p => `
      <div class="card" data-id="${p.id}">
        <div class="avatar">${p.image}</div>
        <div class="body">
          <div class="top">
            <h3>${p.name}</h3>
            <span class="price">¥${p.price}</span>
          </div>
          <div class="meta">${p.breed} · ${p.age}岁 · ${p.gender} · ${p.location}</div>
          <div class="tags">${p.character.map(c => `<span>${c}</span>`).join("")}</div>
        </div>
      </div>`)
    .join("");

  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openDetail(Number(card.dataset.id)));
  });
}

// 打开详情弹窗
function openDetail(id) {
  const p = PETS.find(x => x.id === id);
  if (!p) return;
  const mask = document.getElementById("modal");
  mask.querySelector(".avatar").textContent = p.image;
  mask.querySelector("#d-name").textContent = p.name;
  mask.querySelector("#d-price").textContent = "¥" + p.price;
  mask.querySelector("#d-info").innerHTML = `
    <div><span class="label">品种：</span>${p.breed}</div>
    <div><span class="label">年龄：</span>${p.age} 岁</div>
    <div><span class="label">性别：</span>${p.gender}</div>
    <div><span class="label">所在地：</span>${p.location}</div>
    <div><span class="label">已疫苗：</span>${p.vaccinated ? "是 ✅" : "否"}</div>
    <div><span class="label">已绝育：</span>${p.neutered ? "是 ✅" : "否"}</div>`;
  mask.querySelector("#d-desc").textContent = p.desc;
  mask.querySelector("#d-tags").innerHTML = p.character.map(c => `<span>${c}</span>`).join("");
  mask.classList.add("show");
}

function closeDetail() {
  document.getElementById("modal").classList.remove("show");
}

// 事件绑定
searchInput.addEventListener("input", e => {
  currentKeyword = e.target.value;
  renderGrid();
});
document.getElementById("modal-close").addEventListener("click", closeDetail);
document.getElementById("modal-mask").addEventListener("click", e => {
  if (e.target.id === "modal-mask") closeDetail();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDetail();
});
document.getElementById("adopt-btn").addEventListener("click", () => {
  alert("🎉 感谢你的爱心！这是演示网站，领养功能为模拟，请联系当地宠物救助机构。");
});

// 初始化
renderFilters();
renderGrid();
