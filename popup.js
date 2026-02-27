document.addEventListener("DOMContentLoaded", () => {
  const togglePricemode = document.getElementById("togglePricemode");
  const labelPricemode = document.getElementById("labelPricemode");
  
  const toggleAdblock = document.getElementById("toggleAdblock");
  const labelAdblock = document.getElementById("labelAdblock");

  const defaultSettings = {
    showTotalFixedPrice: true,
    enableAdblock: true
  };

  // 스토리지에서 현재 설정 불러오기
  chrome.storage.local.get(defaultSettings, (settings) => {
    togglePricemode.checked = settings.showTotalFixedPrice;
    toggleAdblock.checked = settings.enableAdblock;
    updateLabels();
  });

  // 토글 이벤트 리스너
  togglePricemode.addEventListener("change", () => {
    chrome.storage.local.set({ showTotalFixedPrice: togglePricemode.checked });
    updateLabels();
  });

  toggleAdblock.addEventListener("change", () => {
    chrome.storage.local.set({ enableAdblock: toggleAdblock.checked });
    updateLabels();
  });

  // UI 라벨 텍스트 및 스타일 갱신
  function updateLabels() {
    if (togglePricemode.checked) {
      labelPricemode.textContent = "배송비 포함 가격 표시";
      labelPricemode.classList.add("active");
    } else {
      labelPricemode.textContent = "배송비 가격만 표시";
      labelPricemode.classList.remove("active");
    }

    if (toggleAdblock.checked) {
      labelAdblock.textContent = "광고 카드 숨김";
      labelAdblock.classList.add("active");
    } else {
      labelAdblock.textContent = "광고 카드 표시";
      labelAdblock.classList.remove("active");
    }
  }
});
